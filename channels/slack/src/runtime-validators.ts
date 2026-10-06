export type RuntimeRecord = Record<string, unknown>;

export function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRuntimeRecord(value: unknown, context: string): RuntimeRecord {
  if (!isRuntimeRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

export function runtimeRecordArray(value: unknown, context: string): RuntimeRecord[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => requireRuntimeRecord(item, `${context}[${index}]`));
}

export function requiredStringField(record: RuntimeRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string`);
  return value;
}

export function optionalStringField(record: RuntimeRecord, key: string, context: string): string | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string when present`);
  return value;
}

export function nullableStringField(record: RuntimeRecord, key: string, context: string): string | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string or null`);
  return value;
}

export function optionalBooleanField(record: RuntimeRecord, key: string, context: string): boolean | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${context}.${key} must be a boolean when present`);
  return value;
}

export function requiredNumberField(record: RuntimeRecord, key: string, context: string): number {
  return numberFromUnknown(record[key], `${context}.${key}`);
}

export function optionalNumberField(record: RuntimeRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value == null) return undefined;
  return numberFromUnknown(value, `${context}.${key}`);
}

export function requiredEnumField<T extends string>(
  record: RuntimeRecord,
  key: string,
  allowed: readonly T[],
  context: string
): T {
  const value = requiredStringField(record, key, context);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${context}.${key} has invalid value '${value}'`);
}

export function optionalEnumField<T extends string>(
  record: RuntimeRecord,
  key: string,
  allowed: readonly T[],
  context: string
): T | undefined {
  const value = optionalStringField(record, key, context);
  if (value == null) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${context}.${key} has invalid value '${value}'`);
}

export function optionalArrayField<T>(
  record: RuntimeRecord,
  key: string,
  parser: (value: unknown, context: string) => T,
  context: string
): T[] | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context}.${key} must be an array when present`);
  return value.map((item, index) => parser(item, `${context}.${key}[${index}]`));
}

export function optionalRecordField(record: RuntimeRecord, key: string, context: string): RuntimeRecord | undefined {
  const value = record[key];
  if (value == null) return undefined;
  return requireRuntimeRecord(value, `${context}.${key}`);
}

function numberFromUnknown(value: unknown, context: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    if (Number.isSafeInteger(numberValue)) return numberValue;
  }
  throw new Error(`${context} must be a finite number`);
}
