export interface ReminderLocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Validate an IANA timezone identifier accepted by the host ICU data. */
export function validateReminderTimezone(timeZone: string): string {
  const value = requireText(timeZone, "reminder display timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid reminder display timezone: ${value}`);
  }
  return value;
}

/** Require an ISO-8601 UTC instant and return its canonical representation. */
export function normalizeReminderUtc(value: string, field = "reminder scheduled_for"): string {
  if (!value) throw new Error(`${field} is required`);
  const match = utcTimestampPattern.exec(value);
  if (!match) throw new Error(`${field} must be an ISO-8601 UTC timestamp ending in Z`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((fractionText ?? "").padEnd(3, "0") || "0");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error(`${field} must be a valid ISO-8601 UTC timestamp`);
  }
  return date.toISOString();
}

/**
 * Convert an unambiguous wall-clock value in an IANA timezone to UTC. Ambiguous
 * and nonexistent daylight-saving local times are rejected instead of guessed.
 */
export function reminderLocalDateTimeToUtc(localDateTime: string, timeZone: string): string {
  const local = parseReminderLocalDateTime(localDateTime);
  const zone = validateReminderTimezone(timeZone);
  const naiveUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const offsets = new Set([
    timezoneOffsetMilliseconds(naiveUtc, zone),
    timezoneOffsetMilliseconds(naiveUtc - 24 * 60 * 60 * 1000, zone),
    timezoneOffsetMilliseconds(naiveUtc + 24 * 60 * 60 * 1000, zone)
  ]);
  const matches = [...offsets]
    .map((offset) => naiveUtc - offset)
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => sameLocalDateTime(localDateTimeParts(candidate, zone), local));

  if (matches.length === 0) {
    throw new Error(`Reminder local time ${localDateTime} does not exist in ${zone}`);
  }
  if (matches.length > 1) {
    throw new Error(`Reminder local time ${localDateTime} is ambiguous in ${zone}; provide a UTC timestamp`);
  }
  return new Date(matches[0] as number).toISOString();
}

function parseReminderLocalDateTime(value: string): ReminderLocalDateTime {
  const text = requireText(value, "reminder local datetime");
  const match = localDateTimePattern.exec(text);
  if (!match) throw new Error("reminder local datetime must use YYYY-MM-DDTHH:mm[:ss]");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const local: ReminderLocalDateTime = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText || "0")
  };
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
  if (
    date.getUTCFullYear() !== local.year
    || date.getUTCMonth() + 1 !== local.month
    || date.getUTCDate() !== local.day
    || local.hour > 23
    || local.minute > 59
    || local.second > 59
  ) {
    throw new Error(`Invalid reminder local datetime: ${text}`);
  }
  return local;
}

function timezoneOffsetMilliseconds(utcMilliseconds: number, timeZone: string): number {
  const local = localDateTimeParts(utcMilliseconds, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    - utcMilliseconds;
}

function localDateTimeParts(utcMilliseconds: number, timeZone: string): ReminderLocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcMilliseconds));
  const fields = Object.fromEntries(parts
    .filter((part) => ["year", "month", "day", "hour", "minute", "second"].includes(part.type))
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: requiredPart(fields, "year"),
    month: requiredPart(fields, "month"),
    day: requiredPart(fields, "day"),
    hour: requiredPart(fields, "hour"),
    minute: requiredPart(fields, "minute"),
    second: requiredPart(fields, "second")
  };
}

function sameLocalDateTime(left: ReminderLocalDateTime, right: ReminderLocalDateTime): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function requiredPart(parts: Record<string, number>, key: string): number {
  const value = parts[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Timezone conversion did not return ${key}`);
  return value;
}

function requireText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}
