export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RuntimeRecord = Record<string, unknown>;

export function jsonString(value: JsonValue | undefined): string { return JSON.stringify(value ?? null); }

export function parseJson(text: string, context: string): JsonValue {
  const parsed = JSON.parse(text) as unknown;
  if (isJsonValue(parsed)) return parsed;
  throw new Error(`${context} must be JSON`);
}

export function parseJsonObject(text: string, context: string): JsonObject {
  const value = parseJson(text, context);
  if (isJsonObject(value)) return value;
  throw new Error(`${context} must be a JSON object`);
}

export function parseJsonObjectOrNull(text: string, context: string): JsonObject | null {
  const value = parseJson(text, context);
  if (value === null) return null;
  if (isJsonObject(value)) return value;
  throw new Error(`${context} must be a JSON object or null`);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return true;
  if (valueType === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRuntimeRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
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

export function nullableStringField(record: RuntimeRecord, key: string, context: string): string | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string or null`);
  return value;
}

export function requiredNumberField(record: RuntimeRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    if (Number.isSafeInteger(numberValue)) return numberValue;
  }
  throw new Error(`${context}.${key} must be a finite number`);
}

export function nullableNumberField(record: RuntimeRecord, key: string, context: string): number | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    if (Number.isSafeInteger(numberValue)) return numberValue;
  }
  throw new Error(`${context}.${key} must be a finite number or null`);
}

export function requiredEnumField<T extends string>(record: RuntimeRecord, key: string, allowed: readonly T[], context: string): T {
  const value = requiredStringField(record, key, context);
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${context}.${key} has invalid value '${value}'`);
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function requireNonEmptyText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}
