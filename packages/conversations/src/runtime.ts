import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ConversationEngine } from "./engine";
import { CodexProcessRunner, type CodexConversationProcessRequest, type CodexConversationProcessResult, type CodexProcessError, type CodexProcessRequest, type CodexProcessResult, type Executor } from "./executor";

export { CodexProcessRunner } from "./executor";
export type {
  CodexConversationProcessRequest,
  CodexConversationProcessResult,
  CodexProcessError,
  CodexProcessRequest,
  CodexProcessResult,
  Executor,
  ExecutorSessions
} from "./executor";
import { ContextBudgetExceededError } from "./types";
import { ProductionTokenCounter, type ModelTokenizer, type TokenCounter } from "./context-budget-counter";
import type {
  BoundedConversationContext,
  ConversationContext,
  CommunicationChannel,
  JsonObject,
  OutboundDelivery,
  OutboundDeliveryAssistantMessage,
  TaskChannel,
  TaskLedgerAssistantMessageInput,
  TaskLedgerConversation,
  TaskLedgerMessage,
  ConversationRunLease,
  TaskLedgerRun,
  TaskLedgerStartedRun
} from "./types";

export interface ConversationRuntimeControlDelivery {
  channel: CommunicationChannel;
  conversationKey: string;
  provider: string;
  idempotencyKey: string;
  payload: JsonObject;
  assistantMessage: OutboundDeliveryAssistantMessage;
  deliver(delivery: OutboundDelivery): Promise<JsonObject>;
  reconcileDelivery(delivery: OutboundDelivery): Promise<JsonObject | null>;
}








export interface ConversationRuntimeExecutionInput {
  started: TaskLedgerStartedRun;
  messages: TaskLedgerMessage[];
  context: BoundedConversationContext | null;
  /**
   * Fully constructed by ConversationRuntime. A transport may submit this to
   * its model executor, but must not rebuild it from the surrounding fields.
   * It is null only for legacy transports that have not supplied instructions.
   */
  prompt: string | null;
  /** Deployment context for a run resumed after a checkpoint, or null. */
  updateNotice: string | null;
  /** Token budget already reserved for runtime-owned resume and deployment inputs. */
  runtimeInputTokens: number;
}

export interface ConversationRuntimePromptInput {
  conversationKey: string;
  context: ConversationContext | BoundedConversationContext | null;
  updateNotice: string | null;
  reminderInstruction?: string;
  /** Runtime-owned memory, loaded once and budgeted before prompt serialization. */
  memoryContext?: string | null;
}

export interface ConversationRuntimeCompactionInput {
  channel: TaskChannel;
  conversationKey: string;
  maxContextTokens: number;
  summaryMaxChars: number;
  /** Receives the runtime-built compaction prompt and returns provider output. */
  createSummary: (previousSummary: string | null, messages: TaskLedgerMessage[], prompt: string) => Promise<string>;
}

export interface ConversationRuntimeTransport<TTarget, TDecision> {
  channel: CommunicationChannel;
  provider: string;
  maxContextTokens: number;
  summaryMaxChars: number;
  /** Provider presentation facts. ConversationRuntime owns their placement
   * beside the shared system prompt, task, memory, and bounded context. */
  providerInstructions?: string[] | ((started: TaskLedgerStartedRun) => string[]);
  /** Fixed non-conversation prompt capacity reserved before bounded context is selected. */
  runtimePromptReservedTokens?: number;
  prepare(started: TaskLedgerStartedRun): Promise<TTarget>;
  /**
   * Execute the compaction model call using the runtime-built prompt. The
   * provider adapter may choose its model command and response parsing only.
   */
  createSummary(previousSummary: string | null, messages: TaskLedgerMessage[], prompt: string): Promise<string>;
  generate(input: ConversationRuntimeExecutionInput): Promise<TDecision>;
  shouldDeliver(decision: TDecision): boolean;
  assistantMessage(decision: TDecision, target: TTarget, started: TaskLedgerStartedRun): TaskLedgerAssistantMessageInput;
  deliveryPayload(decision: TDecision, target: TTarget, started: TaskLedgerStartedRun): JsonObject;
  reconcileDelivery(delivery: OutboundDelivery, started: TaskLedgerStartedRun): Promise<JsonObject | null>;
  deliver(delivery: OutboundDelivery, started: TaskLedgerStartedRun): Promise<JsonObject>;
  skipped(decision: TDecision, target: TTarget, started: TaskLedgerStartedRun): Promise<void>;
  failed(error: unknown, target: TTarget | null, started: TaskLedgerStartedRun): Promise<void>;
  stopped?(error: unknown): boolean;
  /** Keep a persisted delivery pending so its idempotency key can be retried. */
  retainPendingDeliveryOnFailure?: boolean;
}

/** Run error recorded when a deployment drain checkpoints a run at a turn boundary. */
export const DEPLOYMENT_CHECKPOINT_REASON = "checkpointed_for_deployment";

/** Thrown at a safe turn boundary when the deployer has requested a drain. */
export class RunCheckpointedError extends Error {
  constructor(message = "run checkpointed at a deployment drain boundary") {
    super(message);
    this.name = "RunCheckpointedError";
  }
}

