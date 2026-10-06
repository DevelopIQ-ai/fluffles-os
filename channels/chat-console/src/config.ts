import os from "node:os";
import path from "node:path";
import { loadChannelEnv, numberEnv, parseStringEnv } from "@fluffles/tasks";
import { codexExecutor } from "../../../agent/executors/codex";

// The same env file trio, in the same order, as every other channel: values
// already in the environment win, which keeps Infisical injection of
// CHAT_CONSOLE_PASSWORD authoritative and blocks a local file from setting it.
loadChannelEnv("chat-console", { localSecretKeys: ["CHAT_CONSOLE_PASSWORD"] });

export const home = process.env.HOME || os.homedir();
/** The console runs from `<root>/channels/chat-console`, on a dev checkout and on a deployed home alike. */
export const sourceRoot = path.resolve(__dirname, "..", "..", "..");
export const stateRoot = path.join(home, "state", "chat-console");
export const ledgerPath = process.env.CHAT_CONSOLE_LEDGER_PATH || path.join(home, "state", "tasks", "tasks.sqlite");

export const codexModel = parseStringEnv(process.env[codexExecutor.modelEnv], codexExecutor.defaultModel);
export const codexReasoningEffort = parseStringEnv(process.env[codexExecutor.reasoningEffortEnv], codexExecutor.defaultReasoningEffort);
export const codexServiceTier = parseStringEnv(process.env[codexExecutor.serviceTierEnv], codexExecutor.defaultServiceTier);
export const codexTimeoutMs = numberEnv(process.env[codexExecutor.timeoutEnv], 10 * 60 * 60 * 1000, 1000, Number.MAX_SAFE_INTEGER);
export const codexCommand = codexExecutor.command;
