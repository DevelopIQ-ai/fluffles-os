import { DatabaseSync } from "node:sqlite";
import { LedgerDb, cloneJsonObject, jsonString, nullableNumberField, parseJsonObject, parseJsonObjectOrNull, requireNonEmptyText, requirePositiveSafeInteger, requireRuntimeRecord, requiredNumberField, requiredStringField, runtimeRecordArray } from "@fluffles/storage";
import { utf8TokenUpperBound } from "./context-budget-counter";
import { getChannelContextLimits, isContextLimitChannel } from "./context-limits";
import { ConversationRow, cloneConversation, cloneLifecycleEvent, cloneMessage, cloneOutboundDelivery, cloneRun, conversationRowFromSql, conversationStopRequested, isCommunicationChannel, isControlOutboundDelivery, lifecycleEventFromRow, lifecycleEventRowFromSql, mergeMigratedConversationMetadata, messageFromRow, messageRowFromSql, optionalConversationRowFromSql, optionalCountRowFromSql, optionalMessageRowFromSql, optionalOutboundDeliveryRowFromSql, optionalRunRowFromSql, outboundDeliveryAssistantMessageFromJson, outboundDeliveryAssistantMessageJson, outboundDeliveryFromRow, outboundDeliveryRowFromSql, runFromRow, runRowFromSql, stopRequestedReason, withStopRequested } from "./rows";
import { BridgeLedger, CommunicationChannel, ConfirmOutboundDeliveryInput, ConfirmOutboundDeliveryResult, ConversationContext, ConversationRunLease, ConversationRunLeaseInput, CreateControlOutboundDeliveryInput, CreateOutboundDeliveryInput, JsonObject, LifecycleEvent, LifecycleEventKind, OutboundDelivery, TaskChannel, TaskConversationStatus, TaskLedgerAdmission, TaskLedgerAssistantMessageInput, TaskLedgerConversation, TaskLedgerFinishRunResult, TaskLedgerMessage, TaskLedgerMessageInput, TaskLedgerRecordMessageResult, TaskLedgerRecoveryResult, TaskLedgerRun, TaskLedgerStartedRun, TaskMessageDisposition, TaskRunStatus } from "./types";

const providerCallAdmissionMarker = "__engine_provider_call_admitted__";

export interface BridgeStoreOptions {
  runWorkerInstanceId?: string;
  runOwnerId?: string;
  runLeaseDurationMs?: number;
}

/**
 * Domain hooks the embedder injects so the bridge never imports another
 * domain. `admitNewRuns` gates run starts (fluffles wires it to the control
 * store's deployment lifecycle); `onConversationStopped` runs inside the stop
 * transaction (fluffles wires it to the task registry's cancel).
 */
export interface BridgeStoreHooks {
  admitNewRuns?: (db: DatabaseSync) => boolean;
  onConversationStopped?: (db: DatabaseSync, conversationId: string, reason: string, stoppedAt: string) => void;
  /**
   * Runs inside the key-migration transaction so sibling domains can remap
   * their own rows (fluffles remaps task registry, executor sessions, and
   * scheduled reminders). Fires before the legacy conversation row is deleted.
   */
  onConversationKeyMigrated?: (db: DatabaseSync, migration: ConversationKeyMigration) => void;
}

export interface ConversationKeyMigration {
  channel: TaskChannel;
  legacyKey: string;
  canonicalKey: string;
  legacyConversationId: string;
  /** Null when the canonical conversation was created fresh from the legacy row. */
  canonicalConversationId: string | null;
}

/**
 * The bridge core: chats/messages/runs/deliveries. Owns admission and
 * deduplication, run leases and recovery, steering, compaction, and the
 * idempotent outbound delivery state machine.
 */
export class BridgeStore implements BridgeLedger {
  private readonly defaultRunWorkerInstanceId: string;
  private readonly defaultRunLeaseDurationMs: number;

  constructor(
    private readonly db: LedgerDb,
    options: BridgeStoreOptions = {},
    private readonly hooks: BridgeStoreHooks = {}
  ) {
    this.defaultRunWorkerInstanceId = options.runWorkerInstanceId?.trim() || options.runOwnerId?.trim() || db.newId();
    this.defaultRunLeaseDurationMs = requirePositiveSafeInteger(options.runLeaseDurationMs ?? 60_000, "run lease duration");
  }


  async recordMessage(input: TaskLedgerMessageInput): Promise<TaskLedgerRecordMessageResult> {
    return this.db.mutate<TaskLedgerRecordMessageResult>((db) => this.recordMessageInDb(db, input));
  }

  async admitMessage(input: TaskLedgerMessageInput, admission: TaskLedgerAdmission): Promise<TaskLedgerRecordMessageResult> {
    return this.db.mutate<TaskLedgerRecordMessageResult>((db) => {
      const reason = admission.reason?.trim() || null;
      const admittedInput: TaskLedgerMessageInput = {
        ...input,
        ...(!admission.actionable ? { metadata: { ...(input.metadata ?? {}), nonActionable: true, admissionReason: reason ?? "filtered" } } : {})
      };
      const result = this.recordMessageInDb(db, admittedInput);
      if (result.disposition === "duplicate") return result;

      if (admission.stop) {
        const stopped = this.stopConversationInDb(db, input.channel, input.conversationKey, reason ?? "user_stop");
        return stopped ? { ...result, conversation: stopped } : result;
      }

      if (!admission.actionable) {
        const conversation = this.getConversationInDb(db, input.channel, input.conversationKey);
        if (conversation?.status === "queued" && this.countPendingMessages(db, input.channel, input.conversationKey) === 0) {
          db.prepare(`
            UPDATE conversations SET status = 'done', updated_at = ?, last_error = NULL
            WHERE channel = ? AND conversation_key = ?
          `).run(this.db.isoNow(), input.channel, input.conversationKey);
          return { ...result, conversation: this.requireConversationInDb(db, input.channel, input.conversationKey) };
        }
      }
      return result;
    });
  }

  private recordMessageInDb(db: DatabaseSync, input: TaskLedgerMessageInput): TaskLedgerRecordMessageResult {
      const receivedAt = input.receivedAt ?? this.db.isoNow();
      const existing = this.getConversationInDb(db, input.channel, input.conversationKey);
      const duplicate = input.externalMessageId
        ? this.getMessageByExternalIdInDb(db, input.channel, input.conversationKey, input.externalMessageId)
        : null;

      if (existing && duplicate) {
        this.appendLifecycleEvent(db, {
          channel: input.channel,
          conversationKey: input.conversationKey,
          kind: "duplicate",
          reason: "duplicate_inbound_message",
          metadata: { messageId: duplicate.id, externalMessageId: input.externalMessageId }
        });
        return { conversation: cloneConversation(existing), message: cloneMessage(duplicate), disposition: "duplicate" };
      }

      const seq = this.nextMessageSeq(db, input.channel, input.conversationKey);
      const preservedStop = existing && conversationStopRequested(existing);
      const messageMetadata: JsonObject = preservedStop
        ? { ...(input.metadata ?? {}), nonActionable: true, cancellationReason: stopRequestedReason(existing!) ?? "stopped" }
        : input.metadata ?? {};
      const message: TaskLedgerMessage = {
        id: this.db.newId(),
        seq,
        role: input.role ?? "user",
        externalMessageId: input.externalMessageId,
        authorId: input.authorId,
        text: input.text,
        receivedAt,
        runId: null,
        metadata: messageMetadata
      };

      if (!existing) {
        const conversation: TaskLedgerConversation = {
          id: this.db.newId(),
          channel: input.channel,
          conversationKey: input.conversationKey,
          title: input.title ?? titleFromText(input.text),
          status: "queued",
          createdAt: receivedAt,
          updatedAt: receivedAt,
          lastError: null,
          replyTarget: input.replyTarget ?? null,
          metadata: input.metadata ?? {},
          activeRunId: null,
          compactionSeq: null,
          compactionSummary: null,
          messages: [message],
          runs: []
        };
        this.insertConversation(db, conversation);
        this.insertMessage(db, conversation.channel, conversation.conversationKey, message);
        this.appendLifecycleEvent(db, {
          channel: conversation.channel,
          conversationKey: conversation.conversationKey,
          kind: "admitted",
          metadata: { messageId: message.id, seq: message.seq }
        });
        return { conversation: cloneConversation(conversation), message: cloneMessage(message), disposition: "new_conversation" };
      }

      const disposition: TaskMessageDisposition = existing.status === "running" ? "running_update" : "queued_update";
      this.insertMessage(db, input.channel, input.conversationKey, message);
      db.prepare(`
        UPDATE conversations
        SET status = ?, updated_at = ?, last_error = NULL, reply_target_json = ?, metadata_json = ?
        WHERE channel = ? AND conversation_key = ?
      `).run(
        existing.status === "running" ? "running" : "queued",
        receivedAt,
        jsonString(input.replyTarget ?? existing.replyTarget),
        jsonString(preservedStop ? existing.metadata : input.metadata ?? existing.metadata),
        input.channel,
        input.conversationKey
      );
      this.appendLifecycleEvent(db, {
        channel: input.channel,
        conversationKey: input.conversationKey,
        kind: disposition === "running_update" ? "steering_received" : "admitted",
        metadata: { messageId: message.id, seq: message.seq }
      });

      return {
        conversation: this.requireConversationInDb(db, input.channel, input.conversationKey),
        message: cloneMessage(message),
        disposition
      };
  }

