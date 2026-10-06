/**
 * Slack's env parsing is the shared strict parser; this module stays as the
 * channel-local name so callers and tests keep one import path.
 */
export {
  parseBooleanEnv,
  parseCsvSet,
  parseNullableStringEnv,
  parseNumberEnv,
  parseStringEnv,
  type NumberEnvOptions
} from "@fluffles/tasks";
