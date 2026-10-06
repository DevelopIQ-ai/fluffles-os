import fs from "node:fs";
import path from "node:path";
import type { AutomationsConfig } from "./types";

export const CONFIG_FILENAME = "automations.config.json";

export type FileConfig = {
  root?: string;
  stateDir?: string;
  ingress?: { host?: string; port?: number } | null;
  eventPath?: string;
  eventSecretEnv?: string | null;
  tickMs?: number;
  catchUp?: boolean;
};

function readFileConfig(cwd: string): { config: FileConfig; dir: string } {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return { config: {}, dir: cwd };
  return { config: JSON.parse(fs.readFileSync(configPath, "utf8")) as FileConfig, dir: cwd };
}

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(base, value);
}

export const DEFAULT_EVENT_SECRET_ENV = "AUTOMATIONS_EVENT_SECRET";

/**
 * A secret in the environment is a secret to verify against. Naming the
 * variable stays possible, but an environment that carries the default name
 * signs without being told to, so a lost pointer cannot silently downgrade a
 * bound ingress to unauthenticated.
 */
function resolveEventSecretEnv(config: FileConfig): string | null {
  const named = process.env.AUTOMATIONS_EVENT_SECRET_ENV ?? config.eventSecretEnv ?? null;
  if (named) return named;
  return process.env[DEFAULT_EVENT_SECRET_ENV] ? DEFAULT_EVENT_SECRET_ENV : null;
}

/**
 * Config precedence: environment, then `automations.config.json`, then
 * defaults relative to the working directory. Nothing here knows about any
 * particular deployment, which is what lets the package be adopted as-is.
 */
export function resolveConfig(cwd: string = process.cwd()): AutomationsConfig {
  const { config, dir } = readFileConfig(cwd);
  const root = process.env.AUTOMATIONS_ROOT ?? config.root ?? "automations";
  const stateDir = process.env.AUTOMATIONS_STATE_DIR ?? config.stateDir ?? ".state/automations";
  const port = process.env.AUTOMATIONS_PORT ?? (config.ingress?.port ? String(config.ingress.port) : null);
  const host = process.env.AUTOMATIONS_HOST ?? config.ingress?.host ?? "127.0.0.1";
  return {
    root: resolveFrom(dir, root),
    stateDir: resolveFrom(dir, stateDir),
    ingress: port ? { host, port: Number(port) } : null,
    eventPath: process.env.AUTOMATIONS_EVENT_PATH ?? config.eventPath ?? "/events/inbound",
    eventSecretEnv: resolveEventSecretEnv(config),
    tickMs: Number(process.env.AUTOMATIONS_TICK_MS ?? config.tickMs ?? 15_000),
    catchUp: config.catchUp !== false
  };
}
