export {
  CodexProcessRunner,
  type CodexConversationProcessRequest,
  type CodexConversationProcessResult,
  type CodexProcessError,
  type CodexProcessRequest,
  type CodexProcessResult,
  type Executor,
  type ExecutorSessions
} from "../../packages/tasks/src/executor";

/**
 * Codex is the model executor that runs every conversation turn. Channel
 * servers spawn it through CodexProcessRunner and persist session continuity
 * in the ledger's codex_sessions store; these are the knobs they configure it
 * with.
 */
export const codexExecutor = {
  command: "codex",
  modelEnv: "CODEX_MODEL",
  defaultModel: "gpt-5.5",
  timeoutEnv: "CODEX_TIMEOUT_MS",
  reasoningEffortEnv: "CODEX_REASONING_EFFORT",
  defaultReasoningEffort: "xhigh",
  serviceTierEnv: "CODEX_SERVICE_TIER",
  defaultServiceTier: "priority"
} as const;
