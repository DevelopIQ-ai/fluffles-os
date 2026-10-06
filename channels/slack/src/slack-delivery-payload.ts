import type { JsonObject, OutboundDelivery } from "@fluffles/tasks";
import type { SlackSurface } from "./thread-request-store";

export type SlackDeliveryPayload = JsonObject & {
  channel: string;
  sourceTs: string;
  threadTs: string | null;
  surface: SlackSurface;
  text: string;
};

const slackDeliverySurfaces: readonly SlackSurface[] = ["ambient", "mention", "thread", "dm", "message"];

export function createSlackDeliveryPayload(input: SlackDeliveryPayload): SlackDeliveryPayload {
  return { ...input };
}

export function parseSlackDeliveryPayload(delivery: Pick<OutboundDelivery, "id" | "payload">): SlackDeliveryPayload {
  const payload = delivery.payload;
  const channel = typeof payload.channel === "string" ? payload.channel : null;
  const sourceTs = typeof payload.sourceTs === "string" ? payload.sourceTs : null;
  const surface = isSlackDeliverySurface(payload.surface) ? payload.surface : null;
  const text = typeof payload.text === "string" ? payload.text : null;
  if (!channel || !sourceTs || !surface || text == null) throw new Error(`invalid Slack delivery payload ${delivery.id}`);
  return {
    channel,
    sourceTs,
    surface,
    text,
    threadTs: typeof payload.threadTs === "string" ? payload.threadTs : null
  };
}

function isSlackDeliverySurface(value: unknown): value is SlackSurface {
  return typeof value === "string" && (slackDeliverySurfaces as readonly string[]).includes(value);
}