export interface ConversationRuntimeOptions {
  /** Builds the notice injected into the first turn of a run resumed after a
   *  deployment checkpoint or restart. Receives the prior run's finish time. */
  updateNotice?: (checkpointedAt: string | null) => string | null;
  /** Optional shared memory provider. Adapters configure it but never load it during a run. */
  loadMemoryContext?: () => Promise<string | null>;
  /** Maximum token allocation for runtime-owned memory. Zero disables memory injection. */
  maxMemoryContextTokens?: number;
  /** Configured execution model, used when a tokenizer is supplied. */
  model?: string;
  /** Optional exact tokenizer for the configured execution model. */
  modelTokenizer?: ModelTokenizer;
  /**
   * Explicit counter injection for tests or a provider-integrated tokenizer.
   * ConversationRuntime is the sole production consumer of this interface.
   */
  tokenCounter?: TokenCounter;
  /** Minimum reconciliation window after an ambiguous provider call. */
  acceptanceUnknownRetryDelayMs?: number;
  /** Provider deployment policy: a rejected call cannot be inferred from a transport error. */
  deliveryErrorsMayBeAmbiguous?: boolean;
  /** Injectable clock for deterministic delivery-recovery tests. */
  now?: () => Date;
  /** Stable identity for this runtime process or container instance. */
  workerInstanceId?: string;
  /** Durable lease lifetime for a normal conversation run. */
  runLeaseDurationMs?: number;
  /** Interval at which the runtime durably renews active run leases. */
  runLeaseHeartbeatMs?: number;
}

const defaultRunLeaseDurationMs = 60_000;
const defaultRunLeaseHeartbeatMs = 15_000;

class RunLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

/** The provider accepted delivery, but the process stopped before durable confirmation. */
export class DeliveryInterruptedError extends Error {
  constructor(message = "provider accepted delivery before runtime confirmation") {
    super(message);
    this.name = "DeliveryInterruptedError";
  }
}

/**
 * Shared run scheduler and steering coordinator. Channel adapters provide only
 * their prompt/result policy and transport delivery around this lifecycle.
 */
export class ConversationRuntime {
  private readonly tokenCounter: TokenCounter;
  private readonly acceptanceUnknownRetryDelayMs: number;
  private readonly workerInstanceId: string;
  private readonly runLeaseDurationMs: number;
  private readonly runLeaseHeartbeatMs: number;

