import { ConversationKey } from "@fluffles/tasks";

export type SlackKeySurface = "ambient" | "mention" | "thread" | "dm" | "message";

export interface SlackConversationKeyParts {
  teamId: string;
  channelId: string;
  rootTs: string;
  surface: SlackKeySurface;
}

/** Canonical Step 1 Slack conversation key: slack:<team_id>:<channel_id>:<root_ts>. */
export function canonicalSlackConversationKey(parts: Omit<SlackConversationKeyParts, "surface">): string {
  return ConversationKey.forSlack(parts.teamId, parts.channelId, parts.rootTs);
}

/** Pre-Step-1 Slack keys that may be encountered while resolving a canonical thread. */
export function legacySlackConversationKeys(parts: SlackConversationKeyParts): string[] {
  if (parts.surface === "dm" || parts.surface === "message") {
    return [`dm:${parts.channelId}`];
  }
  return [`thread:${parts.channelId}:${parts.rootTs}`];
}

export function rootTsForSlackEvent(threadTs: string | null | undefined, ts: string): string {
  return threadTs || ts;
}
