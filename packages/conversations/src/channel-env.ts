import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Channel process configuration. Every channel reads the same three env files
 * in the same order and clamps its numeric knobs the same way, so the parsing
 * lives here rather than once per channel.
 */

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChannelEnvFileOptions {
  /** Keys that only Infisical may supply; a local file must never define them. */
  localSecretKeys?: Iterable<string>;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Reads one optional `KEY=value` file without overwriting values already set. */
export function loadEnvFileInto(filePath: string, options: ChannelEnvFileOptions = {}): void {
  const env = options.env || process.env;
  const blocked = new Set(options.localSecretKeys || []);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // A key must look like a shell variable, so a line such as
    // `export SLACK_SIGNING_SECRET=x` is ignored rather than turned into a
    // stray entry that slips past the Infisical-only block list.
    if (!ENV_KEY.test(key) || blocked.has(key)) continue;
    if (env[key] != null) continue;
    env[key] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

/**
 * Loads the channel env trio: the deployed channel file, the host-written
 * runtime file, and a developer override. Later files never win over values
 * already present, which keeps Infisical injection authoritative.
 */
export function loadChannelEnv(channel: string, options: ChannelEnvFileOptions = {}): void {
  const env = options.env || process.env;
  const home = options.home || env.HOME || os.homedir();
  const paths = [
    path.join(home, "channels", channel, "channel.env"),
    path.join(home, "state", "channels", channel, "runtime.env"),
    path.join(home, "channels", channel, ".env")
  ];
  for (const filePath of paths) loadEnvFileInto(filePath, { ...options, env, home });
}

export function numberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  const normalized = value.toLowerCase();
  if (value === "1" || normalized === "true") return true;
  if (value === "0" || normalized === "false") return false;
  return fallback;
}

export interface NumberEnvOptions {
  integer?: boolean;
  min?: number;
  max?: number;
}

export function parseStringEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function parseNullableStringEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The strict counterpart to booleanEnv and numberEnv: a misconfigured value
 * fails the process at boot instead of being silently clamped, which is what a
 * channel wants for knobs an operator sets by hand.
 */
export function parseBooleanEnv(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean env ${name}=${value}`);
}

export function parseNumberEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  options: NumberEnvOptions = {}
): number {
  const raw = value?.trim();
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number env ${name}=${value}`);
  if (options.integer && !Number.isInteger(parsed)) throw new Error(`Invalid integer env ${name}=${value}`);
  if (options.min != null && parsed < options.min) throw new Error(`Env ${name} must be >= ${options.min}`);
  if (options.max != null && parsed > options.max) throw new Error(`Env ${name} must be <= ${options.max}`);
  return parsed;
}

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function channelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
