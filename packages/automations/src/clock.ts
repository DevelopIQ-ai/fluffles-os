import { nextCronRun } from "./cron";
import type { AutomationStore } from "./store";
import type { AutomationEvent, AutomationSpec, ScheduleTrigger } from "./types";

export type ScheduledFire = {
  automationId: string;
  triggerIndex: number;
  dueAt: string;
  event: AutomationEvent;
};

export type ClockOptions = {
  /**
   * A trigger whose stored next-run is older than this on startup fired while
   * the daemon was down. It runs once as a catch-up rather than replaying
   * every missed occurrence.
   */
  catchUp: boolean;
  now: () => Date;
};

function fingerprint(trigger: ScheduleTrigger): string {
  return `${trigger.cron}@${trigger.tz}`;
}

function scheduleTriggers(spec: AutomationSpec): { trigger: ScheduleTrigger; index: number }[] {
  const entries: { trigger: ScheduleTrigger; index: number }[] = [];
  spec.triggers.forEach((trigger, index) => {
    if (trigger.kind === "schedule") entries.push({ trigger, index });
  });
  return entries;
}

/**
 * Owns per-trigger next-run bookkeeping. It never executes anything: `due()`
 * reports what should fire, and the caller decides what to do about it.
 */
export class Clock {
  constructor(
    private readonly store: AutomationStore,
    private readonly options: ClockOptions
  ) {}

  /** Seeds or refreshes stored next-run times for every schedule trigger. */
  async prime(specs: readonly AutomationSpec[]): Promise<void> {
    const now = this.options.now();
    for (const spec of specs) {
      const states = await this.store.trackedTriggerStates(spec.id);
      for (const { trigger, index } of scheduleTriggers(spec)) {
        const existing = states.find((state) => state.triggerIndex === index);
        const print = fingerprint(trigger);
        // A stored null means this expression already searched out to the
        // horizon and found nothing, so an unchanged expression is not
        // searched again.
        const keepExisting = existing
          && existing.fingerprint === print
          && (existing.nextRunAt === null
            || this.options.catchUp
            || Date.parse(existing.nextRunAt) > now.getTime());
        if (keepExisting) continue;
        const next = nextCronRun(trigger.cron, trigger.tz, now);
        await this.store.rememberNextRun({
          automationId: spec.id,
          triggerIndex: index,
          fingerprint: print,
          nextRunAt: next ? next.toISOString() : null
        });
      }
    }
    await this.store.forgetAutomations(specs.map((spec) => spec.id));
  }

  /** Schedule triggers whose next-run has arrived, with their next time advanced. */
  async due(specs: readonly AutomationSpec[]): Promise<readonly ScheduledFire[]> {
    const now = this.options.now();
    const fires: ScheduledFire[] = [];
    for (const spec of specs) {
      if (!spec.enabled) continue;
      const states = await this.store.trackedTriggerStates(spec.id);
      for (const { trigger, index } of scheduleTriggers(spec)) {
        const state = states.find((entry) => entry.triggerIndex === index);
        if (!state?.nextRunAt) continue;
        const dueAtMs = Date.parse(state.nextRunAt);
        if (!Number.isFinite(dueAtMs) || dueAtMs > now.getTime()) continue;
        const next = nextCronRun(trigger.cron, trigger.tz, now);
        await this.store.rememberNextRun({
          automationId: spec.id,
          triggerIndex: index,
          fingerprint: fingerprint(trigger),
          nextRunAt: next ? next.toISOString() : null
        });
        await this.store.markFired(spec.id, index, now.toISOString());
        fires.push({
          automationId: spec.id,
          triggerIndex: index,
          dueAt: state.nextRunAt,
          event: {
            source: "schedule",
            event: trigger.cron,
            payload: { dueAt: state.nextRunAt, tz: trigger.tz },
            headers: {},
            receivedAt: now.toISOString()
          }
        });
      }
    }
    return fires;
  }
}
