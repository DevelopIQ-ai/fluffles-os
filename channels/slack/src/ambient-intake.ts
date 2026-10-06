export type AmbientIntakeAction = "work" | "ack" | "ignore";

export interface AmbientIntakeInput {
  text?: string | null;
  hasFiles?: boolean;
  addressed?: boolean;
}

export interface AmbientIntakeDecision {
  action: AmbientIntakeAction;
  reason: string | null;
  replyText?: string;
}

const lightweightAckText = "here. send the actual task when you're ready.";

const lowIntentMessages = new Set([
  "?",
  "??",
  "???",
  "alive",
  "alive?",
  "are you alive",
  "are you alive?",
  "are you there",
  "are you there?",
  "hello",
  "hello?",
  "here?",
  "hey",
  "hey?",
  "hi",
  "hi?",
  "lol",
  "ping",
  "ping?",
  "sup",
  "test",
  "test?",
  "there?",
  "u alive",
  "u alive?",
  "u there",
  "u there?",
  "working on what",
  "working on what?",
  "yo",
  "yo?"
]);

export function decideAmbientIntake(input: AmbientIntakeInput): AmbientIntakeDecision {
  if (input.hasFiles) return { action: "work", reason: null };

  const text = normalizeAmbientText(input.text || "");
  if (!text) return { action: "ignore", reason: "empty_ambient_message" };

  // Slack sends an explicit `<@user-id>` entity when the bot is addressed.
  // An addressed message is always work, even if the visible remainder looks
  // like a lightweight ping after presentation normalization.
  if (input.addressed) return { action: "work", reason: null };

  if (lowIntentMessages.has(text)) {
    return {
      action: "ack",
      reason: "low_intent_ambient_ping",
      replyText: lightweightAckText
    };
  }

  return { action: "work", reason: null };
}

function normalizeAmbientText(value: string): string {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