  constructor(
    private readonly engine: ConversationEngine,
    private readonly codexRunner: Executor = new CodexProcessRunner(),
    private readonly options: ConversationRuntimeOptions = {}
  ) {
    this.tokenCounter = options.tokenCounter ?? new ProductionTokenCounter({
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.modelTokenizer === undefined ? {} : { tokenizer: options.modelTokenizer })
    });
    this.acceptanceUnknownRetryDelayMs = positiveInteger(
      options.acceptanceUnknownRetryDelayMs,
      defaultAcceptanceUnknownRetryDelayMs
    );
    this.workerInstanceId = options.workerInstanceId?.trim() || randomUUID();
    this.runLeaseDurationMs = positiveInteger(options.runLeaseDurationMs, defaultRunLeaseDurationMs);
    this.runLeaseHeartbeatMs = positiveInteger(options.runLeaseHeartbeatMs, defaultRunLeaseHeartbeatMs);
    if (this.runLeaseHeartbeatMs >= this.runLeaseDurationMs) {
      throw new Error("run lease heartbeat interval must be shorter than the lease duration");
    }
  }

  /** Execute a model process through the shared runtime-owned process manager. */
  async runCodex(request: CodexProcessRequest): Promise<CodexProcessResult> {
    return this.codexRunner.run(request);
  }

  /**
   * Run a normal conversation continuation. The executor owns thread
   * resumption, JSON event decoding, and durable session persistence.
   */
  async runCodexConversation(
    input: CodexConversationProcessRequest
  ): Promise<CodexConversationProcessResult> {
    return this.codexRunner.runConversation(input, {
      getSession: async (channel, conversationKey) =>
        (await this.engine.getCodexSession(channel, conversationKey))?.codexSessionId ?? null,
      saveSession: (channel, conversationKey, sessionId) =>
        this.engine.saveCodexSession(channel, conversationKey, sessionId).then(() => undefined)
    });
  }

  /** Stop the active model process for a durable conversation run. */
  cancelCodexRun(runKey: string): boolean {
    return this.codexRunner.cancel(runKey);
  }

  isCodexRunActive(runKey: string): boolean {
    return this.codexRunner.isActive(runKey);
  }

  get activeCodexRunCount(): number {
    return this.codexRunner.activeCount;
  }

  /** The one shared serializer for runtime-owned model context. */
  buildPrompt(instructions: string[], input: ConversationRuntimePromptInput): string {
    return buildConversationRuntimePrompt(instructions, input);
  }

  /** The shared compaction serializer prevents channel-specific checkpoint prompts. */
  buildCompactionPrompt(previousSummary: string | null, messages: TaskLedgerMessage[]): string {
    return buildConversationCompactionPrompt(previousSummary, messages);
  }

  /**
   * Build the complete model prompt from runtime-owned bounded context and
   * memory. The reservation returned by promptReservationTokens must be
   * supplied to the transport so context selection accounts for this input.
   */
  async buildExecutionPrompt(
    instructions: string[],
    input: ConversationRuntimePromptInput,
    maxTokens: number
  ): Promise<string> {
    const memoryContext = await this.loadBoundedMemoryContext();
    const prompt = this.buildPrompt(instructions, { ...input, memoryContext });
    const tokenCount = this.tokenCounter.count(prompt);
    if (tokenCount > maxTokens) {
      throw new ContextBudgetExceededError(
        `Runtime prompt requires ${tokenCount} tokens, exceeding the ${maxTokens} token budget`
      );
    }
    return prompt;
  }

  /** Fixed prompt and maximum memory capacity reserved before conversation context is built. */
  promptReservationTokens(instructions: string[]): number {
    return this.tokenCounter.count(instructions.join("\n"))
      + (this.options.maxMemoryContextTokens ?? 0)
      + 96;
  }

  /**
   * Recover interrupted work. `reclaimOwnLeases` must be true only at process
   * startup, before this runtime has started any run: it lets a restarted
   * worker with a stable identity reclaim its own crashed runs immediately
   * instead of stranding them until the lease expires. Periodic recovery
   * passes false so a live run owned by this process is never interrupted.
   */
  async recover(channel: TaskChannel, options: { reclaimOwnLeases?: boolean } = {}) {
    if (isCommunicationChannel(channel)) {
      // A provider acceptance survives a crash between the provider response
      // and local confirmation. It is never sent again; finish its local
      // transaction before ordinary recovery considers runnable work.
      for (const conversation of await this.engine.conversations(channel)) {
        for (const delivery of await this.engine.outboundDeliveries(channel, conversation.conversationKey)) {
          if (delivery.status !== "provider_accepted" || delivery.providerReceipt == null) continue;
          await this.engine.confirmOutboundDelivery({
            deliveryId: delivery.id,
            runId: delivery.runId,
            providerReceipt: delivery.providerReceipt
          });
        }
      }
    }
    return this.engine.recover(
      channel,
      options.reclaimOwnLeases ? this.workerInstanceId : undefined
    );
  }

  async startRun(channel: TaskChannel, conversationKey: string): Promise<TaskLedgerStartedRun | null> {
    const started = await this.engine.startRun(channel, conversationKey, {
      workerInstanceId: this.workerInstanceId,
      leaseDurationMs: this.runLeaseDurationMs
    });
    if (!started) return null;
    const lease = leaseFromRun(started.run);
    if (!lease) throw new Error(`Started run ${started.run.id} has no durable lease`);
    return started;
  }

  /** Deliver a deterministic conversation-visible control reply through the same durable state machine as model output. */
  async deliverControlReply(input: ConversationRuntimeControlDelivery): Promise<boolean> {
    const delivery = await this.engine.createControlOutboundDelivery({
      channel: input.channel, conversationKey: input.conversationKey, provider: input.provider,
      idempotencyKey: input.idempotencyKey, payload: input.payload,
      assistantMessage: input.assistantMessage
    });
    return this.dispatchControlReply(input, delivery);
  }

  /** Recovery is transport-agnostic: adapters provide only provider send and lookup operations. */
  async recoverControlReplies(
    channel: CommunicationChannel,
    handlers: Pick<ConversationRuntimeControlDelivery, "deliver" | "reconcileDelivery">
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const delivery of await this.engine.recoverableControlOutboundDeliveries(channel)) {
      results.push(await this.dispatchControlReply({
        channel, conversationKey: delivery.conversationKey, provider: delivery.provider,
        idempotencyKey: delivery.idempotencyKey, payload: delivery.payload,
        assistantMessage: delivery.assistantMessage, ...handlers
      }, delivery));
    }
    return results;
  }

  private async dispatchControlReply(input: ConversationRuntimeControlDelivery, initial: OutboundDelivery): Promise<boolean> {
    let delivery = initial;
    let providerEffectKnown = false;
    try {
      const reconciled = await input.reconcileDelivery(delivery);
      if (reconciled) {
        providerEffectKnown = true;
        await this.engine.confirmOutboundDelivery({ deliveryId: delivery.id, runId: delivery.runId, providerReceipt: reconciled });
        return true;
      }
      if (delivery.status === "acceptance_unknown" && !this.acceptanceUnknownRetryIsDue(delivery)) return false;
      if (delivery.status !== "pending") delivery = await this.engine.startOutboundDeliveryAttempt(delivery.id);
      delivery = await this.engine.beginOutboundDeliveryDispatch(delivery.id, delivery.runId);
      const receipt = await this.engine.withDeliveryDispatchGate(input.channel, input.conversationKey, async () => {
        await this.engine.assertOutboundDeliveryDispatchable(delivery.id, delivery.runId);
        return input.deliver(delivery);
      });
      providerEffectKnown = true;
      delivery = await this.engine.markOutboundDeliveryProviderAccepted(delivery.id, delivery.runId, receipt);
      await this.engine.confirmOutboundDelivery({ deliveryId: delivery.id, runId: delivery.runId, providerReceipt: receipt });
      return true;
    } catch (error) {
      // A second worker may observe the same durable control delivery before
      // the first worker has finished it. The ledger is the dispatch fence:
      // if it now records a newer in-flight state, this worker must leave it
      // alone rather than converting the other worker's dispatch into a
      // retryable failure.
      const persisted = (await this.engine.outboundDeliveries(input.channel, input.conversationKey))
        .find((candidate) => candidate.id === delivery.id);
      if (persisted && persisted.status !== delivery.status) {
        if (persisted.status === "delivered") return true;
        if (persisted.status === "dispatching" || persisted.status === "acceptance_unknown" || persisted.status === "provider_accepted") return false;
        delivery = persisted;
      }
      if (!providerEffectKnown && this.options.deliveryErrorsMayBeAmbiguous === true && (delivery.status === "dispatching" || delivery.status === "acceptance_unknown")) {
        await this.engine.markOutboundDeliveryAcceptanceUnknown(delivery.id, errorMessage(error));
        return false;
      }
      // Once reconciliation or send has established that the provider may have
      // accepted the reply, a local persistence failure must remain recoverable
      // rather than being misclassified as a provider rejection.
      if (!providerEffectKnown && (delivery.status === "pending" || delivery.status === "dispatching" || delivery.status === "acceptance_unknown")) {
        await this.engine.failOutboundDelivery(delivery.id, errorMessage(error));
        return false;
      }
      throw error;
    }
  }

  async finishRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    status: Exclude<TaskLedgerRun["status"], "running">,
    error: string | null = null
  ) {
    return this.engine.finishRun(channel, conversationKey, runId, status, error);
  }

  async claimSteeringMessages(channel: TaskChannel, conversationKey: string, runId: string): Promise<TaskLedgerMessage[]> {
    return this.engine.claimSteeringMessages(channel, conversationKey, runId);
  }

  async getConversation(channel: TaskChannel, conversationKey: string): Promise<TaskLedgerConversation | null> {
    return this.engine.getConversation(channel, conversationKey);
  }

  async runnableConversations(channel: TaskChannel): Promise<TaskLedgerConversation[]> {
    return this.engine.runnableConversations(channel);
  }

  async snapshot(channel: TaskChannel) {
    return this.engine.snapshot(channel);
  }

  async migrateConversationKey(channel: TaskChannel, legacyKey: string, canonicalKey: string): Promise<void> {
    await this.engine.migrateConversationKey(channel, legacyKey, canonicalKey);
  }

  /** Run every durable lifecycle step once. The transport only formats and delivers. */
  async processTransport<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    limit: number
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    const runnable = await this.runnableConversations(transport.channel);
    for (const conversation of runnable.slice(0, limit)) {
      const started = await this.startRun(transport.channel, conversation.conversationKey);
      if (started) results.push(await this.runTransport(transport, started));
    }
    return results;
  }

  async processConversation<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    conversationKey: string,
    maxRuns = 20
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    for (let index = 0; index < maxRuns; index += 1) {
      const started = await this.startRun(transport.channel, conversationKey);
      if (!started) return results;
      const completed = await this.runTransport(transport, started);
      results.push(completed);
      if (!completed) return results;
    }
    return results;
  }

  async runTransport<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    started: TaskLedgerStartedRun
  ): Promise<boolean> {
    const lease = leaseFromRun(started.run);
    if (!lease) return false;
    if (lease.workerInstanceId !== this.workerInstanceId) {
      return false;
    }
    return this.withRunLease(started, lease, () => this.runTransportOwned(transport, started, lease));
  }

  private async runTransportOwned<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    started: TaskLedgerStartedRun,
    lease: ConversationRunLease | null
  ): Promise<boolean> {
    let target: TTarget | null = null;
    let delivery: OutboundDelivery | null = null;
    let providerAccepted = false;
    try {
      if (lease) await this.assertLease(started, lease);
      const updateNotice = this.updateNoticeFor(started);
      const pending = await this.engine.recoverableOutboundDelivery(transport.channel, started.conversation.conversationKey);
      if (pending) {
        // Keep delivery recovery inside this try/catch. A resumed provider call
        // has the same release, failure, stop, and retry guarantees as a new
        // provider call, including when the provider throws after dispatch was
        // durably admitted.
        delivery = pending;
        return await this.resumePendingDelivery(transport, started, pending, lease);
      }
      target = await transport.prepare(started);
      const providerInstructions = resolveProviderInstructions(transport, started);
      const runtimePromptReservedTokens = transport.runtimePromptReservedTokens
        ?? this.promptReservationTokens(providerInstructions);
      const reminderInstruction = reminderInstructionFromMessages(started.messages);
      const contextCompactionBudget = this.availableConversationContextTokens(
        transport.maxContextTokens,
        updateNotice,
        reminderInstruction,
        runtimePromptReservedTokens
      );
      await this.compactIfNeeded({
        channel: transport.channel,
        conversationKey: started.conversation.conversationKey,
        maxContextTokens: contextCompactionBudget,
        summaryMaxChars: transport.summaryMaxChars,
        createSummary: transport.createSummary
      });
      const decision = await this.executeWithSteering(
        transport.channel,
        started,
        transport.generate,
        updateNotice,
        20,
        transport.maxContextTokens,
        runtimePromptReservedTokens,
        providerInstructions
      );
      if (!transport.shouldDeliver(decision)) {
        if (lease) await this.assertLease(started, lease);
        await transport.skipped(decision, target, started);
        await this.finishRun(transport.channel, started.conversation.conversationKey, started.run.id, "done", null);
        return true;
      }
      const active = await this.engine.getConversation(transport.channel, started.conversation.conversationKey);
      if (active?.activeRunId !== started.run.id || !active.runs.some((run) => run.id === started.run.id && run.status === "running")) {
        transport.stopped?.(stoppedBeforeDeliveryError());
        return false;
      }
      if (lease) await this.assertLease(started, lease);
      delivery = await this.engine.createOutboundDelivery({
        channel: transport.channel,
        conversationKey: started.conversation.conversationKey,
        runId: started.run.id,
        provider: transport.provider,
        idempotencyKey: randomUUID(),
        payload: transport.deliveryPayload(decision, target, started),
        assistantMessage: assistantCandidate(transport.assistantMessage(decision, target, started))
      });
      const dispatched = await this.dispatchDelivery(transport, started, delivery, lease);
      delivery = dispatched.delivery;
      providerAccepted = true;
      await this.engine.confirmOutboundDelivery({
        deliveryId: delivery.id,
        runId: started.run.id,
        providerReceipt: dispatched.receipt
      });
      return true;
    } catch (error) {
      if (isRunLeaseLostError(error)) return false;
      if (isRunCheckpointedError(error)) {
        await this.engine.checkpointRun(
          transport.channel,
          started.conversation.conversationKey,
          started.run.id,
          DEPLOYMENT_CHECKPOINT_REASON
        );
        return false;
      }
      if (isDeliveryAcceptanceUnknownError(error)) {
        await this.engine.checkpointRun(
          transport.channel,
          started.conversation.conversationKey,
          started.run.id,
          error.message
        );
        return false;
      }
      if (isDeliveryInterruptedError(error) || providerAccepted) throw error;
      if (delivery) {
        delivery = await this.engine.releaseOutboundDeliveryDispatch(delivery.id);
        if (delivery.status === "cancelled") return false;
      }
      if (transport.stopped?.(error)) return false;
      if (delivery && transport.retainPendingDeliveryOnFailure) {
        await transport.failed(error, target, started);
        return false;
      }
      if (delivery) await this.engine.failOutboundDelivery(delivery.id, errorMessage(error));
      const conversation = await this.engine.getConversation(transport.channel, started.conversation.conversationKey);
      if (conversation?.status === "stopped") return false;
      await this.finishRun(transport.channel, started.conversation.conversationKey, started.run.id, "failed", errorMessage(error));
      // Channel error reporting is observability, not lifecycle ownership. A
      // reporting failure must never leave this durable run active.
      await transport.failed(error, target, started);
      return false;
    }
  }

  /**
   * Resume only an already-persisted outbound delivery. It deliberately never
   * enters model execution when the delivery was settled by another process.
   */
  async resumePendingOutboundDelivery<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    started: TaskLedgerStartedRun
  ): Promise<boolean> {
    const pending = await this.engine.recoverableOutboundDelivery(transport.channel, started.conversation.conversationKey);
    if (!pending) return false;
    const lease = leaseFromRun(started.run);
    if (!lease) return false;
    if (lease.workerInstanceId !== this.workerInstanceId) return false;
    return this.withRunLease(started, lease, () => this.resumePendingDelivery(transport, started, pending, lease));
  }

  private async resumePendingDelivery<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    started: TaskLedgerStartedRun,
    pending: OutboundDelivery,
    lease: ConversationRunLease | null
  ): Promise<boolean> {
    let reconciled: JsonObject | null;
    try {
      reconciled = await transport.reconcileDelivery(pending, started);
    } catch (error) {
      if (pending.status === "dispatching" && this.options.deliveryErrorsMayBeAmbiguous === true) {
        await this.engine.markOutboundDeliveryAcceptanceUnknown(pending.id, errorMessage(error));
      }
      if (pending.status === "dispatching" || pending.status === "acceptance_unknown") {
        throw new DeliveryAcceptanceUnknownError(
          `provider delivery reconciliation is unavailable: ${errorMessage(error)}`
        );
      }
      throw error;
    }
    if (reconciled) {
      try {
        await this.engine.confirmOutboundDelivery({
          deliveryId: pending.id,
          runId: started.run.id,
          providerReceipt: reconciled
        });
      } catch (error) {
        // Reconciliation proves the provider effect already exists. Preserve
        // the durable intent for a later confirmation attempt instead of
        // treating that known effect as a failed delivery.
        throw new DeliveryInterruptedError(
          `provider delivery was reconciled before durable confirmation: ${errorMessage(error)}`
        );
      }
      return true;
    }
    let retrySource = pending;
    if (pending.status === "dispatching" && this.options.deliveryErrorsMayBeAmbiguous === true) {
      retrySource = await this.engine.markOutboundDeliveryAcceptanceUnknown(
        pending.id,
        "provider acceptance was not found during recovery"
      );
    }
    if (retrySource.status === "acceptance_unknown" && !this.acceptanceUnknownRetryIsDue(retrySource)) {
      throw new DeliveryAcceptanceUnknownError(
        `provider acceptance remains unknown; retry is deferred for ${this.acceptanceUnknownRetryDelayMs}ms`
      );
    }
    const retry = await this.engine.startOutboundDeliveryAttempt(retrySource.id);
    const dispatched = await this.dispatchDelivery(transport, started, retry, lease);
    await this.engine.confirmOutboundDelivery({
      deliveryId: dispatched.delivery.id,
      runId: started.run.id,
      providerReceipt: dispatched.receipt
    });
    return true;
  }

  /**
   * `dispatching` is deliberately revocable. The provider call begins only
   * after the engine's stop fence has checked that admission still belongs to
   * this active run. A successful provider effect is persisted before the gate
   * is released, so a later stop cannot cancel or replay a known send.
   */
  private async dispatchDelivery<TTarget, TDecision>(
    transport: ConversationRuntimeTransport<TTarget, TDecision>,
    started: TaskLedgerStartedRun,
    delivery: OutboundDelivery,
    lease: ConversationRunLease | null
  ): Promise<{ delivery: OutboundDelivery; receipt: JsonObject }> {
    if (lease) await this.assertLease(started, lease);
    const dispatch = await this.engine.beginOutboundDeliveryDispatch(delivery.id, started.run.id, lease ?? undefined);
    return this.engine.withDeliveryDispatchGate(transport.channel, started.conversation.conversationKey, async () => {
      const dispatchable = await this.engine.assertOutboundDeliveryDispatchable(dispatch.id, started.run.id, lease ?? undefined);
      let receipt: JsonObject;
      try {
        receipt = await transport.deliver(dispatchable, started);
      } catch (error) {
        if (this.options.deliveryErrorsMayBeAmbiguous !== true || isProviderDeliveryRejectedError(error)) {
          let reconciled: JsonObject | null;
          try {
            reconciled = await transport.reconcileDelivery(dispatchable, started);
          } catch (reconciliationError) {
            throw new DeliveryInterruptedError(
              `provider dispatch failed and reconciliation is unavailable: ${errorMessage(reconciliationError)}`
            );
          }
          if (reconciled) {
            try {
              const accepted = await this.engine.markOutboundDeliveryProviderAccepted(dispatch.id, started.run.id, reconciled, lease ?? undefined);
              return { delivery: accepted, receipt: reconciled };
            } catch (acceptanceError) {
              throw new DeliveryInterruptedError(
                `reconciled provider delivery could not persist acceptance: ${errorMessage(acceptanceError)}`
              );
            }
          }
          await this.engine.releaseOutboundDeliveryDispatch(dispatch.id);
          throw error;
        }
        let unknown: OutboundDelivery;
        try {
          unknown = await this.engine.markOutboundDeliveryAcceptanceUnknown(dispatch.id, errorMessage(error));
        } catch (transitionError) {
          throw new DeliveryInterruptedError(
            `provider dispatch failed before acceptance uncertainty could persist: ${errorMessage(transitionError)}`
          );
        }
        let reconciled: JsonObject | null;
        try {
          reconciled = await transport.reconcileDelivery(unknown, started);
        } catch (reconciliationError) {
          throw new DeliveryAcceptanceUnknownError(
            `provider dispatch failed and reconciliation is unavailable: ${errorMessage(reconciliationError)}`
          );
        }
        if (reconciled) {
          try {
            const accepted = await this.engine.markOutboundDeliveryProviderAccepted(dispatch.id, started.run.id, reconciled, lease ?? undefined);
            return { delivery: accepted, receipt: reconciled };
          } catch (acceptanceError) {
            throw new DeliveryInterruptedError(
              `reconciled provider delivery could not persist acceptance: ${errorMessage(acceptanceError)}`
            );
          }
        }
        throw new DeliveryAcceptanceUnknownError(
          `provider dispatch outcome is ambiguous: ${errorMessage(error)}`
        );
      }
      try {
        const accepted = await this.engine.markOutboundDeliveryProviderAccepted(dispatch.id, started.run.id, receipt, lease ?? undefined);
        return { delivery: accepted, receipt };
      } catch (error) {
        // The provider has accepted the idempotency key but SQLite did not
        // durably record it. Preserve dispatching for reconciliation; retrying
        // it blindly would be less safe than retaining the durable intent.
        throw new DeliveryInterruptedError(
          `provider delivery was accepted before durable acceptance persistence: ${errorMessage(error)}`
        );
      }
    });
  }

  private acceptanceUnknownRetryIsDue(delivery: OutboundDelivery): boolean {
    const unknownAt = delivery.acceptanceUnknownAt == null
      ? Number.NaN
      : Date.parse(delivery.acceptanceUnknownAt);
    if (!Number.isFinite(unknownAt)) return false;
    return (this.options.now?.().getTime() ?? Date.now()) >= unknownAt + this.acceptanceUnknownRetryDelayMs;
  }

  /** Keeps an active run lease durable until this runtime reaches a safe boundary. */
  private async withRunLease<T>(
    started: TaskLedgerStartedRun,
    lease: ConversationRunLease,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.assertLease(started, lease);
    let heartbeatRunning = false;
    let heartbeatFailure: Error | null = null;
    const heartbeat = async (): Promise<void> => {
      if (heartbeatRunning || heartbeatFailure) return;
      heartbeatRunning = true;
      try {
        const renewed = await this.engine.heartbeatRunLease(
          started.conversation.channel,
          started.conversation.conversationKey,
          started.run.id,
          lease,
          this.runLeaseDurationMs
        );
        if (!renewed) heartbeatFailure = new RunLeaseLostError(`Run lease was lost for ${started.run.id}`);
      } catch (error) {
        heartbeatFailure = new RunLeaseLostError(`Run lease heartbeat failed for ${started.run.id}: ${errorMessage(error)}`);
      } finally {
        heartbeatRunning = false;
      }
    };
    const timer = setInterval(() => { void heartbeat(); }, this.runLeaseHeartbeatMs);
    try {
      const result = await operation();
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async assertLease(started: TaskLedgerStartedRun, lease: ConversationRunLease): Promise<void> {
    try {
      await this.engine.assertRunLease(
        started.conversation.channel,
        started.conversation.conversationKey,
        started.run.id,
        lease
      );
    } catch (error) {
      throw new RunLeaseLostError(errorMessage(error));
    }
  }

  async executeWithSteering<T>(
    channel: TaskChannel,
    started: TaskLedgerStartedRun,
    execute: (input: ConversationRuntimeExecutionInput) => Promise<T>,
    updateNotice: string | null = null,
    maxTurns = 20,
    maxContextTokens = Number.MAX_SAFE_INTEGER,
    runtimePromptReservedTokens = 0,
    providerInstructions: string[] = []
  ): Promise<T> {
    const messages = [...started.messages];
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if ((await this.engine.deploymentLifecycle()).state !== "normal") {
        throw new RunCheckpointedError();
      }
      const turnUpdateNotice = turn === 0 ? updateNotice : null;
      const reminderInstruction = reminderInstructionFromMessages(messages);
      const runtimeInputTokens = this.runtimeOwnedInputTokenCount(turnUpdateNotice, reminderInstruction)
        + runtimePromptReservedTokens;
      const context = await this.buildBoundedContext(
        channel,
        started.conversation.conversationKey,
        started.run.id,
        maxContextTokens,
        runtimeInputTokens
      );
      const prompt = providerInstructions.length === 0
        ? null
        : await this.buildExecutionPrompt(providerInstructions, {
          conversationKey: started.conversation.conversationKey,
          context,
          updateNotice: turnUpdateNotice,
          ...(reminderInstruction === null ? {} : { reminderInstruction })
        }, maxContextTokens);
      const result = await execute({
        started,
        messages,
        context,
        prompt,
        updateNotice: turnUpdateNotice,
        runtimeInputTokens
      });
      if (turn === maxTurns - 1) return result;
      const steering = await this.claimSteeringMessages(channel, started.conversation.conversationKey, started.run.id);
      if (steering.length === 0) return result;
      messages.push(...steering);
    }
    throw new Error(`${channel} steering exceeded ${maxTurns} turns`);
  }

  /**
   * Own checkpoint eligibility and persistence. Adapters provide only their
   * provider-specific summary prompt formatting.
   */
  async compactIfNeeded(input: ConversationRuntimeCompactionInput): Promise<boolean> {
    const context = await this.engine.buildContext(input.channel, input.conversationKey);
    if (!context || this.contextTokenCount(context) <= input.maxContextTokens) return false;

    const conversation = await this.engine.getConversation(input.channel, input.conversationKey);
    if (!conversation) return false;
    const maxDone = completedRunMaxConsumedSeq(conversation.runs);
    if (maxDone == null || (conversation.compactionSeq != null && maxDone <= conversation.compactionSeq)) return false;

    const previousSeq = conversation.compactionSeq ?? 0;
    const messages = conversation.messages.filter((message) => message.seq > previousSeq && message.seq <= maxDone);
    if (messages.length === 0) return false;

    const compactedMessages = this.compactionMessagesWithinBudget(
      conversation.compactionSummary,
      messages,
      input.maxContextTokens
    );
    if (compactedMessages.length === 0) {
      throw new ContextBudgetExceededError(
        `Compaction input for ${input.channel}:${input.conversationKey} cannot fit its ${input.maxContextTokens} token budget`
      );
    }
    const prompt = this.buildCompactionPrompt(conversation.compactionSummary, compactedMessages);
    const promptTokens = this.tokenCounter.count(prompt);
    if (promptTokens > input.maxContextTokens) {
      throw new ContextBudgetExceededError(
        `Compaction prompt requires ${promptTokens} tokens, exceeding the ${input.maxContextTokens} token budget`
      );
    }

    const summary = await input.createSummary(
      conversation.compactionSummary,
      compactedMessages,
      prompt
    );
    await this.engine.compact(
      input.channel,
      input.conversationKey,
      truncateText(summary, input.summaryMaxChars),
      compactedMessages.at(-1)?.seq ?? previousSeq
    );
    return true;
  }

  async stop(channel: TaskChannel, conversationKey: string, reason = "user_stop") {
    return this.engine.stop(channel, conversationKey, reason);
  }

  /** Deployment context for the first run after a checkpoint or interrupted restart. */
  private updateNoticeFor(started: TaskLedgerStartedRun): string | null {
    if (!this.options.updateNotice) return null;
    const previous = started.conversation.runs
      .filter((run) => run.id !== started.run.id && run.status !== "running")
      .at(-1);
    if (!previous || previous.status !== "interrupted") return null;
    return this.options.updateNotice(previous.finishedAt ?? null);
  }

  private async loadBoundedMemoryContext(): Promise<string | null> {
    const maxTokens = this.options.maxMemoryContextTokens ?? 0;
    if (!this.options.loadMemoryContext || maxTokens <= 0) return null;
    const memory = await this.options.loadMemoryContext();
    if (!memory) return null;
    return this.tokenCounter.truncate(memory, maxTokens);
  }

  /**
   * Construct the only model-visible history slice. The ledger exposes durable
   * records; Runtime applies the model-specific counter and hard budget.
   */
  async buildBoundedContext(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    maxTokens: number,
    reservedTokens = 0
  ): Promise<BoundedConversationContext | null> {
    const normalizedMaxTokens = requirePositiveSafeInteger(maxTokens, "context max tokens");
    const normalizedReservedTokens = requireNonNegativeSafeInteger(reservedTokens, "reserved context tokens");
    if (normalizedReservedTokens > normalizedMaxTokens) {
      throw new ContextBudgetExceededError(
        `Runtime-owned inputs require ${normalizedReservedTokens} tokens, exceeding the ${normalizedMaxTokens} token context budget`
      );
    }
    const context = await this.engine.buildContext(channel, conversationKey);
    if (!context) return null;

    const currentMessages = context.messages.filter((message) => message.runId === runId);
    const availableConversationTokens = normalizedMaxTokens - normalizedReservedTokens;
    const currentTokens = this.messageTokenCount(currentMessages);
    if (currentTokens > availableConversationTokens) {
      throw new ContextBudgetExceededError(
        `Current request for ${channel}:${conversationKey} requires ${currentTokens} tokens, exceeding the ${availableConversationTokens} token conversation budget`
      );
    }

    let remaining = availableConversationTokens - currentTokens;
    const summary = this.truncateToTokenBudget(context.summary, remaining);
    const summaryTokens = summary ? this.tokenCounter.count(summary) : 0;
    remaining -= summaryTokens;

    const recentUserMessages = this.newestMessagesWithinBudget(context.recentUserMessages, remaining);
    remaining -= this.messageTokenCount(recentUserMessages);

    const priorMessages = this.newestMessagesWithinBudget(
      context.messages.filter((message) => message.runId !== runId),
      remaining
    );
    const messages = [...priorMessages, ...currentMessages].sort((left, right) => left.seq - right.seq);
    const tokenCount = normalizedReservedTokens
      + summaryTokens
      + this.messageTokenCount(recentUserMessages)
      + this.messageTokenCount(messages);
    return {
      summary,
      recentUserMessages,
      messages,
      maxTokens: normalizedMaxTokens,
      reservedTokens: normalizedReservedTokens,
      tokenCount,
      truncated:
        summary !== context.summary
        || recentUserMessages.length !== context.recentUserMessages.length
        || messages.length !== context.messages.length
    };
  }

  private availableConversationContextTokens(
    maxContextTokens: number,
    updateNotice: string | null,
    reminderInstruction: string | null,
    runtimePromptReservedTokens: number
  ): number {
    return Math.max(
      0,
      maxContextTokens
        - this.runtimeOwnedInputTokenCount(updateNotice, reminderInstruction)
        - runtimePromptReservedTokens
    );
  }

  private contextTokenCount(context: ConversationContext): number {
    return [
      context.summary || "",
      ...context.recentUserMessages.map((message) => message.text),
      ...context.messages.map((message) => message.text)
    ].reduce((total, text) => total + this.tokenCounter.count(text), 0);
  }

  private runtimeOwnedInputTokenCount(
    updateNotice: string | null,
    reminderInstruction: string | null = null
  ): number {
    return [
      updateNotice,
      reminderInstruction
    ].reduce<number>((total, value) => total + (value == null ? 0 : this.tokenCounter.count(value)), 0);
  }

  private messageTokenCount(messages: readonly TaskLedgerMessage[]): number {
    return messages.reduce((total, message) => total + this.tokenCounter.count(message.text), 0);
  }

  private newestMessagesWithinBudget(messages: readonly TaskLedgerMessage[], budget: number): TaskLedgerMessage[] {
    if (budget <= 0) return [];
    const selected: TaskLedgerMessage[] = [];
    let used = 0;
    for (const message of [...messages].sort((left, right) => right.seq - left.seq)) {
      const tokens = this.tokenCounter.count(message.text);
      if (used + tokens > budget) continue;
      selected.push(message);
      used += tokens;
    }
    return selected.sort((left, right) => left.seq - right.seq);
  }

  private truncateToTokenBudget(text: string | null, budget: number): string | null {
    if (!text || budget <= 0) return null;
    return this.tokenCounter.truncate(text, budget) || null;
  }

  /** Select the largest contiguous checkpoint prefix that fits the compaction model. */
  private compactionMessagesWithinBudget(
    previousSummary: string | null,
    messages: TaskLedgerMessage[],
    maxTokens: number
  ): TaskLedgerMessage[] {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return [];
    let lower = 0;
    let upper = messages.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      const prompt = this.buildCompactionPrompt(previousSummary, messages.slice(0, middle));
      if (this.tokenCounter.count(prompt) <= maxTokens) lower = middle;
      else upper = middle - 1;
    }
    return messages.slice(0, lower);
  }
}

