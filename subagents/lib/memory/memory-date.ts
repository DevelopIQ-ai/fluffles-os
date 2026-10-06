const TIME_ZONE = "America/Los_Angeles";

function partsAt(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

export function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid date ${value}`);
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`invalid calendar date ${value}`);
  }
  return value;
}

export function localDate(now = new Date()): string {
  const parts = partsAt(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDate(date: string, days: number): string {
  const [year, month, day] = validateDate(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function zoneOffsetMs(instantMs: number): number {
  const parts = partsAt(new Date(instantMs));
  const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return localAsUtc - instantMs;
}

function midnightUtc(date: string): string {
  const [year, month, day] = validateDate(date).split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const corrected = guess - zoneOffsetMs(guess);
  return new Date(guess - zoneOffsetMs(corrected)).toISOString();
}

export function localDateRange(date: string): { from: string; until: string } {
  const valid = validateDate(date);
  return { from: midnightUtc(valid), until: midnightUtc(shiftDate(valid, 1)) };
}
