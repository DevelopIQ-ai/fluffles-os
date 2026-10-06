import { isValidCron } from "./cron";
import type {
  AutomationLimits,
  AutomationSpec,
  HmacVerification,
  Step,
  TemplateValue,
  Trigger
} from "./types";

export type SpecIssue = { path: string; message: string };

export type SpecParseResult =
  | { ok: true; spec: AutomationSpec }
  | { ok: false; id: string; issues: readonly SpecIssue[] };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_STEP_TIMEOUT_MS = 120_000;

class SpecErrors {
  private readonly issues: SpecIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get list(): readonly SpecIssue[] {
    return this.issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    result[key] = entry;
  }
  return result;
}

function templateValue(value: unknown): TemplateValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items: TemplateValue[] = [];
    for (const entry of value) {
      const parsed = templateValue(entry);
      if (parsed === null && entry !== null) return null;
      items.push(parsed);
    }
    return items;
  }
  if (isRecord(value)) {
    const result: Record<string, TemplateValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const parsed = templateValue(entry);
      if (parsed === null && entry !== null) return null;
      result[key] = parsed;
    }
    return result;
  }
  return null;
}

function parseVerification(value: unknown, path: string, errors: SpecErrors): HmacVerification | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    errors.add(path, "verify must be an object");
    return null;
  }
  if (value.style !== "hmac-sha256") {
    errors.add(`${path}.style`, "only hmac-sha256 verification is supported");
    return null;
  }
  const header = optionalText(value.header);
  const secretEnv = optionalText(value.secretEnv);
  if (!header) errors.add(`${path}.header`, "header is required");
  if (!secretEnv) errors.add(`${path}.secretEnv`, "secretEnv is required");
  if (!header || !secretEnv) return null;
  return { style: "hmac-sha256", header: header.toLowerCase(), secretEnv };
}

function parseTrigger(raw: unknown, path: string, errors: SpecErrors): Trigger | null {
  if (!isRecord(raw)) {
    errors.add(path, "trigger must be an object");
    return null;
  }
  const kind = optionalText(raw.kind);
  if (kind === "schedule") {
    const cron = optionalText(raw.cron);
    const tz = optionalText(raw.tz) ?? "UTC";
    if (!cron) {
      errors.add(`${path}.cron`, "cron is required");
      return null;
    }
    if (!isValidCron(cron)) {
      errors.add(`${path}.cron`, `invalid cron expression: ${cron}`);
      return null;
    }
    if (!isValidTimeZone(tz)) {
      errors.add(`${path}.tz`, `unknown time zone: ${tz}`);
      return null;
    }
    return { kind: "schedule", cron, tz };
  }
  if (kind === "event") {
    const source = optionalText(raw.source);
    const event = optionalText(raw.event);
    if (!source) errors.add(`${path}.source`, "source is required");
    if (!event) errors.add(`${path}.event`, "event is required");
    if (!source || !event) return null;
    return { kind: "event", source, event };
  }
  if (kind === "http") {
    const method = (optionalText(raw.method) ?? "POST").toUpperCase();
    const httpPath = optionalText(raw.path);
    if (!httpPath || !httpPath.startsWith("/")) {
      errors.add(`${path}.path`, "path is required and must start with /");
      return null;
    }
    return { kind: "http", method, path: httpPath, verify: parseVerification(raw.verify, `${path}.verify`, errors) };
  }
  if (kind === "manual") return { kind: "manual" };
  errors.add(`${path}.kind`, `unknown trigger kind: ${String(raw.kind)}`);
  return null;
}