  async lifecycleEvents(channel: TaskChannel, conversationKey: string): Promise<LifecycleEvent[]> {
    const rows = runtimeRecordArray(this.db.ensureDb().prepare(`
      SELECT ${lifecycleEventColumns()}
      FROM lifecycle_events
      WHERE channel = ? AND conversation_key = ?
      -- rowid preserves commit insertion order even when several transitions
      -- share the same clock timestamp.
      ORDER BY rowid ASC
    `).all(channel, conversationKey), `lifecycle events for ${channel}:${conversationKey}`)
      .map((row) => lifecycleEventRowFromSql(row, `lifecycle event for ${channel}:${conversationKey}`));
    return rows.map(lifecycleEventFromRow).map(cloneLifecycleEvent);
  }

  async recordAssistantMessage(input: TaskLedgerAssistantMessageInput): Promise<TaskLedgerMessage | null> {
    return this.db.mutate<TaskLedgerMessage | null>((db) => {
      const message = this.recordAssistantMessageInDb(db, input);
      return message ? cloneMessage(message) : null;
    });
  }

  async createOutboundDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const conversation = this.requireConversationInDb(db, input.channel, input.conversationKey);
      const run = conversation.runs.find((candidate) => candidate.id === input.runId);
      if (conversation.activeRunId !== input.runId || run?.status !== "running") {
        throw new Error(`Cannot create outbound delivery for inactive run ${input.runId}`);
      }

      const provider = requireNonEmptyText(input.provider, "delivery provider");
      const idempotencyKey = requireNonEmptyText(input.idempotencyKey, "delivery idempotency key");
      const existing = this.outboundDeliveryByProviderKeyInDb(db, provider, idempotencyKey);
      if (existing) {
        if (
          existing.channel === input.channel
          && existing.conversationKey === input.conversationKey
          && existing.runId === input.runId
        ) return cloneOutboundDelivery(existing);
        throw new Error(`Delivery idempotency key already belongs to ${existing.id}`);
      }

