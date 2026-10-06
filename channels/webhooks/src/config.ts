import os from "node:os";
import path from "node:path";

// The harness home is the account this runs as, so production and the dev
// harness resolve their own state.
const HOME = process.env.HOME ?? os.homedir();
const SERVICE_NAME = "webhooks";
const DEFAULT_PORT = 8787;

type EnvLike = Record<string, string | undefined>;

export type WebhookConfig = {
  home: string;
  serviceName: string;
  version: string;
  host: string;
  port: number;
  stateDir: string;
  eventDir: string;
  logDir: string;
  pidFile: string;
  stateFile: string;
  latestEventFile: string;
  maxBodyBytes: number;
  genericSecret: string;
  githubSecret: string;
};

function parsePort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid webhook port: ${value}`);
  return port;
}

function parseBytes(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes < 1024) throw new Error(`invalid byte limit: ${value}`);
  return bytes;
}

export function loadConfig(env: EnvLike = process.env): WebhookConfig {
  const stateDir = env.WEBHOOK_STATE_DIR || path.join(HOME, "state", "webhooks");
  const port = parsePort(env.WEBHOOK_PORT || env.PORT || DEFAULT_PORT);
  return {
    home: HOME,
    serviceName: SERVICE_NAME,
    version: "0.1.0",
    host: env.WEBHOOK_HOST || env.HOST || "127.0.0.1",
    port,
    stateDir,
    eventDir: path.join(stateDir, "events"),
    logDir: path.join(stateDir, "logs"),
    pidFile: path.join(stateDir, "webhooks.pid"),
    stateFile: path.join(stateDir, "webhooks.json"),
    latestEventFile: path.join(stateDir, "latest-event.json"),
    maxBodyBytes: parseBytes(env.WEBHOOK_MAX_BODY_BYTES, 1024 * 1024),
    genericSecret: env.HARNESS_WEBHOOK_SECRET || "",
    githubSecret: env.GITHUB_WEBHOOK_SECRET || ""
  };
}

export function publicConfig(config: WebhookConfig): Record<string, unknown> {
  return {
    serviceName: config.serviceName,
    version: config.version,
    host: config.host,
    port: config.port,
    stateDir: config.stateDir,
    eventDir: config.eventDir,
    maxBodyBytes: config.maxBodyBytes,
    configured: {
      genericSecret: Boolean(config.genericSecret),
      githubSecret: Boolean(config.githubSecret)
    }
  };
}

export { DEFAULT_PORT, HOME, SERVICE_NAME };