function parseStep(raw: unknown, index: number, path: string, errors: SpecErrors): Step | null {
  if (!isRecord(raw)) {
    errors.add(path, "step must be an object");
    return null;
  }
  const kind = optionalText(raw.kind);
  const name = optionalText(raw.name) ?? `step-${index + 1}`;
  const timeoutMs = positiveInteger(raw.timeoutMs, DEFAULT_STEP_TIMEOUT_MS);
  if (Number.isNaN(timeoutMs)) errors.add(`${path}.timeoutMs`, "timeoutMs must be a positive integer");

  if (kind === "command") {
    const argv = Array.isArray(raw.argv) && raw.argv.every((entry) => typeof entry === "string")
      ? (raw.argv as string[])
      : null;
    if (!argv || argv.length === 0) {
      errors.add(`${path}.argv`, "argv is required and must be a non-empty array of strings");
      return null;
    }
    const env = stringRecord(raw.env);
    if (!env) {
      errors.add(`${path}.env`, "env must be a string map");
      return null;
    }
    if (Number.isNaN(timeoutMs)) return null;
    return { kind: "command", name, argv, cwd: optionalText(raw.cwd), env, timeoutMs };
  }

  if (kind === "http") {
    const url = optionalText(raw.url);
    if (!url) {
      errors.add(`${path}.url`, "url is required");
      return null;
    }
    const headers = stringRecord(raw.headers);
    if (!headers) {
      errors.add(`${path}.headers`, "headers must be a string map");
      return null;
    }
    const body = raw.body === undefined ? null : templateValue(raw.body);
    if (raw.body !== undefined && body === null && raw.body !== null) {
      errors.add(`${path}.body`, "body must be JSON");
      return null;
    }
    if (Number.isNaN(timeoutMs)) return null;
    return {
      kind: "http",
      name,
      method: (optionalText(raw.method) ?? "POST").toUpperCase(),
      url,
      headers,
      body,
      timeoutMs
    };
  }

  errors.add(`${path}.kind`, `unknown step kind: ${String(raw.kind)}`);
  return null;
}

function parseLimits(raw: unknown, errors: SpecErrors): AutomationLimits {
  if (raw === undefined || raw === null) return { maxConcurrentRuns: 1, queueLimit: 0 };
  if (!isRecord(raw)) {
    errors.add("limits", "limits must be an object");
    return { maxConcurrentRuns: 1, queueLimit: 0 };
  }
  const maxConcurrentRuns = positiveInteger(raw.maxConcurrentRuns, 1);
  const queueLimit = nonNegativeInteger(raw.queueLimit, 0);
  if (Number.isNaN(maxConcurrentRuns)) errors.add("limits.maxConcurrentRuns", "must be a positive integer");
  if (Number.isNaN(queueLimit)) errors.add("limits.queueLimit", "must be a non-negative integer");
  return {
    maxConcurrentRuns: Number.isNaN(maxConcurrentRuns) ? 1 : maxConcurrentRuns,
    queueLimit: Number.isNaN(queueLimit) ? 0 : queueLimit
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses one `automation.json` document. Pure: no filesystem, no clock. */
export function parseAutomationSpec(raw: unknown, fallbackId: string): SpecParseResult {
  const errors = new SpecErrors();
  const document = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) errors.add("", "automation.json must be an object");

  const id = optionalText(document.id) ?? fallbackId;
  if (!ID_PATTERN.test(id)) errors.add("id", `invalid id "${id}"; use letters, numbers, dot, underscore, or hyphen`);

  const name = optionalText(document.name);
  if (!name) errors.add("name", "name is required");

  const triggersRaw = document.triggers;
  const triggers: Trigger[] = [];
  if (!Array.isArray(triggersRaw) || triggersRaw.length === 0) {
    errors.add("triggers", "at least one trigger is required");
  } else {
    triggersRaw.forEach((entry, index) => {
      const trigger = parseTrigger(entry, `triggers[${index}]`, errors);
      if (trigger) triggers.push(trigger);
    });
  }

  const stepsRaw = document.steps;
  const steps: Step[] = [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    errors.add("steps", "at least one step is required");
  } else {
    stepsRaw.forEach((entry, index) => {
      const step = parseStep(entry, index, `steps[${index}]`, errors);
      if (step) steps.push(step);
    });
  }

  const limits = parseLimits(document.limits, errors);
  const issues = errors.list;
  if (issues.length > 0) return { ok: false, id, issues };

  return {
    ok: true,
    spec: {
      id,
      name: name ?? id,
      description: optionalText(document.description) ?? "",
      enabled: document.enabled !== false,
      triggers,
      steps,
      limits
    }
  };
}
