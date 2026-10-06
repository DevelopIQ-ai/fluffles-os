import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { LedgerDb } from "@fluffles/storage";
import { Clock } from "./clock";
import { nextCronRun } from "./cron";
import { redactCredentialHeaders, startHttpIngress, verifyHmacSha256, type Ingress, type IngressRequest, type IngressResponse } from "./ingress";
import { automationStateDir, loadRegistry, type LoadedAutomation, type RegistryLoad } from "./registry";
import { defaultStepExecutors, runSteps } from "./runner";
import { AUTOMATIONS_SCHEMA } from "./schema";
import { AutomationStore } from "./store";
import type { AutomationEvent, AutomationSpec, AutomationsConfig, AutomationsOptions, RunRecord, TriggerKind } from "./types";

export type { AutomationsConfig, AutomationsOptions };

const DEFAULTS: Omit<AutomationsOptions, "root" | "stateDir"> = {
  ingress: null,
  eventPath: "/events/inbound",
  eventSecretEnv: null,
  tickMs: 15_000,
  catchUp: true,
  inboundRetainMs: 24 * 60 * 60_000,
  now: () => new Date(),
  executors: defaultStepExecutors,
  onInvalidSpec: (id, issues) => {
    process.stderr.write(`automations: skipping invalid automation ${id}: ${issues.join("; ")}\n`);
  }
};

const HEARTBEAT_MS = 15_000;
// A live run beats every HEARTBEAT_MS however long its steps take, so a
// handful of missed beats means the runner is gone, not that the work is
// slow. Waiting longer would keep an automation blocked behind a claim its
// process can no longer release, which is what a daemon restart mid-run
// leaves behind.
const RUN_STALE_AFTER_MS = HEARTBEAT_MS * 4;

function matchesEventTrigger(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value;
}

/** Headers a relay uses to name a delivery, so its retry carries the same id. */
const DELIVERY_ID_HEADERS = ["x-delivery-id", "x-webhook-id", "x-event-id", "x-request-id", "idempotency-key"];

function deliveryKey(request: IngressRequest): string {
  for (const header of DELIVERY_ID_HEADERS) {
    const value = request.headers[header];
    if (value) return `${header}:${value}`;
  }
  // No delivery id, so the payload names itself. Two genuinely distinct
  // events cannot be byte-identical, since a relay's envelope carries its
  // own timestamp and message id.
  return `body:${createHash("sha256").update(request.rawBody).digest("hex")}`;
}

