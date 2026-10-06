import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { isJsonObject, parseJson } from "@fluffles/storage";
import { ContextChannelLimits, ContextLimitChannel, ContextLimitsConfig, JsonObject, TaskChannel } from "./types";

const contextLimitChannelValues: readonly ContextLimitChannel[] = ["slack", "email", "phone", "web"];
const defaultContextLimits: Record<ContextLimitChannel, ContextChannelLimits> = {
  slack: {
    recentMessagesLimit: 20,
    maxContextChars: 12000,
    maxContextTokens: 12000,
    recentUserMessageTokenLimit: 20000,
    summaryMaxChars: 2000,
    openLoopsMaxChars: 1000
  },
  email: {
    recentMessagesLimit: 20,
    maxContextChars: 12000,
    maxContextTokens: 12000,
    recentUserMessageTokenLimit: 20000,
    summaryMaxChars: 2000,
    openLoopsMaxChars: 1000
  },
  phone: {
    recentMessagesLimit: 20,
    maxContextChars: 8000,
    maxContextTokens: 8000,
    recentUserMessageTokenLimit: 20000,
    summaryMaxChars: 1500,
    openLoopsMaxChars: 800
  },
  // The console is the one surface with no provider length ceiling, so it
  // carries the widest window.
  web: {
    recentMessagesLimit: 40,
    maxContextChars: 24000,
    maxContextTokens: 24000,
    recentUserMessageTokenLimit: 40000,
    summaryMaxChars: 4000,
    openLoopsMaxChars: 2000
  }
};

export function resolveContextLimitsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLUFFLES_CONTEXT_LIMITS_PATH || path.join(env.HOME || os.homedir(), "config", "context-limits.json");
}

export function loadContextLimits(env: NodeJS.ProcessEnv = process.env): ContextLimitsConfig {
  const filePath = resolveContextLimitsPath(env);
  const channels = cloneContextLimitChannels(defaultContextLimits);
  if (!existsSync(filePath)) return { path: filePath, channels };

  const parsed = parseJson(readFileSync(filePath, "utf8"), `context limits config ${filePath}`);
  if (!isJsonObject(parsed)) throw new Error(`context limits config ${filePath} must be a JSON object`);
  const channelConfig = parsed.channels;
  if (channelConfig == null) return { path: filePath, channels };
  if (!isJsonObject(channelConfig)) throw new Error(`context limits config ${filePath}.channels must be a JSON object`);

  for (const channel of contextLimitChannelValues) {
    const raw = channelConfig[channel];
    if (raw == null) continue;
    if (!isJsonObject(raw)) throw new Error(`context limits config ${filePath}.channels.${channel} must be a JSON object`);
    channels[channel] = mergeContextChannelLimits(raw, channels[channel], `context limits config ${filePath}.channels.${channel}`);
  }

  return { path: filePath, channels };
}

export function getChannelContextLimits(channel: ContextLimitChannel, env: NodeJS.ProcessEnv = process.env): ContextChannelLimits {
  const limits = loadContextLimits(env).channels[channel];
  return applyContextLimitEnvOverrides(channel, limits, env);
}

function cloneContextLimitChannels(input: Record<ContextLimitChannel, ContextChannelLimits>): Record<ContextLimitChannel, ContextChannelLimits> {
  return {
    slack: cloneContextChannelLimits(input.slack),
    email: cloneContextChannelLimits(input.email),
    phone: cloneContextChannelLimits(input.phone),
    web: cloneContextChannelLimits(input.web)
  };
}
function cloneContextChannelLimits(input: ContextChannelLimits): ContextChannelLimits {
  return { ...input };
}
function mergeContextChannelLimits(raw: JsonObject, fallback: ContextChannelLimits, context: string): ContextChannelLimits {
  return {
    recentMessagesLimit: contextLimitNumber(raw, "recentMessagesLimit", fallback.recentMessagesLimit, context),
    maxContextChars: contextLimitNumber(raw, "maxContextChars", fallback.maxContextChars, context),
    maxContextTokens: contextLimitNumber(raw, "maxContextTokens", fallback.maxContextTokens ?? fallback.maxContextChars, context),
    recentUserMessageTokenLimit: contextLimitNumber(raw, "recentUserMessageTokenLimit", fallback.recentUserMessageTokenLimit, context),
    summaryMaxChars: contextLimitNumber(raw, "summaryMaxChars", fallback.summaryMaxChars, context),
    openLoopsMaxChars: contextLimitNumber(raw, "openLoopsMaxChars", fallback.openLoopsMaxChars, context)
  };
}
function contextLimitNumber(record: JsonObject, key: keyof ContextChannelLimits, fallback: number, context: string): number {
  const value = record[key];
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${context}.${key} must be an integer`);
  }
  if (value < 0) throw new Error(`${context}.${key} must be >= 0`);
  return value;
}
function applyContextLimitEnvOverrides(
  channel: ContextLimitChannel,
  limits: ContextChannelLimits,
  env: NodeJS.ProcessEnv
): ContextChannelLimits {
  const prefix = channel.toUpperCase();
  return {
    recentMessagesLimit: contextLimitNumberEnv(env, `${prefix}_CONTEXT_LIMIT`, limits.recentMessagesLimit),
    maxContextChars: contextLimitNumberEnv(env, `${prefix}_CONTEXT_MAX_CHARS`, limits.maxContextChars),
    maxContextTokens: contextLimitNumberEnv(env, `${prefix}_CONTEXT_MAX_TOKENS`, limits.maxContextTokens ?? limits.maxContextChars),
    recentUserMessageTokenLimit: contextLimitNumberEnv(env, `${prefix}_RECENT_USER_MESSAGE_TOKEN_LIMIT`, limits.recentUserMessageTokenLimit),
    summaryMaxChars: contextLimitNumberEnv(env, `${prefix}_SUMMARY_MAX_CHARS`, limits.summaryMaxChars),
    openLoopsMaxChars: contextLimitNumberEnv(env, `${prefix}_OPEN_LOOPS_MAX_CHARS`, limits.openLoopsMaxChars)
  };
}
function contextLimitNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw new Error(`Invalid integer env ${name}=${raw}`);
  if (parsed < 0) throw new Error(`Env ${name} must be >= 0`);
  return parsed;
}
export function isContextLimitChannel(channel: TaskChannel): channel is ContextLimitChannel {
  return (contextLimitChannelValues as readonly string[]).includes(channel);
}