/** A provider-safe failure that occurred before any outbound provider effect. */
export class ProviderDeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderDeliveryRejectedError";
  }
}

/** A provider call may have succeeded, so reconciliation must precede retry. */
class DeliveryAcceptanceUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryAcceptanceUnknownError";
  }
}

const defaultAcceptanceUnknownRetryDelayMs = 120_000;

function resolveProviderInstructions<TTarget, TDecision>(
  transport: ConversationRuntimeTransport<TTarget, TDecision>,
  started: TaskLedgerStartedRun
): string[] {
  const value = transport.providerInstructions;
  return value == null ? [] : typeof value === "function" ? value(started) : value;
}

function reminderInstructionFromMessages(messages: TaskLedgerMessage[]): string | null {
  return messages.find((message) => message.metadata.reminderInstruction === true)?.text ?? null;
}

export function buildConversationRuntimePrompt(
  instructions: string[],
  input: ConversationRuntimePromptInput
): string {
  return [
    ...instructions,
    "",
    JSON.stringify({
      conversationKey: input.conversationKey,
      checkpointSummary: input.context?.summary ?? null,
      updateNotice: input.updateNotice,
      reminderInstruction: input.reminderInstruction ?? null,
      memoryContext: input.memoryContext ?? null,
      recentUserMessages: input.context?.recentUserMessages ?? [],
      messages: input.context?.messages ?? []
    }, null, 2),
    "",
    "Assistant response:"
  ].join("\n");
}

