/**
 * One automation is one unit of work with many ways to fire. Trigger kinds
 * are additive: a schedule and an inbound event can drive the same steps,
 * the same id, and the same run history.
 */
export type TriggerKind = "schedule" | "event" | "http" | "manual";

export type ScheduleTrigger = {
  kind: "schedule";
  /** Five-field cron expression, evaluated in `tz`. */
  cron: string;
  tz: string;
};

export type EventTrigger = {
  kind: "event";
  /** Event namespace, for example `email`. `*` matches any source. */
  source: string;
  /** Event name within the source, for example `inbound`. `*` matches any event. */
  event: string;
};

export type HmacVerification = {
  style: "hmac-sha256";
  header: string;
  secretEnv: string;
};

export type HttpTrigger = {
  kind: "http";
  method: string;
  /** Absolute request path served by the ingress listener. */
  path: string;
  verify: HmacVerification | null;
};

export type ManualTrigger = {
  kind: "manual";
};

export type Trigger = ScheduleTrigger | EventTrigger | HttpTrigger | ManualTrigger;

export type CommandStep = {
  kind: "command";
  name: string;
  /** Argv, so nothing is handed to a shell. */
  argv: readonly string[];
  cwd: string | null;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
};

export type HttpStep = {
  kind: "http";
  name: string;
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  /** Template resolved against the firing event. */
  body: TemplateValue | null;
  timeoutMs: number;
};

export type Step = CommandStep | HttpStep;

/**
 * A template is plain JSON where strings may contain `{{path}}` references
 * into the firing event. A string that is exactly one reference resolves to
 * the referenced value with its type intact, so `"{{event.payload}}"` sends
 * an object rather than its string form.
 */
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | readonly TemplateValue[]
  | { readonly [key: string]: TemplateValue };

export type AutomationLimits = {
  maxConcurrentRuns: number;
  queueLimit: number;
};

export type AutomationSpec = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggers: readonly Trigger[];
  steps: readonly Step[];
  limits: AutomationLimits;
};

export type AutomationEvent = {
  /** Which trigger produced this run. */
  source: string;
  event: string;
  payload: unknown;
  headers: Readonly<Record<string, string>>;
  receivedAt: string;
};

export type RunStatus = "completed" | "failed" | "rejected";

export type StepResult = {
  name: string;
  kind: Step["kind"];
  ok: boolean;
  detail: string;
  startedAt: string;
  finishedAt: string;
};

export type RunRecord = {
  id: string;
  automationId: string;
  triggerKind: TriggerKind;
  status: RunStatus;
  event: AutomationEvent;
  steps: readonly StepResult[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
};

export type StepExecutors = {
  command(step: CommandStep, event: AutomationEvent): Promise<string>;
  http(step: HttpStep, event: AutomationEvent): Promise<string>;
};

export type AutomationsOptions = {
  /** Registry root holding one directory per automation. */
  root: string;
  /** Runtime state: database, logs, receipts. */
  stateDir: string;
  ingress: { host: string; port: number; maxBodyBytes?: number } | null;
  /** Path where forwarded provider events arrive. */
  eventPath: string;
  /** Env var holding the shared secret for `eventPath`, if it is protected. */
  eventSecretEnv: string | null;
  tickMs: number;
  /** Fire once for a schedule that came due while the daemon was down. */
  catchUp: boolean;
  /**
   * How long a delivery id is remembered, so a relay redelivering an event we
   * already handled is answered instead of running it again.
   */
  inboundRetainMs: number;
  now: () => Date;
  executors: StepExecutors;
  /** Called by `serve` for each definition it had to leave out. */
  onInvalidSpec: (id: string, issues: readonly string[]) => void;
};

export type AutomationsConfig = Partial<AutomationsOptions> & { root: string; stateDir: string };
