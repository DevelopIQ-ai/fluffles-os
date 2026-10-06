export interface SlackDeliveryCandidate {
  ts?: string | undefined;
  client_msg_id?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SlackDeliveryPage {
  messages: SlackDeliveryCandidate[];
  nextCursor: string | null;
}

/**
 * Search every provider page for the durable idempotency key. A cursor loop is
 * treated as an unavailable reconciliation rather than silently retrying a
 * possibly accepted send.
 */
export async function findSlackDelivery(
  idempotencyKey: string,
  loadPage: (cursor: string | null) => Promise<SlackDeliveryPage>
): Promise<SlackDeliveryCandidate | null> {
  const visited = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor && visited.has(cursor)) throw new Error("Slack delivery reconciliation returned a cursor loop");
    if (cursor) visited.add(cursor);
    const page = await loadPage(cursor);
    const match = page.messages.find((message) => message.client_msg_id === idempotencyKey
      || slackDeliveryMetadataKey(message) === idempotencyKey);
    if (match) return match;
    cursor = page.nextCursor?.trim() || null;
  } while (cursor);
  return null;
}

function slackDeliveryMetadataKey(message: SlackDeliveryCandidate): string | null {
  const metadata = message.metadata;
  if (!metadata || metadata.event_type !== "fluffles_delivery") return null;
  const payload = metadata.event_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const key = (payload as Record<string, unknown>).idempotency_key;
  return typeof key === "string" ? key : null;
}
