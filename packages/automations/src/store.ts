import {
  LedgerDb,
  parseJson,
  requiredNumberField,
  requiredStringField,
  runtimeRecordArray,
  nullableStringField
} from "@fluffles/storage";
import type { DatabaseSync } from "node:sqlite";
import type { AutomationEvent, RunRecord, RunStatus, StepResult, TriggerKind } from "./types";

function insertRun(db: DatabaseSync, record: RunRecord): void {
  db.prepare(`
    INSERT INTO automation_runs (id, automation_id, trigger_kind, status, event, steps, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.automationId,
    record.triggerKind,
    record.status,
    JSON.stringify(record.event),
    JSON.stringify(record.steps),
    record.error,
    record.startedAt,
    record.finishedAt
  );
}

export type TriggerState = {
  automationId: string;
  triggerIndex: number;
  fingerprint: string;
  nextRunAt: string | null;
  lastFiredAt: string | null;
};

export type RunClaim = { id: string; startedAt: string };

/**
 * Durable state for the clock and the runner: per-trigger next-run bookkeeping,
 * concurrency claims that survive a crash, and the run history.
 */
export class AutomationStore {
  constructor(private readonly db: LedgerDb) {}

  async trackedTriggerStates(automationId: string): Promise<readonly TriggerState[]> {
    const context = "automation_trigger_state";
    const rows = runtimeRecordArray(
      this.db.ensureDb()
        .prepare("SELECT * FROM automation_trigger_state WHERE automation_id = ? ORDER BY trigger_index")
        .all(automationId),
      context
    );
    return rows.map((row) => ({
      automationId: requiredStringField(row, "automation_id", context),
      triggerIndex: requiredNumberField(row, "trigger_index", context),
      fingerprint: requiredStringField(row, "fingerprint", context),
      nextRunAt: nullableStringField(row, "next_run_at", context),
      lastFiredAt: nullableStringField(row, "last_fired_at", context)
    }));
  }

  /**
   * Records the next fire time for a trigger. A changed fingerprint means the
   * spec's schedule was edited, so the stored next-run is discarded rather
   * than honoured against the old expression.
   */
  async rememberNextRun(input: {
    automationId: string;
    triggerIndex: number;
    fingerprint: string;
    nextRunAt: string | null;
  }): Promise<void> {
    const updatedAt = this.db.nowDate().toISOString();
    await this.db.mutate((db) => {
      db.prepare(`
        INSERT INTO automation_trigger_state (automation_id, trigger_index, fingerprint, next_run_at, last_fired_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT (automation_id, trigger_index) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          next_run_at = excluded.next_run_at,
          last_fired_at = CASE WHEN automation_trigger_state.fingerprint = excluded.fingerprint
            THEN automation_trigger_state.last_fired_at ELSE NULL END,
          updated_at = excluded.updated_at
      `).run(
        input.automationId,
        input.triggerIndex,
        input.fingerprint,
        input.nextRunAt,
        updatedAt
      );
    });
  }

  async markFired(automationId: string, triggerIndex: number, firedAt: string): Promise<void> {
    await this.db.mutate((db) => {
      db.prepare(`
        UPDATE automation_trigger_state
        SET last_fired_at = ?, updated_at = ?
        WHERE automation_id = ? AND trigger_index = ?
      `).run(firedAt, firedAt, automationId, triggerIndex);
    });
  }

  async forgetAutomations(keepIds: readonly string[]): Promise<number> {
    return this.db.mutate((db) => {
      const rows = runtimeRecordArray(
        db.prepare("SELECT DISTINCT automation_id FROM automation_trigger_state").all(),
        "automation_trigger_state"
      );
      const keep = new Set(keepIds);
      let removed = 0;
      for (const row of rows) {
        const id = requiredStringField(row, "automation_id", "automation_trigger_state");
        if (keep.has(id)) continue;
        db.prepare("DELETE FROM automation_trigger_state WHERE automation_id = ?").run(id);
        removed += 1;
      }
      return removed;
    });
  }

  /**
   * Takes a concurrency slot, or returns null when the automation is already
   * at `maxConcurrentRuns`. Slots older than `staleAfterMs` belong to a
   * crashed run and are reclaimed.
   */
  async claimRun(input: {
    automationId: string;
    maxConcurrentRuns: number;
    staleAfterMs: number;
  }): Promise<RunClaim | null> {
    const now = this.db.nowDate();
    const id = this.db.newId();
    return this.db.mutate((db) => {
      const staleBefore = new Date(now.getTime() - input.staleAfterMs).toISOString();
      db.prepare("DELETE FROM automation_active_runs WHERE automation_id = ? AND heartbeat_at < ?")
        .run(input.automationId, staleBefore);
      const active = runtimeRecordArray(
        db.prepare("SELECT COUNT(*) AS active FROM automation_active_runs WHERE automation_id = ?")
          .all(input.automationId),
        "automation_active_runs"
      );
      const count = active[0] ? requiredNumberField(active[0], "active", "automation_active_runs") : 0;
      if (count >= input.maxConcurrentRuns) return null;
      const startedAt = now.toISOString();
      db.prepare("INSERT INTO automation_active_runs (id, automation_id, started_at, heartbeat_at) VALUES (?, ?, ?, ?)")
        .run(id, input.automationId, startedAt, startedAt);
      return { id, startedAt };
    });
  }

  async heartbeat(runId: string): Promise<void> {
    const at = this.db.nowDate().toISOString();
    await this.db.mutate((db) => {
      db.prepare("UPDATE automation_active_runs SET heartbeat_at = ? WHERE id = ?").run(at, runId);
    });
  }

  async releaseRun(input: {
    claim: RunClaim;
    automationId: string;
    triggerKind: TriggerKind;
    status: RunStatus;
    event: AutomationEvent;
    steps: readonly StepResult[];
    error: string | null;
  }): Promise<RunRecord> {
    const finishedAt = this.db.nowDate().toISOString();
    const record: RunRecord = {
      id: input.claim.id,
      automationId: input.automationId,
      triggerKind: input.triggerKind,
      status: input.status,
      event: input.event,
      steps: input.steps,
      error: input.error,
      startedAt: input.claim.startedAt,
      finishedAt
    };
    await this.db.mutate((db) => {
      db.prepare("DELETE FROM automation_active_runs WHERE id = ?").run(record.id);
      insertRun(db, record);
    });
    return record;
  }

  /**
   * Claims an inbound delivery. The first caller for a key gets null and owns
   * the work; a redelivery of the same key gets back what the first one
   * answered, so a relay that retried because our reply was slow is told what
   * already happened instead of running it a second time. An in-flight
   * delivery holds the row with no stored answer yet, which reads as an empty
   * string.
   */
  async claimInboundEvent(key: string, retainMs: number): Promise<string | null> {
    const now = this.db.nowDate();
    return this.db.mutate((db) => {
      db.prepare("DELETE FROM automation_inbound_events WHERE received_at < ?")
        .run(new Date(now.getTime() - retainMs).toISOString());
      const seen = runtimeRecordArray(
        db.prepare("SELECT response FROM automation_inbound_events WHERE key = ?").all(key),
        "automation_inbound_events"
      );
      const first = seen[0];
      if (first) return requiredStringField(first, "response", "automation_inbound_events");
      db.prepare("INSERT INTO automation_inbound_events (key, received_at, response) VALUES (?, ?, '')")
        .run(key, now.toISOString());
      return null;
    });
  }

  /** Stores what an inbound delivery answered, for its redeliveries to reuse. */
  async rememberInboundResponse(key: string, response: string): Promise<void> {
    await this.db.mutate((db) => {
      db.prepare("UPDATE automation_inbound_events SET response = ? WHERE key = ?").run(response, key);
    });
  }

  /** Frees a delivery key so the relay's retry is treated as a fresh attempt. */
  async forgetInboundEvent(key: string): Promise<void> {
    await this.db.mutate((db) => {
      db.prepare("DELETE FROM automation_inbound_events WHERE key = ?").run(key);
    });
  }

  newRunId(): string {
    return this.db.newId();
  }

  /** Writes a run that never held a claim, such as one rejected by a limit. */
  async recordRun(record: RunRecord): Promise<void> {
    await this.db.mutate((db) => { insertRun(db, record); });
  }

  async recentRuns(automationId: string, limit: number): Promise<readonly RunRecord[]> {
    const context = "automation_runs";
    const rows = runtimeRecordArray(
      this.db.ensureDb()
        .prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(automationId, limit),
      context
    );
    return rows.map((row) => ({
      id: requiredStringField(row, "id", context),
      automationId: requiredStringField(row, "automation_id", context),
      triggerKind: requiredStringField(row, "trigger_kind", context) as TriggerKind,
      status: requiredStringField(row, "status", context) as RunStatus,
      event: parseJson(requiredStringField(row, "event", context), `${context}.event`) as unknown as AutomationEvent,
      steps: parseJson(requiredStringField(row, "steps", context), `${context}.steps`) as unknown as readonly StepResult[],
      error: nullableStringField(row, "error", context),
      startedAt: requiredStringField(row, "started_at", context),
      finishedAt: requiredStringField(row, "finished_at", context)
    }));
  }

  async activeRunCount(automationId: string): Promise<number> {
    const context = "automation_active_runs";
    const rows = runtimeRecordArray(
      this.db.ensureDb()
        .prepare("SELECT COUNT(*) AS active FROM automation_active_runs WHERE automation_id = ?")
        .all(automationId),
      context
    );
    return rows[0] ? requiredNumberField(rows[0], "active", context) : 0;
  }
}