      const now = this.db.isoNow();
      const delivery: OutboundDelivery = {
        id: this.db.newId(),
        channel: input.channel,
        conversationKey: input.conversationKey,
        runId: input.runId,
        provider,
        idempotencyKey,
        status: "pending",
        payload: cloneJsonObject(input.payload),
        assistantMessage: outboundDeliveryAssistantMessageFromJson(
          jsonString(outboundDeliveryAssistantMessageJson(input.assistantMessage)),
          "new"
        ),
        providerReceipt: null,
        error: null,
        attemptCount: 1,
        attemptedAt: now,
        acceptanceUnknownAt: null,
        deliveredAt: null,
        createdAt: now,
        updatedAt: now
      };
      this.insertOutboundDelivery(db, delivery);
      this.appendLifecycleEvent(db, {
        channel: delivery.channel,
        conversationKey: delivery.conversationKey,
        runId: delivery.runId,
        kind: "delivery_intended",
        metadata: { deliveryId: delivery.id, provider: delivery.provider, attemptCount: delivery.attemptCount }
      });
      return cloneOutboundDelivery(delivery);
    });
  }

  async createControlOutboundDelivery(input: CreateControlOutboundDeliveryInput): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const conversation = this.requireConversationInDb(db, input.channel, input.conversationKey);
      const provider = requireNonEmptyText(input.provider, "control delivery provider");
      const idempotencyKey = requireNonEmptyText(input.idempotencyKey, "control delivery idempotency key");
      const existing = this.outboundDeliveryByProviderKeyInDb(db, provider, idempotencyKey);
      if (existing) {
        if (existing.channel === input.channel && existing.conversationKey === input.conversationKey && isControlOutboundDelivery(existing)) return cloneOutboundDelivery(existing);
        throw new Error(`Delivery idempotency key already belongs to ${existing.id}`);
      }
      const now = this.db.isoNow();
      const deliveryId = this.db.newId();
      const delivery: OutboundDelivery = {
        id: deliveryId, channel: input.channel, conversationKey: input.conversationKey,
        runId: `control:${deliveryId}`, provider, idempotencyKey, status: "pending",
        payload: { ...cloneJsonObject(input.payload), __runtimeControlDelivery: true },
        assistantMessage: outboundDeliveryAssistantMessageFromJson(jsonString(outboundDeliveryAssistantMessageJson(input.assistantMessage)), "new control delivery"),
        providerReceipt: null, error: null,
        attemptCount: 1, attemptedAt: now, acceptanceUnknownAt: null, deliveredAt: null, createdAt: now, updatedAt: now
      };
      this.insertOutboundDelivery(db, delivery);
      this.appendLifecycleEvent(db, { channel: delivery.channel, conversationKey: delivery.conversationKey, kind: "delivery_intended", metadata: { deliveryId: delivery.id, provider, control: true, attemptCount: 1 } });
      return cloneOutboundDelivery(delivery);
    });
  }

  async pendingOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null> {
    const delivery = this.pendingOutboundDeliveryInDb(this.db.ensureDb(), channel, conversationKey);
    return delivery ? cloneOutboundDelivery(delivery) : null;
  }

  async recoverableOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null> {
    const delivery = this.recoverableOutboundDeliveryInDb(this.db.ensureDb(), channel, conversationKey);
    return delivery ? cloneOutboundDelivery(delivery) : null;
  }

  async outboundDeliveries(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery[]> {
    return this.outboundDeliveriesInDb(this.db.ensureDb(), channel, conversationKey).map(cloneOutboundDelivery);
  }

  async recoverableControlOutboundDeliveries(channel: CommunicationChannel): Promise<OutboundDelivery[]> {
    const rows = runtimeRecordArray(this.db.ensureDb().prepare(`
      SELECT ${outboundDeliveryColumns()} FROM outbound_deliveries
      WHERE channel = ? AND json_extract(payload_json, '$.__runtimeControlDelivery') = 1
        AND status IN ('pending', 'dispatching', 'acceptance_unknown', 'failed')
      ORDER BY created_at ASC, id ASC
    `).all(channel), `recoverable control deliveries for ${channel}`);
    return rows.map((row) => cloneOutboundDelivery(outboundDeliveryFromRow(outboundDeliveryRowFromSql(row, "control delivery row"))));
  }

  async startOutboundDeliveryAttempt(deliveryId: string): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "pending" && delivery.status !== "failed" && delivery.status !== "dispatching" && delivery.status !== "acceptance_unknown") {
        throw new Error(`Cannot start outbound delivery attempt ${delivery.id} from ${delivery.status}`);
      }
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);
      if (!isControlOutboundDelivery(delivery) && (conversation.status !== "running" || conversation.activeRunId == null)) {
        throw new Error(`Cannot start outbound delivery attempt ${delivery.id} for a non-running conversation`);
      }
      const attemptedAt = this.db.isoNow();
      const attempted: OutboundDelivery = {
        ...delivery,
        status: "pending",
        error: null,
        attemptCount: delivery.attemptCount + 1,
        attemptedAt,
        acceptanceUnknownAt: null,
        updatedAt: attemptedAt
      };
      this.updateOutboundDelivery(db, attempted);
      return cloneOutboundDelivery(attempted);
    });
  }

  /** Atomically fence provider dispatch against a concurrent stop request. */
  async beginOutboundDeliveryDispatch(
    deliveryId: string,
    runId: string,
    lease?: ConversationRunLease
  ): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "pending") {
        throw new Error(`Cannot begin outbound delivery dispatch ${delivery.id} from ${delivery.status}`);
      }
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);
      if (!isControlOutboundDelivery(delivery) && (conversation.status !== "running" || conversation.activeRunId !== runId)) {
        throw new Error(`Cannot begin outbound delivery dispatch ${delivery.id} for an inactive run`);
      }
      if (!isControlOutboundDelivery(delivery)) this.assertRunLeaseInDb(db, delivery.channel, delivery.conversationKey, runId, lease);
      const dispatching: OutboundDelivery = {
        ...delivery,
        status: "dispatching",
        updatedAt: this.db.isoNow()
      };
      this.updateOutboundDelivery(db, dispatching);
      this.appendLifecycleEvent(db, {
        channel: dispatching.channel,
        conversationKey: dispatching.conversationKey,
        runId,
        kind: "delivery_dispatched",
        metadata: { deliveryId: dispatching.id, provider: dispatching.provider, attemptCount: dispatching.attemptCount }
      });
      return cloneOutboundDelivery(dispatching);
    });
  }

  /** Verify the still-revocable admission immediately before the provider call. */
  async assertOutboundDeliveryDispatchable(
    deliveryId: string,
    runId: string,
    lease?: ConversationRunLease
  ): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "dispatching") {
        throw new Error(`Cannot dispatch outbound delivery ${delivery.id} from ${delivery.status}`);
      }
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);
      if (!isControlOutboundDelivery(delivery) && (conversation.status !== "running" || conversation.activeRunId !== runId || conversationStopRequested(conversation))) {
        throw new Error(`Cannot dispatch outbound delivery ${delivery.id} for an inactive run`);
      }
      if (!isControlOutboundDelivery(delivery)) this.assertRunLeaseInDb(db, delivery.channel, delivery.conversationKey, runId, lease);
      // This is the durable linearization point immediately before the
      // provider call. A stop before it cancels delivery; a stop after it
      // waits for the caller to report whether Gmail accepted the effect.
      const admitted = { ...delivery, error: providerCallAdmissionMarker, updatedAt: this.db.isoNow() };
      this.updateOutboundDelivery(db, admitted);
      return cloneOutboundDelivery(admitted);
    });
  }

  /** Persist the provider effect before attempting local delivery confirmation. */
  async markOutboundDeliveryProviderAccepted(
    deliveryId: string,
    runId: string,
    providerReceipt: JsonObject,
    lease?: ConversationRunLease
  ): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "dispatching" && delivery.status !== "acceptance_unknown") {
        throw new Error(`Cannot mark outbound delivery ${delivery.id} accepted from ${delivery.status}`);
      }
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);
      // A stop which is committed after the final dispatch check is allowed to
      // wait for this in-flight provider call. It must not erase a provider
      // effect which happened before terminal cancellation is recorded.
      if (!isControlOutboundDelivery(delivery) && (conversation.status !== "running" || conversation.activeRunId !== runId)) {
        throw new Error(`Cannot mark outbound delivery ${delivery.id} accepted for an inactive run`);
      }
      if (!isControlOutboundDelivery(delivery)) this.assertRunLeaseInDb(db, delivery.channel, delivery.conversationKey, runId, lease);
      const accepted: OutboundDelivery = {
        ...delivery,
        status: "provider_accepted",
        providerReceipt: cloneJsonObject(providerReceipt),
        error: null,
        acceptanceUnknownAt: null,
        updatedAt: this.db.isoNow()
      };
      this.updateOutboundDelivery(db, accepted);
      this.appendLifecycleEvent(db, {
        channel: accepted.channel,
        conversationKey: accepted.conversationKey,
        runId,
        kind: "provider_accepted",
        metadata: { deliveryId: accepted.id, provider: accepted.provider, attemptCount: accepted.attemptCount }
      });
      return cloneOutboundDelivery(accepted);
    });
  }

  /**
   * Preserve delivery ambiguity durably. Recovery must reconcile this state
   * before any later provider call can be considered.
   */
  async markOutboundDeliveryAcceptanceUnknown(deliveryId: string, error: string): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status === "acceptance_unknown") return cloneOutboundDelivery(delivery);
      if (delivery.status !== "dispatching") {
        throw new Error(`Cannot mark outbound delivery ${delivery.id} acceptance unknown from ${delivery.status}`);
      }
      const unknownAt = this.db.isoNow();
      const unknown: OutboundDelivery = {
        ...delivery,
        status: "acceptance_unknown",
        error: requireNonEmptyText(error, "delivery acceptance uncertainty"),
        acceptanceUnknownAt: unknownAt,
        updatedAt: unknownAt
      };
      this.updateOutboundDelivery(db, unknown);
      this.appendLifecycleEvent(db, {
        channel: unknown.channel,
        conversationKey: unknown.conversationKey,
        runId: unknown.runId,
        kind: "delivery_acceptance_unknown",
        reason: unknown.error,
        metadata: { deliveryId: unknown.id, provider: unknown.provider, attemptCount: unknown.attemptCount }
      });
      return cloneOutboundDelivery(unknown);
    });
  }

  /** Return an unaccepted provider call to recovery, or cancel it if stop won the race. */
  async releaseOutboundDeliveryDispatch(deliveryId: string): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "dispatching") return cloneOutboundDelivery(delivery);
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);
      const stopped = conversation.status === "stopped" || conversationStopRequested(conversation);
      const released: OutboundDelivery = {
        ...delivery,
        status: stopped ? "cancelled" : "pending",
        error: stopped ? conversation.lastError ?? "stopped" : null,
        acceptanceUnknownAt: null,
        updatedAt: this.db.isoNow()
      };
      this.updateOutboundDelivery(db, released);
      if (stopped) {
        this.appendLifecycleEvent(db, {
          channel: delivery.channel,
          conversationKey: delivery.conversationKey,
          kind: "cancelled",
          reason: released.error,
          metadata: { deliveryId: delivery.id, kind: "outbound_delivery" }
        });
      }
      if (conversationStopRequested(conversation)) {
        this.finalizeRequestedStopInDb(db, delivery.channel, delivery.conversationKey);
      }
      return cloneOutboundDelivery(released);
    });
  }

  async confirmOutboundDelivery(input: ConfirmOutboundDeliveryInput): Promise<ConfirmOutboundDeliveryResult> {
    return this.db.mutate<ConfirmOutboundDeliveryResult>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, input.deliveryId);
      if (delivery.status !== "pending" && delivery.status !== "dispatching" && delivery.status !== "acceptance_unknown" && delivery.status !== "provider_accepted") {
        throw new Error(`Cannot confirm outbound delivery ${delivery.id} from ${delivery.status}`);
      }
      const conversation = this.requireConversationInDb(db, delivery.channel, delivery.conversationKey);

      const deliveredAt = this.db.isoNow();
      const confirmed: OutboundDelivery = {
        ...delivery,
        status: "delivered",
        providerReceipt: delivery.providerReceipt ?? cloneJsonObject(input.providerReceipt),
        error: null,
        acceptanceUnknownAt: null,
        deliveredAt,
        updatedAt: deliveredAt
      };
      this.updateOutboundDelivery(db, confirmed);

      const control = isControlOutboundDelivery(delivery);
      const assistantMessage = this.recordAssistantMessageInDb(db, {
        channel: delivery.channel,
        conversationKey: delivery.conversationKey,
        runId: control ? null : input.runId,
        ...delivery.assistantMessage
      }, control || delivery.status === "dispatching" || delivery.status === "acceptance_unknown" || delivery.status === "provider_accepted");
      if (!assistantMessage) {
        throw new Error(`Cannot confirm outbound delivery ${delivery.id} for inactive run ${input.runId}`);
      }
      const finish = control
        ? {
            conversation: this.requireConversationInDb(db, delivery.channel, delivery.conversationKey),
            hasPendingMessages: this.countPendingMessages(db, delivery.channel, delivery.conversationKey) > 0
          }
        : this.finishRunInDb(db, delivery.channel, delivery.conversationKey, input.runId, "done", null);
      if (!finish) throw new Error(`Cannot finish run ${input.runId} while confirming outbound delivery ${delivery.id}`);
      this.appendLifecycleEvent(db, {
        channel: delivery.channel,
        conversationKey: delivery.conversationKey,
        ...(control ? {} : { runId: input.runId }),
        kind: "delivery_confirmed",
        metadata: { deliveryId: delivery.id, provider: delivery.provider, attemptCount: delivery.attemptCount }
      });

      if (conversationStopRequested(conversation)) {
        this.finalizeRequestedStopInDb(db, delivery.channel, delivery.conversationKey);
      }

      return {
        delivery: cloneOutboundDelivery(confirmed),
        assistantMessage: cloneMessage(assistantMessage),
        finish
      };
    });
  }

  async failOutboundDelivery(
    deliveryId: string,
    error: string,
    providerReceipt: JsonObject | null = null
  ): Promise<OutboundDelivery> {
    return this.db.mutate<OutboundDelivery>((db) => {
      const delivery = this.requireOutboundDeliveryInDb(db, deliveryId);
      if (delivery.status !== "pending" && delivery.status !== "dispatching" && delivery.status !== "acceptance_unknown") {
        throw new Error(`Cannot fail outbound delivery ${delivery.id} from ${delivery.status}`);
      }
      const failed: OutboundDelivery = {
        ...delivery,
        status: "failed",
        providerReceipt: providerReceipt ? cloneJsonObject(providerReceipt) : null,
        error: requireNonEmptyText(error, "delivery error"),
        acceptanceUnknownAt: null,
        updatedAt: this.db.isoNow()
      };
      this.updateOutboundDelivery(db, failed);
      this.appendLifecycleEvent(db, {
        channel: failed.channel,
        conversationKey: failed.conversationKey,
        runId: failed.runId,
        kind: "delivery_failed",
        reason: failed.error,
        metadata: { deliveryId: failed.id, provider: failed.provider, attemptCount: failed.attemptCount }
      });
      return cloneOutboundDelivery(failed);
    });
  }

  async startRun(
    channel: TaskChannel,
    conversationKey: string,
    leaseInput?: ConversationRunLeaseInput
  ): Promise<TaskLedgerStartedRun | null> {
    return this.db.mutate<TaskLedgerStartedRun | null>((db) => {
      if (this.hooks.admitNewRuns && !this.hooks.admitNewRuns(db)) return null;
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      if (!conversation || conversation.status === "stopped" || conversationStopRequested(conversation)) return null;
      if (conversation.status === "running" || conversation.activeRunId) return null;
      const recoveryDelivery = isCommunicationChannel(channel)
        ? this.recoverableOutboundDeliveryInDb(db, channel, conversationKey)
        : null;
      const pendingMessages = recoveryDelivery ? [] : conversation.messages.filter(isActionablePendingMessage);
      if (!recoveryDelivery && pendingMessages.length === 0) return null;
      const lease = this.newRunLeaseInDb(db, channel, conversationKey, leaseInput);
      const run: TaskLedgerRun = {
        id: this.db.newId(),
        status: "running",
        startedAt: this.db.isoNow(),
        finishedAt: null,
        messageIds: pendingMessages.map((message) => message.id),
        error: null,
        lastConsumedSeq: null,
        workerInstanceId: lease.workerInstanceId,
        leaseExpiresAt: lease.leaseExpiresAt
      };
      this.insertRun(db, channel, conversationKey, run);
      const updateMessage = db.prepare(`
        UPDATE messages SET run_id = ?
        WHERE channel = ? AND conversation_key = ? AND id = ?
      `);
      for (const message of pendingMessages) {
        updateMessage.run(run.id, channel, conversationKey, message.id);
        message.runId = run.id;
      }
      db.prepare(`
        UPDATE conversations SET status = 'running', updated_at = ?, last_error = NULL, active_run_id = ?
        WHERE channel = ? AND conversation_key = ?
      `).run(run.startedAt, run.id, channel, conversationKey);
      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        runId: run.id,
        kind: "run_started",
        metadata: {
          messageIds: run.messageIds,
          workerInstanceId: run.workerInstanceId ?? null,
          leaseExpiresAt: run.leaseExpiresAt ?? null
        }
      });
      return {
        conversation: this.requireConversationInDb(db, channel, conversationKey),
        run: cloneRun(run),
        messages: pendingMessages.map(cloneMessage)
      };
    });
  }

  /** Atomically renews an unexpired lease. A reclaimed owner cannot renew it. */
  async heartbeatRunLease(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease,
    leaseDurationMs: number
  ): Promise<ConversationRunLease | null> {
    return this.db.mutate<ConversationRunLease | null>((db) => {
      const duration = requirePositiveSafeInteger(leaseDurationMs, "run lease duration");
      const now = this.db.isoNow();
      const leaseExpiresAt = new Date(this.db.nowDate().getTime() + duration).toISOString();
      const result = db.prepare(`
        UPDATE runs
        SET lease_expires_at = ?
        WHERE channel = ? AND conversation_key = ? AND id = ? AND status = 'running'
          AND worker_instance_id = ? AND lease_expires_at > ?
      `).run(
        leaseExpiresAt, channel, conversationKey, runId,
        lease.workerInstanceId, now
      );
      if (result.changes !== 1) return null;
      return {
        workerInstanceId: lease.workerInstanceId,
        leaseExpiresAt
      };
    });
  }

  /** Durable ownership assertion used before model-side effects and provider I/O. */
  async assertRunLease(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease
  ): Promise<ConversationRunLease> {
    return this.readRunLease(channel, conversationKey, runId, lease);
  }

  async claimSteeringMessages(channel: TaskChannel, conversationKey: string, runId: string): Promise<TaskLedgerMessage[]> {
    return this.db.mutate<TaskLedgerMessage[]>((db) => {
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      if (!conversation || conversation.status !== "running" || conversation.activeRunId !== runId) return [];
      if (!conversation.runs.some((run) => run.id === runId && run.status === "running")) return [];

      const messages = conversation.messages
        .filter(isActionablePendingMessage)
        .sort((left, right) => left.seq - right.seq);
      if (messages.length === 0) return [];

      const updateMessage = db.prepare(`
        UPDATE messages SET run_id = ?
        WHERE channel = ? AND conversation_key = ? AND id = ? AND run_id IS NULL
      `);
      const claimed: TaskLedgerMessage[] = [];
      for (const message of messages) {
        updateMessage.run(runId, channel, conversationKey, message.id);
        claimed.push({ ...message, runId });
      }

      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        runId,
        kind: "steering_claimed",
        metadata: { messageIds: claimed.map((message) => message.id) }
      });

      return claimed.map(cloneMessage);
    });
  }

  async finishRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    status: Exclude<TaskRunStatus, "running">,
    error?: string | null
  ): Promise<TaskLedgerFinishRunResult | null> {
    return this.db.mutate<TaskLedgerFinishRunResult | null>((db) => {
      return this.finishRunInDb(db, channel, conversationKey, runId, status, error);
    });
  }

  async stopConversation(
    channel: TaskChannel,
    conversationKey: string,
    reason?: string | null
  ): Promise<TaskLedgerConversation | null> {
    return this.db.mutate<TaskLedgerConversation | null>((db) => this.stopConversationInDb(db, channel, conversationKey, reason));
  }

  private stopConversationInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    reason?: string | null
  ): TaskLedgerConversation | null {
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      if (!conversation) return null;
      if (conversation.status === "stopped") return cloneConversation(conversation);
      const updatedAt = this.db.isoNow();
      const cancellationReason = reason ?? "stopped";
      this.hooks.onConversationStopped?.(db, conversation.id, cancellationReason, updatedAt);
      const hasDispatchInFlight = isCommunicationChannel(channel) && db.prepare(`
        SELECT 1 FROM outbound_deliveries
        WHERE channel = ? AND conversation_key = ? AND status = 'dispatching' AND error = ?
        LIMIT 1
      `).get(channel, conversationKey, providerCallAdmissionMarker) != null;
      if (hasDispatchInFlight) {
        // SQLite is the cross-process stop fence. The request is persisted
        // before this transaction commits, so an adapter in another process
        // cannot pass a later dispatch check. Terminal cancellation waits for
        // the sole admitted provider call to resolve; otherwise a provider
        // effect could occur after a recorded terminal stop.
        db.prepare(`
          UPDATE conversations
          SET metadata_json = ?, updated_at = ?, last_error = ?
          WHERE channel = ? AND conversation_key = ?
        `).run(
          jsonString(withStopRequested(conversation.metadata, cancellationReason, updatedAt)),
          updatedAt,
          cancellationReason,
          channel,
          conversationKey
        );
        this.cancelPendingMessagesInDb(db, channel, conversationKey, cancellationReason);
        const cancelledDeliveryIds = this.cancelRecoverableOutboundDeliveriesInDb(
        db, channel, conversationKey, cancellationReason, updatedAt, false
        );
        this.appendLifecycleEvent(db, {
          channel, conversationKey, runId: conversation.activeRunId, kind: "cancelled", reason: cancellationReason,
          metadata: { policy: "stop_requested_waiting_for_dispatch", cancelledDeliveryIds }
        });
        return this.requireConversationInDb(db, channel, conversationKey);
      }
      if (conversation.activeRunId) {
        const lastConsumedSeq = this.maxConsumedSeqForRun(db, channel, conversationKey, conversation.activeRunId);
        db.prepare(`
          UPDATE runs
          SET status = 'stopped', finished_at = ?, error = ?, last_consumed_seq = ?
          WHERE channel = ? AND conversation_key = ? AND id = ? AND status = 'running'
        `).run(updatedAt, cancellationReason, lastConsumedSeq, channel, conversationKey, conversation.activeRunId);
      }
      this.cancelPendingMessagesInDb(db, channel, conversationKey, cancellationReason);
      const cancelledDeliveryIds = this.cancelRecoverableOutboundDeliveriesInDb(
        db,
        channel,
        conversationKey,
        cancellationReason,
        updatedAt
      );
      db.prepare(`
        UPDATE conversations SET status = ?, updated_at = ?, last_error = ?, active_run_id = ?
        WHERE channel = ? AND conversation_key = ?
      `).run(
        "stopped",
        updatedAt,
        cancellationReason,
        null,
        channel,
        conversationKey
      );
      const updated = this.requireConversationInDb(db, channel, conversationKey);
      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        runId: conversation.activeRunId,
        kind: "stopped",
        reason: cancellationReason,
        metadata: { status: "stopped", cancelledDeliveryIds }
      });
      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        kind: "cancelled",
        reason: cancellationReason,
        metadata: {
          policy: "cancel_all_pending_messages_and_undelivered_intents",
          cancelledDeliveryIds
        }
      });
      for (const deliveryId of cancelledDeliveryIds) {
        this.appendLifecycleEvent(db, {
          channel,
          conversationKey,
          kind: "cancelled",
          reason: cancellationReason,
          metadata: { deliveryId, kind: "outbound_delivery" }
        });
      }
      return updated;
  }

  async setConversationStatus(
    channel: TaskChannel,
    conversationKey: string,
    status: TaskConversationStatus,
    error?: string | null
  ): Promise<TaskLedgerConversation | null> {
    if (status !== "stopped") {
      throw new Error("Direct conversation status transitions are not supported; use engine lifecycle operations");
    }
    return this.stopConversation(channel, conversationKey, error);
  }

  async markMessagesNonActionable(
    channel: TaskChannel,
    conversationKey: string,
    messageIds: string[]
  ): Promise<TaskLedgerConversation | null> {
    return this.db.mutate<TaskLedgerConversation | null>((db) => {
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      if (!conversation) return null;
      const idSet = new Set(messageIds);
      const update = db.prepare(`
        UPDATE messages SET metadata_json = ?
        WHERE channel = ? AND conversation_key = ? AND id = ?
      `);
      for (const message of conversation.messages) {
        if (!idSet.has(message.id)) continue;
        const metadata = { ...message.metadata, nonActionable: true };
        update.run(jsonString(metadata), channel, conversationKey, message.id);
      }
      const updatedAt = this.db.isoNow();
      const hasActionablePending = this.countPendingMessages(db, channel, conversationKey) > 0;
      if (conversation.status === "queued" && !hasActionablePending) {
        db.prepare(`
          UPDATE conversations SET status = 'done', updated_at = ?, last_error = NULL
          WHERE channel = ? AND conversation_key = ?
        `).run(updatedAt, channel, conversationKey);
      } else {
        db.prepare(`
          UPDATE conversations SET updated_at = ? WHERE channel = ? AND conversation_key = ?
        `).run(updatedAt, channel, conversationKey);
      }
      return this.requireConversationInDb(db, channel, conversationKey);
    });
  }

  /** Persist a deployment checkpoint for the active run at a safe turn boundary.
   *  The run's messages become pending again so the conversation is re-queued
   *  and resumes after the deployment restart. */
  async checkpointRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    reason = "checkpointed_for_deployment"
  ): Promise<TaskLedgerConversation | null> {
    return this.db.mutate<TaskLedgerConversation | null>((db) => {
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      const run = conversation?.runs.find((candidate) => candidate.id === runId);
      if (!conversation || !run) return null;
      if (conversation.activeRunId !== runId || run.status !== "running") {
        return cloneConversation(conversation);
      }
      const checkpointedAt = this.db.isoNow();
      db.prepare(`
        UPDATE runs SET status = 'interrupted', finished_at = ?, error = ?
        WHERE channel = ? AND conversation_key = ? AND id = ?
      `).run(checkpointedAt, requireNonEmptyText(reason, "checkpoint reason"), channel, conversationKey, runId);
      const hasPendingDelivery = isCommunicationChannel(channel) && db.prepare(`
      SELECT 1 FROM outbound_deliveries WHERE run_id = ? AND status IN ('pending', 'dispatching', 'acceptance_unknown') LIMIT 1
      `).get(runId) != null;
      if (!hasPendingDelivery) {
        db.prepare(`
          UPDATE messages SET run_id = NULL
          WHERE channel = ? AND conversation_key = ? AND run_id = ?
        `).run(channel, conversationKey, runId);
      }
      db.prepare(`
        UPDATE conversations
        SET status = 'queued', updated_at = ?, last_error = ?, active_run_id = NULL
        WHERE channel = ? AND conversation_key = ?
      `).run(checkpointedAt, reason, channel, conversationKey);
      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        runId,
        kind: "checkpointed",
        reason,
        metadata: { pendingDelivery: hasPendingDelivery }
      });
      return this.requireConversationInDb(db, channel, conversationKey);
    });
  }

  async recoverInterruptedRuns(channel: TaskChannel, workerInstanceId?: string): Promise<TaskLedgerRecoveryResult> {
    return this.db.mutate<TaskLedgerRecoveryResult>((db) => {
      const recoveredKeys: string[] = [];
      const runnableKeys: string[] = [];
      const recoveredAt = this.db.isoNow();
      const conversations = this.allConversationsInDb(db, channel);

      for (const conversation of conversations) {
        // Stop is terminal for all work that has not reached provider acceptance.
        // In particular, recovery must never turn a stopped conversation back
        // into a runnable delivery retry.
        if (conversation.status === "stopped") continue;
        if (conversationStopRequested(conversation)) {
          // A process which requested stop may have died while a dispatch was
          // in flight. No live run owner means the provider call cannot still
          // be executing, so cancel the revocable intent and make stop final.
          const hasLiveOwner = conversation.runs.some((run) => this.hasLiveRunLease(run, recoveredAt, workerInstanceId));
          if (!hasLiveOwner && isCommunicationChannel(channel)) {
            this.cancelRecoverableOutboundDeliveriesInDb(db, channel, conversation.conversationKey,
              stopRequestedReason(conversation) ?? "stopped", recoveredAt);
            this.finalizeRequestedStopInDb(db, channel, conversation.conversationKey);
          }
          continue;
        }
        // An unexpired durable lease held by another worker is the recovery
        // fence. PID liveness is intentionally not consulted so this has
        // identical semantics across hosts. A lease held by the recovering
        // worker itself is always reclaimable: this process cannot be running
        // that work, so a restart inside the lease window recovers immediately.
        const hasLiveOwner = conversation.runs.some(
          (run) => this.hasLiveRunLease(run, recoveredAt, workerInstanceId)
        );
        if (hasLiveOwner) continue;
        const staleRunIds = conversation.runs
          .filter((run) => run.status === "running" && !this.hasLiveRunLease(run, recoveredAt, workerInstanceId))
          .map((run) => run.id);
        const recovered = staleRunIds.length > 0;

        if (recovered) {
          const interruptRun = db.prepare(`
            UPDATE runs
            SET status = 'interrupted', finished_at = ?, error = ?
            WHERE channel = ? AND conversation_key = ? AND id = ? AND status = 'running'
          `);
          for (const runId of staleRunIds) {
            interruptRun.run(recoveredAt, "Channel bridge restarted while this run was active.", channel, conversation.conversationKey, runId);
          }

          const clearRun = db.prepare(`
            UPDATE messages
            SET run_id = NULL
            WHERE channel = ? AND conversation_key = ? AND run_id = ?
          `);
          for (const runId of staleRunIds) {
            const hasPendingDelivery = isCommunicationChannel(channel) && db.prepare(`
              SELECT 1 FROM outbound_deliveries WHERE run_id = ? AND status IN ('pending', 'dispatching', 'acceptance_unknown') LIMIT 1
            `).get(runId) != null;
            if (hasPendingDelivery) continue;
            clearRun.run(channel, conversation.conversationKey, runId);
          }

          db.prepare(`
            UPDATE conversations
            SET status = 'queued', updated_at = ?, last_error = ?, active_run_id = NULL
            WHERE channel = ? AND conversation_key = ?
          `).run(recoveredAt, "interrupted_by_restart", channel, conversation.conversationKey);
          for (const runId of staleRunIds) {
            this.appendLifecycleEvent(db, {
              channel,
              conversationKey: conversation.conversationKey,
              runId,
              kind: "recovered",
              reason: "interrupted_by_restart",
              metadata: { priorWorkerInstanceId: conversation.runs.find((run) => run.id === runId)?.workerInstanceId ?? null }
            });
          }
          recoveredKeys.push(conversation.conversationKey);
        }

        const hasRecoverableDelivery = isCommunicationChannel(channel)
          && this.recoverableOutboundDeliveryInDb(db, channel, conversation.conversationKey) != null;
        const hasPendingMessages = recovered || this.countPendingMessages(db, channel, conversation.conversationKey) > 0;
        if (!recovered && hasRecoverableDelivery && conversation.status !== "queued") {
          db.prepare(`
            UPDATE conversations
            SET status = 'queued', updated_at = ?, active_run_id = NULL
            WHERE channel = ? AND conversation_key = ?
          `).run(recoveredAt, channel, conversation.conversationKey);
        }
        const finalStatus = recovered || hasRecoverableDelivery ? "queued" : conversation.status;
        if (finalStatus === "queued" && (hasPendingMessages || hasRecoverableDelivery)) runnableKeys.push(conversation.conversationKey);
      }

      return { recoveredKeys, runnableKeys };
    });
  }

  async runnableConversations(channel: TaskChannel): Promise<TaskLedgerConversation[]> {
    const db = this.db.ensureDb();
    const rows = runtimeRecordArray(db.prepare(`
      SELECT ${conversationColumns()}
      FROM conversations
      WHERE channel = ?
        AND status = 'queued'
        AND COALESCE(json_extract(metadata_json, '$.__engineStopRequested'), 0) != 1
        AND (
          EXISTS (
            SELECT 1 FROM messages
            WHERE messages.channel = conversations.channel
              AND messages.conversation_key = conversations.conversation_key
              AND messages.run_id IS NULL
              AND messages.role = 'user'
              AND COALESCE(json_extract(messages.metadata_json, '$.nonActionable'), 0) != 1
          )
          OR EXISTS (
            SELECT 1 FROM outbound_deliveries
            WHERE outbound_deliveries.channel = conversations.channel
              AND outbound_deliveries.conversation_key = conversations.conversation_key
              AND outbound_deliveries.status IN ('pending', 'dispatching', 'acceptance_unknown', 'failed')
          )
        )
      ORDER BY updated_at ASC, created_at ASC
    `).all(channel), "runnable conversation rows").map((row) => conversationRowFromSql(row, "runnable conversation row"));
    return rows.map((row) => this.conversationFromRow(db, row)).map(cloneConversation);
  }

  async getConversation(channel: TaskChannel, conversationKey: string): Promise<TaskLedgerConversation | null> {
    const conversation = this.getConversationInDb(this.db.ensureDb(), channel, conversationKey);
    return conversation ? cloneConversation(conversation) : null;
  }

  async conversations(channel: TaskChannel): Promise<TaskLedgerConversation[]> {
    return this.allConversationsInDb(this.db.ensureDb(), channel).map(cloneConversation);
  }

  async migrateConversationKey(
    channel: TaskChannel,
    legacyKey: string,
    canonicalKey: string
  ): Promise<TaskLedgerConversation | null> {
    return this.db.mutate<TaskLedgerConversation | null>((db) => {
      const legacy = this.getConversationInDb(db, channel, legacyKey);
      if (!legacy) return null;
      if (legacyKey === canonicalKey) return cloneConversation(legacy);
      if (legacy.status === "running" || legacy.activeRunId) {
        throw new Error(`Cannot migrate active conversation ${channel}:${legacyKey}`);
      }
      if (isCommunicationChannel(channel) && this.pendingOutboundDeliveryInDb(db, channel, legacyKey)) {
        throw new Error(`Cannot migrate conversation ${channel}:${legacyKey} with a pending outbound delivery`);
      }
      const canonical = this.getConversationInDb(db, channel, canonicalKey);
      if (!canonical) {
        db.prepare(`
          INSERT INTO conversations (
            channel, conversation_key, id, title, status, created_at, updated_at, last_error,
            reply_target_json, metadata_json, active_run_id, compaction_seq, compaction_summary
          )
          SELECT
            channel, ?, id, title, status, created_at, updated_at, last_error,
            reply_target_json, metadata_json, active_run_id, compaction_seq, compaction_summary
          FROM conversations
          WHERE channel = ? AND conversation_key = ?
        `).run(canonicalKey, channel, legacyKey);
        db.prepare("UPDATE messages SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
          .run(canonicalKey, channel, legacyKey);
        db.prepare("UPDATE runs SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
          .run(canonicalKey, channel, legacyKey);
        if (isCommunicationChannel(channel)) {
          db.prepare("UPDATE outbound_deliveries SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
            .run(canonicalKey, channel, legacyKey);
        }
      } else {
        const canonicalMaxSeq = this.maxMessageSeq(db, channel, canonicalKey);
        db.prepare(`
          UPDATE messages
          SET conversation_key = ?, seq = seq + ?
          WHERE channel = ? AND conversation_key = ?
        `).run(canonicalKey, canonicalMaxSeq, channel, legacyKey);
        db.prepare(`
          UPDATE runs
          SET conversation_key = ?,
              last_consumed_seq = CASE
                WHEN last_consumed_seq IS NULL THEN NULL
                ELSE last_consumed_seq + ?
              END
          WHERE channel = ? AND conversation_key = ?
        `).run(canonicalKey, canonicalMaxSeq, channel, legacyKey);
        if (isCommunicationChannel(channel)) {
          db.prepare("UPDATE outbound_deliveries SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
            .run(canonicalKey, channel, legacyKey);
        }
        db.prepare(`
          UPDATE conversations
          SET updated_at = ?, metadata_json = ?
          WHERE channel = ? AND conversation_key = ?
        `).run(
          this.db.isoNow(),
          jsonString(mergeMigratedConversationMetadata(canonical.metadata, legacy)),
          channel,
          canonicalKey
        );
      }
      this.hooks.onConversationKeyMigrated?.(db, {
        channel,
        legacyKey,
        canonicalKey,
        legacyConversationId: legacy.id,
        canonicalConversationId: canonical?.id ?? null
      });
      db.prepare("DELETE FROM conversations WHERE channel = ? AND conversation_key = ?")
        .run(channel, legacyKey);
      return this.requireConversationInDb(db, channel, canonicalKey);
    });
  }

  async compact(
    channel: TaskChannel,
    conversationKey: string,
    summary: string,
    upToSeq: number
  ): Promise<TaskLedgerConversation | null> {
    return this.db.mutate<TaskLedgerConversation | null>((db) => {
      const conversation = this.getConversationInDb(db, channel, conversationKey);
      if (!conversation) return null;
      const maxDoneRow = db.prepare(`
        SELECT MAX(last_consumed_seq) AS maxDone
        FROM runs WHERE channel = ? AND conversation_key = ? AND status = 'done'
      `).get(channel, conversationKey);
      const maxDone = maxDoneRow == null ? null
        : nullableNumberField(
            requireRuntimeRecord(maxDoneRow, `max done seq for ${channel}:${conversationKey}`),
            "maxDone",
            `max done seq for ${channel}:${conversationKey}`
          );
      if (maxDone === null) {
        throw new Error(`Cannot compact ${channel}:${conversationKey}: no completed runs`);
      }
      if (upToSeq > maxDone) {
        throw new Error(
          `Cannot compact ${channel}:${conversationKey} up to seq ${upToSeq}: last done run consumed up to seq ${maxDone}`
        );
      }
      if (conversation.compactionSeq != null && upToSeq < conversation.compactionSeq) {
        throw new Error(
          `Cannot compact ${channel}:${conversationKey} up to seq ${upToSeq}: compaction already covers seq ${conversation.compactionSeq}`
        );
      }
      db.prepare(`
        UPDATE conversations SET compaction_seq = ?, compaction_summary = ?, updated_at = ?
        WHERE channel = ? AND conversation_key = ?
      `).run(upToSeq, summary, this.db.isoNow(), channel, conversationKey);
      this.appendLifecycleEvent(db, {
        channel,
        conversationKey,
        kind: "compacted",
        metadata: { upToSeq, summaryChars: summary.length }
      });
      return this.requireConversationInDb(db, channel, conversationKey);
    });
  }

  async buildContext(channel: TaskChannel, conversationKey: string): Promise<ConversationContext | null> {
    const db = this.db.ensureDb();
    const conversation = this.getConversationInDb(db, channel, conversationKey);
    if (!conversation) return null;
    const recentUserMessages = conversation.compactionSeq == null
      ? []
      : this.recentUserMessagesBeforeCheckpoint(db, channel, conversationKey, conversation.compactionSeq);
    const rows = runtimeRecordArray(db.prepare(`
      SELECT id, seq, role, external_message_id AS externalMessageId, author_id AS authorId, text,
        received_at AS receivedAt, run_id AS runId, metadata_json AS metadataJson
      FROM messages
      WHERE channel = ? AND conversation_key = ? AND seq > COALESCE(?, 0)
      ORDER BY seq ASC
    `).all(channel, conversationKey, conversation.compactionSeq), `context messages for ${channel}:${conversationKey}`)
      .map((row) => messageRowFromSql(row, `context message for ${channel}:${conversationKey}`));
    return {
      summary: conversation.compactionSummary,
      recentUserMessages,
      messages: rows.map(messageFromRow)
    };
  }

  getConversationInDb(db: DatabaseSync, channel: TaskChannel, conversationKey: string): TaskLedgerConversation | null {
    const row = optionalConversationRowFromSql(db.prepare(`
      SELECT ${conversationColumns()} FROM conversations WHERE channel = ? AND conversation_key = ?
    `).get(channel, conversationKey), "conversation row");
    return row ? this.conversationFromRow(db, row) : null;
  }

  private conversationByIdInDb(db: DatabaseSync, conversationId: string): TaskLedgerConversation | null {
    const row = optionalConversationRowFromSql(db.prepare(`
      SELECT ${conversationColumns()} FROM conversations WHERE id = ?
    `).get(conversationId), "conversation by id row");
    return row ? this.conversationFromRow(db, row) : null;
  }

  finishRunInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    status: Exclude<TaskRunStatus, "running">,
    error: string | null | undefined
  ): TaskLedgerFinishRunResult | null {
    const conversation = this.getConversationInDb(db, channel, conversationKey);
    const run = conversation?.runs.find((candidate) => candidate.id === runId);
    if (!conversation || !run) return null;
    if (conversation.activeRunId !== runId || run.status !== "running") {
      return {
        conversation: cloneConversation(conversation),
        hasPendingMessages: this.countPendingMessages(db, channel, conversationKey) > 0
      };
    }
    const finishedAt = this.db.isoNow();
    const lastConsumedSeq = this.maxConsumedSeqForRun(db, channel, conversationKey, runId);
    db.prepare(`
      UPDATE runs SET status = ?, finished_at = ?, error = ?, last_consumed_seq = ?
      WHERE channel = ? AND conversation_key = ? AND id = ?
    `).run(status, finishedAt, error ?? null, lastConsumedSeq, channel, conversationKey, runId);
    const hasPendingMessages = this.countPendingMessages(db, channel, conversationKey) > 0;
    const nextStatus: TaskConversationStatus = status === "done"
      ? hasPendingMessages ? "queued" : "done"
      : hasPendingMessages ? "queued" : status === "stopped" ? "stopped" : "failed";
    const nextError = status === "done" ? null : error ?? status;
    db.prepare(`
      UPDATE conversations SET status = ?, updated_at = ?, last_error = ?, active_run_id = NULL
      WHERE channel = ? AND conversation_key = ?
    `).run(nextStatus, finishedAt, nextError, channel, conversationKey);
    this.appendLifecycleEvent(db, {
      channel,
      conversationKey,
      runId,
      kind: status === "done" ? "completed" : status === "stopped" ? "stopped" : "failed",
      reason: status === "done" ? null : error ?? status,
      metadata: { status, hasPendingMessages, nextStatus }
    });
    return { conversation: this.requireConversationInDb(db, channel, conversationKey), hasPendingMessages };
  }

  /** Complete a previously persisted stop request once dispatch is no longer in flight. */
  private finalizeRequestedStopInDb(db: DatabaseSync, channel: TaskChannel, conversationKey: string): TaskLedgerConversation | null {
    const conversation = this.getConversationInDb(db, channel, conversationKey);
    if (!conversation || !conversationStopRequested(conversation) || conversation.status === "stopped") return conversation;
    const dispatching = isCommunicationChannel(channel) && db.prepare(`
      SELECT 1 FROM outbound_deliveries
      WHERE channel = ? AND conversation_key = ? AND status = 'dispatching' LIMIT 1
    `).get(channel, conversationKey) != null;
    if (dispatching) return conversation;
    return this.stopConversationInDb(db, channel, conversationKey, stopRequestedReason(conversation) ?? "stopped");
  }

  /** Stop is a full cancellation boundary: unclaimed work never replays later. */
  private cancelPendingMessagesInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    reason: string
  ): void {
    const conversation = this.requireConversationInDb(db, channel, conversationKey);
    const update = db.prepare(`
      UPDATE messages SET metadata_json = ?
      WHERE channel = ? AND conversation_key = ? AND id = ? AND run_id IS NULL
    `);
    for (const message of conversation.messages) {
      if (!isActionablePendingMessage(message)) continue;
      update.run(
        jsonString({ ...message.metadata, nonActionable: true, cancellationReason: reason }),
        channel,
        conversationKey,
        message.id
      );
    }
  }

  /** A stopped conversation must never recover an undelivered provider intent. */
  private cancelRecoverableOutboundDeliveriesInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    reason: string,
    updatedAt: string,
    includeDispatching = true
  ): string[] {
    if (!isCommunicationChannel(channel)) return [];
    const rows = runtimeRecordArray(db.prepare(`
      SELECT id FROM outbound_deliveries
      WHERE channel = ? AND conversation_key = ? AND status IN ('pending', 'failed', 'acceptance_unknown'${includeDispatching ? ", 'dispatching'" : ""})
        AND COALESCE(json_extract(payload_json, '$.__runtimeControlDelivery'), 0) != 1
        ${includeDispatching ? "" : "AND (status != 'dispatching' OR error != '" + providerCallAdmissionMarker + "')"}
      ORDER BY created_at ASC, id ASC
    `).all(channel, conversationKey), `recoverable deliveries for stopped ${channel}:${conversationKey}`);
    const deliveryIds = rows.map((row) => requiredStringField(row, "id", "recoverable delivery row"));
    if (deliveryIds.length === 0) return deliveryIds;
    const cancel = db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'cancelled', error = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'failed', 'acceptance_unknown'${includeDispatching ? ", 'dispatching'" : ""})
        ${includeDispatching ? "" : "AND (status != 'dispatching' OR error != '" + providerCallAdmissionMarker + "')"}
    `);
    for (const deliveryId of deliveryIds) cancel.run(reason, updatedAt, deliveryId);
    return deliveryIds;
  }

  private newRunLeaseInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    input?: ConversationRunLeaseInput
  ): ConversationRunLease {
    const workerInstanceId = requireNonEmptyText(
      input?.workerInstanceId ?? this.defaultRunWorkerInstanceId,
      "run lease worker instance id"
    );
    const leaseDurationMs = requirePositiveSafeInteger(
      input?.leaseDurationMs ?? this.defaultRunLeaseDurationMs,
      "run lease duration"
    );
    const leaseExpiresAt = new Date(this.db.nowDate().getTime() + leaseDurationMs).toISOString();
    return { workerInstanceId, leaseExpiresAt };
  }

  private readRunLease(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease
  ): ConversationRunLease {
    const db = this.db.ensureDb();
    const row = optionalRunRowFromSql(db.prepare(`
      SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, error,
        last_consumed_seq AS lastConsumedSeq, worker_instance_id AS workerInstanceId,
        lease_expires_at AS leaseExpiresAt
      FROM runs WHERE channel = ? AND conversation_key = ? AND id = ?
    `).get(channel, conversationKey, runId), `run lease ${channel}:${conversationKey}:${runId}`);
    const run = row ? runFromRow(row, []) : null;
    if (!run || !this.runLeaseMatches(run, lease, this.db.isoNow())) {
      throw new Error(`Run lease is no longer owned for ${channel}:${conversationKey}:${runId}`);
    }
    return {
      workerInstanceId: lease.workerInstanceId,
      leaseExpiresAt: run.leaseExpiresAt!
    };
  }

  private assertRunLeaseInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease | undefined
  ): void {
    if (!lease) return;
    const row = optionalRunRowFromSql(db.prepare(`
      SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, error,
        last_consumed_seq AS lastConsumedSeq, worker_instance_id AS workerInstanceId,
        lease_expires_at AS leaseExpiresAt
      FROM runs WHERE channel = ? AND conversation_key = ? AND id = ?
    `).get(channel, conversationKey, runId), `run lease ${channel}:${conversationKey}:${runId}`);
    const run = row ? runFromRow(row, []) : null;
    if (!run || !this.runLeaseMatches(run, lease, this.db.isoNow())) {
      throw new Error(`Run lease is no longer owned for ${channel}:${conversationKey}:${runId}`);
    }
  }

  private runLeaseMatches(run: TaskLedgerRun, lease: ConversationRunLease, now: string): boolean {
    return run.status === "running"
      && run.workerInstanceId === lease.workerInstanceId
      && run.leaseExpiresAt != null
      && run.leaseExpiresAt > now;
  }

  private hasLiveRunLease(run: TaskLedgerRun, now: string, selfWorkerInstanceId?: string): boolean {
    if (run.status !== "running" || run.leaseExpiresAt == null || run.leaseExpiresAt <= now) return false;
    return selfWorkerInstanceId == null || run.workerInstanceId !== selfWorkerInstanceId;
  }

  private allConversationsInDb(db: DatabaseSync, channel: TaskChannel): TaskLedgerConversation[] {
    const rows = runtimeRecordArray(db.prepare(`
      SELECT ${conversationColumns()}
      FROM conversations
      WHERE channel = ?
      ORDER BY updated_at ASC, created_at ASC
    `).all(channel), `conversation rows for ${channel}`).map((row) => conversationRowFromSql(row, `conversation row for ${channel}`));
    return rows.map((row) => this.conversationFromRow(db, row));
  }

  requireConversationInDb(db: DatabaseSync, channel: TaskChannel, conversationKey: string): TaskLedgerConversation {
    const conversation = this.getConversationInDb(db, channel, conversationKey);
    if (!conversation) throw new Error(`Task conversation disappeared from SQLite store: ${channel}:${conversationKey}`);
    return conversation;
  }

  private conversationFromRow(db: DatabaseSync, row: ConversationRow): TaskLedgerConversation {
    const messages = runtimeRecordArray(db.prepare(`
      SELECT id, seq, role, external_message_id AS externalMessageId, author_id AS authorId, text,
        received_at AS receivedAt, run_id AS runId, metadata_json AS metadataJson
      FROM messages WHERE channel = ? AND conversation_key = ? ORDER BY seq ASC, id ASC
    `).all(row.channel, row.conversationKey), `message rows for ${row.channel}:${row.conversationKey}`)
      .map((messageRow) => messageRowFromSql(messageRow, `message row for ${row.channel}:${row.conversationKey}`));
    const runs = runtimeRecordArray(db.prepare(`
      SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, error,
        last_consumed_seq AS lastConsumedSeq, worker_instance_id AS workerInstanceId,
        lease_expires_at AS leaseExpiresAt
      FROM runs WHERE channel = ? AND conversation_key = ? ORDER BY started_at ASC, id ASC
    `).all(row.channel, row.conversationKey), `run rows for ${row.channel}:${row.conversationKey}`)
      .map((runRow) => runRowFromSql(runRow, `run row for ${row.channel}:${row.conversationKey}`));
    return {
      id: row.id,
      channel: row.channel,
      conversationKey: row.conversationKey,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastError: row.lastError,
      replyTarget: parseJsonObjectOrNull(row.replyTargetJson, `reply target for ${row.channel}:${row.conversationKey}`),
      metadata: parseJsonObject(row.metadataJson, `metadata for ${row.channel}:${row.conversationKey}`),
      activeRunId: row.activeRunId,
      compactionSeq: row.compactionSeq,
      compactionSummary: row.compactionSummary,
      messages: messages.map(messageFromRow),
      runs: runs.map((run) => runFromRow(run, messages))
    };
  }

  private getMessageByExternalIdInDb(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    externalMessageId: string
  ): TaskLedgerMessage | null {
    const row = optionalMessageRowFromSql(db.prepare(`
      SELECT id, seq, role, external_message_id AS externalMessageId, author_id AS authorId, text,
        received_at AS receivedAt, run_id AS runId, metadata_json AS metadataJson
      FROM messages WHERE channel = ? AND conversation_key = ? AND external_message_id = ?
    `).get(channel, conversationKey, externalMessageId), "duplicate message row");
    return row ? messageFromRow(row) : null;
  }

  private insertConversation(db: DatabaseSync, conversation: TaskLedgerConversation): void {
    db.prepare(`
      INSERT INTO conversations (
        channel, conversation_key, id, title, status, created_at, updated_at, last_error,
        reply_target_json, metadata_json, active_run_id, compaction_seq, compaction_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.channel,
      conversation.conversationKey,
      conversation.id,
      conversation.title,
      conversation.status,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.lastError,
      jsonString(conversation.replyTarget),
      jsonString(conversation.metadata),
      conversation.activeRunId,
      conversation.compactionSeq,
      conversation.compactionSummary
    );
  }

  private insertMessage(db: DatabaseSync, channel: TaskChannel, conversationKey: string, message: TaskLedgerMessage): void {
    db.prepare(`
      INSERT INTO messages (
        id, channel, conversation_key, external_message_id, author_id, text, received_at, run_id,
        seq, role, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      channel,
      conversationKey,
      message.externalMessageId,
      message.authorId,
      message.text,
      message.receivedAt,
      message.runId,
      message.seq,
      message.role,
      jsonString(message.metadata)
    );
  }

  private recordAssistantMessageInDb(
    db: DatabaseSync,
    input: TaskLedgerAssistantMessageInput,
    allowStoppedDispatchConfirmation = false
  ): TaskLedgerMessage | null {
    const conversation = this.getConversationInDb(db, input.channel, input.conversationKey);
    if (!conversation) return null;
    if (input.runId) {
      const run = conversation.runs.find((candidate) => candidate.id === input.runId);
      const activeRun = conversation.activeRunId === input.runId && run?.status === "running";
      const stoppedDispatch = allowStoppedDispatchConfirmation
        && conversation.status === "stopped"
        && run?.status === "stopped";
      if (!activeRun && !stoppedDispatch) return null;
    }
    const receivedAt = input.receivedAt ?? this.db.isoNow();
    const message: TaskLedgerMessage = {
      id: this.db.newId(),
      seq: this.nextMessageSeq(db, input.channel, input.conversationKey),
      role: "assistant",
      externalMessageId: input.externalMessageId ?? null,
      authorId: input.authorId ?? null,
      text: input.text,
      receivedAt,
      runId: input.runId ?? null,
      metadata: input.metadata ?? {}
    };
    this.insertMessage(db, input.channel, input.conversationKey, message);
    db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE channel = ? AND conversation_key = ?
    `).run(receivedAt, input.channel, input.conversationKey);
    return message;
  }

  private outboundDeliveryByProviderKeyInDb(
    db: DatabaseSync,
    provider: string,
    idempotencyKey: string
  ): OutboundDelivery | null {
    const row = optionalOutboundDeliveryRowFromSql(db.prepare(`
      SELECT ${outboundDeliveryColumns()}
      FROM outbound_deliveries
      WHERE provider = ? AND idempotency_key = ?
    `).get(provider, idempotencyKey), `outbound delivery ${provider}:${idempotencyKey}`);
    return row ? outboundDeliveryFromRow(row) : null;
  }

  private pendingOutboundDeliveryInDb(
    db: DatabaseSync,
    channel: CommunicationChannel,
    conversationKey: string
  ): OutboundDelivery | null {
    const row = optionalOutboundDeliveryRowFromSql(db.prepare(`
      SELECT ${outboundDeliveryColumns()}
      FROM outbound_deliveries
      WHERE channel = ? AND conversation_key = ? AND status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(channel, conversationKey), `pending outbound delivery for ${channel}:${conversationKey}`);
    return row ? outboundDeliveryFromRow(row) : null;
  }

  private recoverableOutboundDeliveryInDb(
    db: DatabaseSync,
    channel: CommunicationChannel,
    conversationKey: string
  ): OutboundDelivery | null {
    const row = optionalOutboundDeliveryRowFromSql(db.prepare(`
      SELECT ${outboundDeliveryColumns()}
      FROM outbound_deliveries
      WHERE channel = ? AND conversation_key = ? AND status IN ('pending', 'dispatching', 'acceptance_unknown', 'failed')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(channel, conversationKey), `recoverable outbound delivery for ${channel}:${conversationKey}`);
    return row ? outboundDeliveryFromRow(row) : null;
  }

  private outboundDeliveriesInDb(
    db: DatabaseSync,
    channel: CommunicationChannel,
    conversationKey: string
  ): OutboundDelivery[] {
    return runtimeRecordArray(db.prepare(`
      SELECT ${outboundDeliveryColumns()}
      FROM outbound_deliveries
      WHERE channel = ? AND conversation_key = ?
      ORDER BY created_at ASC, id ASC
    `).all(channel, conversationKey), `outbound deliveries for ${channel}:${conversationKey}`)
      .map((row) => outboundDeliveryRowFromSql(row, `outbound delivery for ${channel}:${conversationKey}`))
      .map(outboundDeliveryFromRow);
  }

  private requireOutboundDeliveryInDb(db: DatabaseSync, deliveryId: string): OutboundDelivery {
    const row = optionalOutboundDeliveryRowFromSql(db.prepare(`
      SELECT ${outboundDeliveryColumns()} FROM outbound_deliveries WHERE id = ?
    `).get(deliveryId), `outbound delivery ${deliveryId}`);
    if (!row) throw new Error(`Outbound delivery disappeared from SQLite store: ${deliveryId}`);
    return outboundDeliveryFromRow(row);
  }

  private insertOutboundDelivery(db: DatabaseSync, delivery: OutboundDelivery): void {
    db.prepare(`
      INSERT INTO outbound_deliveries (
        id, channel, conversation_key, run_id, provider, idempotency_key, status,
        payload_json, assistant_message_json, provider_receipt_json, error,
        attempt_count, attempted_at, acceptance_unknown_at, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id,
      delivery.channel,
      delivery.conversationKey,
      delivery.runId,
      delivery.provider,
      delivery.idempotencyKey,
      delivery.status,
      jsonString(delivery.payload),
      jsonString(outboundDeliveryAssistantMessageJson(delivery.assistantMessage)),
      delivery.providerReceipt ? jsonString(delivery.providerReceipt) : null,
      delivery.error,
      delivery.attemptCount,
      delivery.attemptedAt,
      delivery.acceptanceUnknownAt,
      delivery.deliveredAt,
      delivery.createdAt,
      delivery.updatedAt
    );
  }

  private updateOutboundDelivery(db: DatabaseSync, delivery: OutboundDelivery): void {
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = ?, provider_receipt_json = ?, error = ?, attempt_count = ?, attempted_at = ?,
          acceptance_unknown_at = ?, delivered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      delivery.status,
      delivery.providerReceipt ? jsonString(delivery.providerReceipt) : null,
      delivery.error,
      delivery.attemptCount,
      delivery.attemptedAt,
      delivery.acceptanceUnknownAt,
      delivery.deliveredAt,
      delivery.updatedAt,
      delivery.id
    );
  }

  private recentUserMessagesBeforeCheckpoint(
    db: DatabaseSync,
    channel: TaskChannel,
    conversationKey: string,
    compactionSeq: number
  ): TaskLedgerMessage[] {
    if (!isContextLimitChannel(channel)) return [];
    const tokenLimit = Math.max(0, Math.trunc(getChannelContextLimits(channel).recentUserMessageTokenLimit));
    if (tokenLimit === 0) return [];

    const rows = runtimeRecordArray(db.prepare(`
      SELECT id, seq, role, external_message_id AS externalMessageId, author_id AS authorId, text,
        received_at AS receivedAt, run_id AS runId, metadata_json AS metadataJson
      FROM messages
      WHERE channel = ? AND conversation_key = ? AND seq <= ? AND role = 'user'
      ORDER BY seq DESC
    `).all(channel, conversationKey, compactionSeq), `recent user messages for ${channel}:${conversationKey}`)
      .map((row) => messageRowFromSql(row, `recent user message for ${channel}:${conversationKey}`));

    const selected: TaskLedgerMessage[] = [];
    let usedTokens = 0;
    for (const row of rows) {
      const message = messageFromRow(row);
      // This is a durable retention limit, not prompt construction. Use the
      // same conservative upper bound so a very large Unicode/code message
      // cannot escape its configured retention cap before Runtime budgets it.
      const tokenCount = utf8TokenUpperBound(message.text);
      if (usedTokens + tokenCount > tokenLimit) continue;
      selected.push(message);
      usedTokens += tokenCount;
      if (usedTokens >= tokenLimit) break;
    }
    return selected.reverse();
  }

  insertRun(db: DatabaseSync, channel: TaskChannel, conversationKey: string, run: TaskLedgerRun): void {
    db.prepare(`
      INSERT INTO runs (
        id, channel, conversation_key, status, started_at, finished_at, error, last_consumed_seq,
        worker_instance_id, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, channel, conversationKey, run.status, run.startedAt, run.finishedAt, run.error, run.lastConsumedSeq,
      run.workerInstanceId ?? null, run.leaseExpiresAt ?? null
    );
  }

  private appendLifecycleEvent(
    db: DatabaseSync,
    input: {
      channel: TaskChannel;
      conversationKey: string;
      runId?: string | null;
      kind: LifecycleEventKind;
      reason?: string | null;
      metadata?: JsonObject;
    }
  ): void {
    const event: LifecycleEvent = {
      id: this.db.newId(),
      channel: input.channel,
      conversationKey: input.conversationKey,
      runId: input.runId ?? null,
      kind: input.kind,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      occurredAt: this.db.isoNow()
    };
    db.prepare(`
      INSERT INTO lifecycle_events (
        id, channel, conversation_key, run_id, kind, reason, metadata_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.channel, event.conversationKey, event.runId, event.kind,
      event.reason, jsonString(event.metadata), event.occurredAt
    );
  }

  private countPendingMessages(db: DatabaseSync, channel: TaskChannel, conversationKey: string): number {
    const row = optionalCountRowFromSql(db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE channel = ? AND conversation_key = ?
        AND run_id IS NULL
        AND role = 'user'
        AND COALESCE(json_extract(metadata_json, '$.nonActionable'), 0) != 1
    `).get(channel, conversationKey), `pending message count for ${channel}:${conversationKey}`);
    return row?.count ?? 0;
  }

  private nextMessageSeq(db: DatabaseSync, channel: TaskChannel, conversationKey: string): number {
    const row = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE channel = ? AND conversation_key = ?
    `).get(channel, conversationKey);
    if (row == null) return 1;
    const record = requireRuntimeRecord(row, `next seq row for ${channel}:${conversationKey}`);
    return requiredNumberField(record, "maxSeq", `next seq row for ${channel}:${conversationKey}`) + 1;
  }

  private maxMessageSeq(db: DatabaseSync, channel: TaskChannel, conversationKey: string): number {
    const row = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE channel = ? AND conversation_key = ?
    `).get(channel, conversationKey);
    if (row == null) return 0;
    return requiredNumberField(
      requireRuntimeRecord(row, `max seq row for ${channel}:${conversationKey}`),
      "maxSeq",
      `max seq row for ${channel}:${conversationKey}`
    );
  }

  private maxConsumedSeqForRun(db: DatabaseSync, channel: TaskChannel, conversationKey: string, runId: string): number | null {
    const row = db.prepare(`
      SELECT MAX(seq) AS maxConsumedSeq FROM messages WHERE channel = ? AND conversation_key = ? AND run_id = ?
    `).get(channel, conversationKey, runId);
    if (row == null) return null;
    return nullableNumberField(
      requireRuntimeRecord(row, `consumed seq for ${channel}:${conversationKey}`),
      "maxConsumedSeq",
      `consumed seq for ${channel}:${conversationKey}`
    );
  }
}