function parseReceipt(stored: string): Record<string, unknown> {
  try {
    return JSON.parse(stored) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type ValidationReport = {
  ok: boolean;
  count: number;
  automations: readonly { id: string; ok: boolean; issues: readonly string[] }[];
};

export type AutomationSummary = {
  id: string;
  name: string;
  enabled: boolean;
  triggers: readonly string[];
  nextRunAt: string | null;
  lastFiredAt: string | null;
};

/**
 * Composition root: registry plus clock plus runner plus ingress. Every
 * collaborator is injectable, so a spec can be exercised with no database
 * writes, no network, and no child processes.
 */
export class Automations {
  private readonly options: AutomationsOptions;
  private readonly db: LedgerDb;
  private readonly store: AutomationStore;
  private readonly clock: Clock;
  private ingress: Ingress | null = null;
  private ticking: NodeJS.Timeout | null = null;

  constructor(config: AutomationsConfig) {
    this.options = { ...DEFAULTS, ...config };
    fs.mkdirSync(this.options.stateDir, { recursive: true });
    this.db = new LedgerDb({
      filePath: path.join(this.options.stateDir, "automations.sqlite"),
      schema: AUTOMATIONS_SCHEMA,
      migrations: [],
      now: this.options.now
    });
    this.store = new AutomationStore(this.db);
    this.clock = new Clock(this.store, { catchUp: this.options.catchUp, now: this.options.now });
  }

  load(): RegistryLoad {
    return loadRegistry({ root: this.options.root, stateDir: this.options.stateDir });
  }

  specs(): readonly AutomationSpec[] {
    return this.load().automations.map((entry) => entry.spec);
  }

  validate(): ValidationReport {
    const { automations, failures } = this.load();
    const entries = [
      ...automations.map((entry) => ({ id: entry.spec.id, ok: true, issues: [] as string[] })),
      ...failures.map((failure) => ({
        id: failure.id,
        ok: false,
        issues: failure.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      }))
    ].sort((left, right) => left.id.localeCompare(right.id));
    return { ok: failures.length === 0, count: entries.length, automations: entries };
  }

  async summarize(): Promise<readonly AutomationSummary[]> {
    const summaries: AutomationSummary[] = [];
    for (const spec of this.specs()) {
      const states = await this.store.trackedTriggerStates(spec.id);
      const nextRuns = states.map((state) => state.nextRunAt).filter((value): value is string => value !== null).sort();
      const lastFires = states.map((state) => state.lastFiredAt).filter((value): value is string => value !== null).sort();
      summaries.push({
        id: spec.id,
        name: spec.name,
        enabled: spec.enabled,
        triggers: spec.triggers.map(describeTrigger),
        nextRunAt: nextRuns[0] ?? null,
        lastFiredAt: lastFires[lastFires.length - 1] ?? null
      });
    }
    return summaries;
  }

  /** Refreshes stored next-run times without running anything. */
  async sync(): Promise<{ ok: boolean; count: number; report: ValidationReport }> {
    const report = this.validate();
    if (!report.ok) return { ok: false, count: 0, report };
    const specs = this.specs();
    await this.clock.prime(specs);
    return { ok: true, count: specs.length, report };
  }

  requireSpec(id: string): AutomationSpec {
    const found = this.specs().find((spec) => spec.id === id);
    if (!found) throw new Error(`unknown automation: ${id}`);
    return found;
  }

  /** Runs one automation now, regardless of its triggers. */
  async run(id: string, payload: unknown = {}): Promise<RunRecord> {
    const spec = this.requireSpec(id);
    return this.execute(spec, "manual", {
      source: "manual",
      event: "run",
      payload,
      headers: {},
      receivedAt: this.options.now().toISOString()
    });
  }

  /** Delivers an event to every automation with a matching event trigger. */
  async dispatchEvent(event: AutomationEvent): Promise<readonly RunRecord[]> {
    const runs: RunRecord[] = [];
    for (const spec of this.specs()) {
      if (!spec.enabled) continue;
      const matched = spec.triggers.some((trigger) =>
        trigger.kind === "event"
        && matchesEventTrigger(trigger.source, event.source)
        && matchesEventTrigger(trigger.event, event.event));
      if (!matched) continue;
      runs.push(await this.execute(spec, "event", event));
    }
    return runs;
  }

  async handleRequest(request: IngressRequest): Promise<IngressResponse> {
    if (request.method === "GET" && request.path === "/healthz") {
      return { status: 200, body: { ok: true, service: "automations", count: this.specs().length } };
    }
    if (request.method === "GET" && request.path === "/automations") {
      return { status: 200, body: { ok: true, automations: await this.summarize() } };
    }
    if (request.method === "POST" && request.path === this.options.eventPath) {
      return this.handleForwardedEvent(request);
    }
    return this.handleHttpTrigger(request);
  }

  private async handleForwardedEvent(request: IngressRequest): Promise<IngressResponse> {
    const secretEnv = this.options.eventSecretEnv;
    if (secretEnv) {
      const secret = process.env[secretEnv];
      if (!secret) return { status: 503, body: { ok: false, error: `${secretEnv} is not set` } };
      const supplied = request.headers["x-webhook-signature"] ?? "";
      if (!verifyHmacSha256(secret, request.rawBody, supplied)) {
        return { status: 401, body: { ok: false, error: "invalid signature" } };
      }
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(request.rawBody.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid json" } };
    }
    const event: AutomationEvent = {
      source: typeof envelope.source === "string" ? envelope.source : "external",
      event: typeof envelope.event === "string" ? envelope.event : "inbound",
      payload: "payload" in envelope ? envelope.payload : envelope,
      headers: redactCredentialHeaders(request.headers),
      receivedAt: this.options.now().toISOString()
    };
    // A relay that gives up waiting redelivers, and the second copy of an
    // inbound email must not be processed again. The delivery id the relay
    // sent identifies the copy; failing that, the bytes do. The answer to the
    // first copy is stored and replayed, so a redelivery learns what happened
    // rather than repeating it.
    const key = deliveryKey(request);
    const answered = await this.store.claimInboundEvent(key, this.options.inboundRetainMs);
    if (answered !== null) {
      return {
        status: 202,
        body: answered === ""
          ? { ok: true, duplicate: true, note: "delivery already in progress" }
          : { ok: true, duplicate: true, ...(parseReceipt(answered)) }
      };
    }
    let runs: readonly RunRecord[];
    try {
      runs = await this.dispatchEvent(event);
    } catch (error) {
      // Nothing was answered, so the relay should redeliver rather than treat
      // a crashed dispatch as accepted work.
      await this.store.forgetInboundEvent(key);
      throw error;
    }
    if (runs.some((run) => run.status !== "completed")) {
      await this.store.forgetInboundEvent(key);
      return { status: 500, body: { ok: false, matched: runs.length, runs: runs.map(runReceipt) } };
    }
    const body = { ok: true, matched: runs.length, runs: runs.map(runReceipt) };
    await this.store.rememberInboundResponse(key, JSON.stringify(body));
    return { status: 202, body };
  }

  private async handleHttpTrigger(request: IngressRequest): Promise<IngressResponse> {
    for (const spec of this.specs()) {
      for (const trigger of spec.triggers) {
        if (trigger.kind !== "http") continue;
        if (trigger.method !== request.method || trigger.path !== request.path) continue;
        if (!spec.enabled) return { status: 503, body: { ok: false, error: `${spec.id} is disabled` } };
        if (trigger.verify) {
          const secret = process.env[trigger.verify.secretEnv];
          if (!secret) return { status: 503, body: { ok: false, error: `${trigger.verify.secretEnv} is not set` } };
          const supplied = request.headers[trigger.verify.header] ?? "";
          if (!verifyHmacSha256(secret, request.rawBody, supplied)) {
            return { status: 401, body: { ok: false, error: "invalid signature" } };
          }
        }
        let payload: unknown;
        try {
          payload = JSON.parse(request.rawBody.toString("utf8") || "{}");
        } catch {
          payload = request.rawBody.toString("utf8");
        }
        const run = await this.execute(spec, "http", {
          source: "http",
          event: `${request.method} ${request.path}`,
          payload,
          headers: redactCredentialHeaders(request.headers),
          receivedAt: this.options.now().toISOString()
        });
        return { status: run.status === "completed" ? 202 : 500, body: { ok: run.status === "completed", run: runReceipt(run) } };
      }
    }
    return { status: 404, body: { ok: false, error: `no automation serves ${request.method} ${request.path}` } };
  }

  private async execute(spec: AutomationSpec, triggerKind: TriggerKind, event: AutomationEvent): Promise<RunRecord> {
    const claim = await this.store.claimRun({
      automationId: spec.id,
      maxConcurrentRuns: spec.limits.maxConcurrentRuns,
      staleAfterMs: RUN_STALE_AFTER_MS
    });
    if (!claim) {
      const startedAt = this.options.now().toISOString();
      const rejected: RunRecord = {
        // Two rejections can land in the same millisecond, and the run id is a
        // primary key.
        id: `rejected-${startedAt}-${this.store.newRunId()}`,
        automationId: spec.id,
        triggerKind,
        status: "rejected",
        event,
        steps: [],
        error: `at maxConcurrentRuns (${spec.limits.maxConcurrentRuns})`,
        startedAt,
        finishedAt: startedAt
      };
      await this.store.recordRun(rejected);
      await this.appendRunLog(spec.id, rejected);
      return rejected;
    }
    const heartbeat = setInterval(() => { void this.store.heartbeat(claim.id); }, HEARTBEAT_MS);
    try {
      const outcome = await runSteps(spec, event, this.options.executors, this.options.now);
      const record = await this.store.releaseRun({
        claim,
        automationId: spec.id,
        triggerKind,
        status: outcome.ok ? "completed" : "failed",
        event,
        steps: outcome.steps,
        error: outcome.error
      });
      await this.appendRunLog(spec.id, record);
      return record;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async appendRunLog(automationId: string, record: RunRecord): Promise<void> {
    const dir = automationStateDir({ root: this.options.root, stateDir: this.options.stateDir }, automationId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  }

  async recentRuns(id: string, limit = 20): Promise<readonly RunRecord[]> {
    return this.store.recentRuns(id, limit);
  }

  /** Health facts for a probe: spec validity, schedule liveness, ingress. */
  async doctor(): Promise<Record<string, unknown>> {
    const report = this.validate();
    const summaries = await this.summarize();
    const now = this.options.now();
    const overdue = summaries.filter((summary) =>
      summary.enabled && summary.nextRunAt !== null && Date.parse(summary.nextRunAt) < now.getTime() - 5 * 60_000);
    return {
      ok: report.ok && overdue.length === 0,
      root: this.options.root,
      stateDir: this.options.stateDir,
      count: report.count,
      invalid: report.automations.filter((entry) => !entry.ok),
      overdue: overdue.map((summary) => ({ id: summary.id, nextRunAt: summary.nextRunAt })),
      ingressUrl: this.ingress?.url ?? null
    };
  }

  /** Starts the ingress listener and the clock loop. */
  async serve(): Promise<void> {
    // A broken definition stops itself, not the registry. Every other path
    // here already skips one, and refusing to boot under a restarting
    // supervisor turns one bad hand edit into a crash loop that takes every
    // schedule and the ingress down with it. `sync` still fails, so a deploy
    // that carries a broken spec is still rejected before it lands.
    const sync = await this.sync();
    for (const entry of sync.report.automations.filter((automation) => !automation.ok)) {
      this.options.onInvalidSpec(entry.id, entry.issues);
    }
    if (this.options.ingress) {
      this.ingress = await startHttpIngress(
        {
          host: this.options.ingress.host,
          port: this.options.ingress.port,
          maxBodyBytes: this.options.ingress.maxBodyBytes ?? 1024 * 1024
        },
        (request) => this.handleRequest(request)
      );
    }
    this.ticking = setInterval(() => { void this.tick(); }, this.options.tickMs);
    await this.tick();
  }

  async tick(): Promise<readonly RunRecord[]> {
    // Priming every tick picks up specs added or edited while the daemon runs;
    // it keeps an unchanged trigger's stored next-run untouched.
    const specs = this.specs();
    await this.clock.prime(specs);
    const fires = await this.clock.due(specs);
    // Automations due in the same tick run alongside each other. Awaiting them
    // in turn would let one long automation, say an hour-long agent round,
    // hold back every other schedule that came due with it. Overlap within a
    // single automation is still bounded by its own maxConcurrentRuns.
    const runs = await Promise.all(fires.flatMap((fire) => {
      const spec = specs.find((entry) => entry.id === fire.automationId);
      return spec ? [this.execute(spec, "schedule", fire.event)] : [];
    }));
    return runs;
  }

  async stop(): Promise<void> {
    if (this.ticking) clearInterval(this.ticking);
    this.ticking = null;
    if (this.ingress) await this.ingress.close();
    this.ingress = null;
    this.db.close();
  }

  /** Next fire time for a cron expression, for previews and tests. */
  static nextRun(cron: string, tz: string, after: Date): Date | null {
    return nextCronRun(cron, tz, after);
  }
}

function describeTrigger(trigger: AutomationSpec["triggers"][number]): string {
  if (trigger.kind === "schedule") return `schedule ${trigger.cron} ${trigger.tz}`;
  if (trigger.kind === "event") return `event ${trigger.source}.${trigger.event}`;
  if (trigger.kind === "http") return `http ${trigger.method} ${trigger.path}`;
  return "manual";
}

function runReceipt(record: RunRecord): Record<string, unknown> {
  return {
    id: record.id,
    automationId: record.automationId,
    status: record.status,
    error: record.error,
    steps: record.steps.map((step) => ({ name: step.name, ok: step.ok }))
  };
}

export function createAutomations(config: AutomationsConfig): Automations {
  return new Automations(config);
}

export type { LoadedAutomation };
