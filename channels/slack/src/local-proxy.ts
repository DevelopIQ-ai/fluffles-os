export interface LocalProxySlackEvent {
  user?: string | null | undefined;
  bot_id?: string | null | undefined;
  subtype?: string | undefined;
  text?: string | undefined;
  event_id?: string | null | undefined;
}

export interface LocalProxyOptions {
  botUserId: string | null;
  botId: string | null;
  prefix: string;
  userId: string | null;
}

export function isLocalProxyEvent(event: LocalProxySlackEvent, options: LocalProxyOptions): boolean {
  const prefix = options.prefix.trim();
  if (!prefix) return false;
  const fromBridgeBot = Boolean(
    (options.botUserId && event.user === options.botUserId) ||
    (options.botId && event.bot_id === options.botId)
  );
  if (!fromBridgeBot) return false;
  return String(event.text || "").trimStart().startsWith(prefix);
}

export function localProxyText(text: string | undefined, prefix: string): string {
  const trimmed = String(text || "").trimStart();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed.trim();
}

export function materializeLocalProxyEvent<T extends LocalProxySlackEvent>(event: T, options: LocalProxyOptions): T {
  if (!isLocalProxyEvent(event, options)) return event;
  return {
    ...event,
    user: options.userId,
    bot_id: null,
    subtype: event.subtype === "bot_message" ? undefined : event.subtype,
    text: localProxyText(event.text, options.prefix),
    event_id: event.event_id ? `local-proxy:${event.event_id}` : null
  };
}