/** Shared, channel-agnostic prompt for a checkpoint compaction model turn. */
export function buildConversationCompactionPrompt(
  previousSummary: string | null,
  messages: TaskLedgerMessage[]
): string {
  return [
    "Create a concise handoff summary for the next model. Include current progress and decisions, important context and user constraints, remaining work, and critical data or references needed to continue.",
    previousSummary ? `Previous checkpoint summary:\n${previousSummary}` : null,
    "Messages to compact:",
    messages.map((message) => {
      const author = message.role === "assistant" ? "assistant" : message.authorId || message.role;
      return `- seq ${message.seq} ${author}: ${message.text.trim() || "[empty]"}`;
    }).join("\n")
  ].filter(Boolean).join("\n\n");
}




function assistantCandidate(input: TaskLedgerAssistantMessageInput): OutboundDeliveryAssistantMessage {
  const candidate: OutboundDeliveryAssistantMessage = { text: input.text };
  if (input.externalMessageId !== undefined) candidate.externalMessageId = input.externalMessageId;
  if (input.authorId !== undefined) candidate.authorId = input.authorId;
  if (input.receivedAt !== undefined) candidate.receivedAt = input.receivedAt;
  if (input.metadata !== undefined) candidate.metadata = input.metadata;
  return candidate;
}

