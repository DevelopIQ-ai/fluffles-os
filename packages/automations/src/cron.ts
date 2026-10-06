/**
 * Five-field cron evaluated against wall-clock time in a named time zone.
 *
 * Candidate instants are generated in UTC and formatted into the target zone,
 * so daylight saving transitions follow the zone's own arithmetic: a wall
 * clock time that a spring-forward skips never fires that day, and one that a
 * fall-back repeats fires in both passes.
 */

export type CronFields = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** Cron treats day-of-month and day-of-week as a union when both are restricted. */
  dayUnion: boolean;
};

type FieldRange = { min: number; max: number };

const MINUTE_MS = 60_000;
const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  // Sunday is expressible as both 0 and 7; `parseCron` folds 7 into 0.
  { min: 0, max: 7 }
];
const SEARCH_LIMIT_DAYS = 366 * 4;

function parseField(text: string, range: FieldRange): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (part.length === 0) return null;
    const [spec, stepText] = part.split("/", 2) as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isSafeInteger(step) || step <= 0) return null;
    }
    let from: number;
    let to: number;
    if (spec === "*") {
      from = range.min;
      to = range.max;
    } else if (spec.includes("-")) {
      const [fromText, toText] = spec.split("-", 2) as [string, string];
      from = Number(fromText);
      to = Number(toText);
    } else {
      from = Number(spec);
      to = stepText === undefined ? from : range.max;
    }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    if (from < range.min || to > range.max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((part, index) => parseField(part, FIELD_RANGES[index] as FieldRange));
  if (parsed.some((field) => field === null)) return null;
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as [
    Set<number>, Set<number>, Set<number>, Set<number>, Set<number>
  ];
  // Sunday is expressible as both 0 and 7.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayUnion: (parts[2] as string) !== "*" && (parts[4] as string) !== "*"
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

export type ZonedParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric"
  });
  formatterCache.set(tz, created);
  return created;
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour"));
  return {
    minute: Number(read("minute")),
    // Some zones format midnight as 24 under hour12:false.
    hour: hour === 24 ? 0 : hour,
    dayOfMonth: Number(read("day")),
    month: Number(read("month")),
    dayOfWeek: WEEKDAYS[read("weekday")] ?? 0
  };
}

function matchesDate(fields: CronFields, parts: ZonedParts): boolean {
  if (!fields.months.has(parts.month)) return false;
  const dayOfMonthMatches = fields.daysOfMonth.has(parts.dayOfMonth);
  const dayOfWeekMatches = fields.daysOfWeek.has(parts.dayOfWeek);
  return fields.dayUnion ? dayOfMonthMatches || dayOfWeekMatches : dayOfMonthMatches && dayOfWeekMatches;
}

export function matchesCron(fields: CronFields, instant: Date, tz: string): boolean {
  const parts = zonedParts(instant, tz);
  return fields.minutes.has(parts.minute) && fields.hours.has(parts.hour) && matchesDate(fields, parts);
}

/**
 * First matching instant strictly after `after`, or null if none within four
 * years.
 *
 * The search skips the rest of the day when the date cannot match and the rest
 * of the hour when the hour cannot match, so a well-formed but unsatisfiable
 * expression such as `0 0 30 2 *` costs thousands of steps rather than the two
 * million a minute-by-minute walk would take.
 */
export function nextCronRun(expression: string, tz: string, after: Date): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  let candidateMs = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limitMs = candidateMs + SEARCH_LIMIT_DAYS * 24 * 60 * MINUTE_MS;
  while (candidateMs < limitMs) {
    const candidate = new Date(candidateMs);
    const parts = zonedParts(candidate, tz);
    if (!matchesDate(fields, parts)) {
      // Jump toward the next wall-clock midnight rather than stepping minutes,
      // holding an hour back so a daylight saving shift cannot overshoot into
      // a matching day. Undershooting only costs one extra evaluation.
      const toMidnight = 24 * 60 - parts.hour * 60 - parts.minute;
      candidateMs += Math.max(1, toMidnight - 60) * MINUTE_MS;
      continue;
    }
    if (!fields.hours.has(parts.hour)) {
      candidateMs += (60 - parts.minute) * MINUTE_MS;
      continue;
    }
    if (fields.minutes.has(parts.minute)) return candidate;
    candidateMs += MINUTE_MS;
  }
  return null;
}