function conversationColumns(): string {
  return `
    id, channel, conversation_key AS conversationKey, title, status,
    created_at AS createdAt, updated_at AS updatedAt, last_error AS lastError,
    reply_target_json AS replyTargetJson, metadata_json AS metadataJson,
    active_run_id AS activeRunId, compaction_seq AS compactionSeq,
    compaction_summary AS compactionSummary
  `;
}


function outboundDeliveryColumns(): string {
  return `
    id,
    channel,
    conversation_key AS conversationKey,
    run_id AS runId,
    provider,
    idempotency_key AS idempotencyKey,
    status,
    payload_json AS payloadJson,
    assistant_message_json AS assistantMessageJson,
    provider_receipt_json AS providerReceiptJson,
    error,
    attempt_count AS attemptCount,
    attempted_at AS attemptedAt,
    acceptance_unknown_at AS acceptanceUnknownAt,
    delivered_at AS deliveredAt,
    created_at AS createdAt,
    updated_at AS updatedAt
  `;
}


function lifecycleEventColumns(): string {
  return `
    id, channel, conversation_key AS conversationKey, run_id AS runId, kind, reason,
    metadata_json AS metadataJson, occurred_at AS occurredAt
  `;
}


function titleFromText(text: string): string | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function isActionablePendingMessage(message: TaskLedgerMessage): boolean {
  return message.runId == null
    && message.role === "user"
    && message.metadata.nonActionable !== true;
}