function isRunCheckpointedError(error: unknown): boolean {
  return error instanceof RunCheckpointedError
    || (typeof error === "object" && error !== null && "name" in error && error.name === "RunCheckpointedError");
}

function isDeliveryInterruptedError(error: unknown): boolean {
  return error instanceof DeliveryInterruptedError
    || (typeof error === "object" && error !== null && "name" in error && error.name === "DeliveryInterruptedError");
}

function isRunLeaseLostError(error: unknown): boolean {
  return error instanceof RunLeaseLostError
    || (typeof error === "object" && error !== null && "name" in error && error.name === "RunLeaseLostError");
}

function isDeliveryAcceptanceUnknownError(error: unknown): error is DeliveryAcceptanceUnknownError {
  return error instanceof DeliveryAcceptanceUnknownError
    || (typeof error === "object" && error !== null && "name" in error && error.name === "DeliveryAcceptanceUnknownError");
}

function isProviderDeliveryRejectedError(error: unknown): error is ProviderDeliveryRejectedError {
  return error instanceof ProviderDeliveryRejectedError
    || (typeof error === "object" && error !== null && "name" in error && error.name === "ProviderDeliveryRejectedError");
}

function isCommunicationChannel(channel: TaskChannel): channel is CommunicationChannel {
  return channel === "slack" || channel === "email" || channel === "phone";
}

function completedRunMaxConsumedSeq(runs: TaskLedgerRun[]): number | null {
  return runs
    .filter((run) => run.status === "done" && run.lastConsumedSeq != null)
    .reduce<number | null>((max, run) => {
      const seq = run.lastConsumedSeq as number;
      return max == null || seq > max ? seq : max;
    }, null);
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n[truncated]`;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  return requirePositiveSafeInteger(value, "acceptanceUnknownRetryDelayMs");
}

function leaseFromRun(run: TaskLedgerRun): ConversationRunLease | null {
  if (!run.workerInstanceId || !run.leaseExpiresAt) return null;
  return {
    workerInstanceId: run.workerInstanceId,
    leaseExpiresAt: run.leaseExpiresAt
  };
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stoppedBeforeDeliveryError(): CodexProcessError {
  const error = new Error("Run stopped before assistant persistence") as CodexProcessError;
  error.code = "RUN_STOPPED";
  return error;
}
