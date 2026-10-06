import {
  nullableStringField,
  optionalArrayField,
  optionalBooleanField,
  optionalNumberField,
  optionalRecordField,
  optionalStringField,
  requiredStringField,
  requireRuntimeRecord
} from "./runtime-validators";

export interface SlackFile {
  id?: string | null | undefined;
  name?: string | null | undefined;
  title?: string | null | undefined;
  mimetype?: string | null | undefined;
  filetype?: string | null | undefined;
  url_private?: string | null | undefined;
}

export interface SlackBotProfile {
  name?: string | null | undefined;
}

export interface SlackMessage {
  type?: string | undefined;
  subtype?: string | undefined;
  event_id?: string | null | undefined;
  event_ts?: string | null | undefined;
  channel?: string | undefined;
  channel_type?: string | undefined;
  user?: string | null | undefined;
  bot_id?: string | null | undefined;
  ts?: string | undefined;
  thread_ts?: string | null | undefined;
  text?: string | undefined;
  files?: SlackFile[] | undefined;
  bot_profile?: SlackBotProfile | undefined;
  client_msg_id?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SlackEvent extends SlackMessage {
  channel: string;
  ts: string;
}

export interface SlackChannel {
  id: string;
  is_im: boolean | undefined;
  is_member: boolean | undefined;
}

export interface SlackResponseMetadata {
  next_cursor?: string | undefined;
}

export interface SlackApiResponse {
  ok?: boolean | undefined;
  error?: string | undefined;
  url?: string | undefined;
  user_id?: string | undefined;
  bot_id?: string | undefined;
  user?: string | undefined;
  team?: string | undefined;
  team_id?: string | undefined;
  channel?: string | undefined;
  ts?: string | undefined;
  message?: SlackMessage | undefined;
  channels?: SlackChannel[] | undefined;
  messages?: SlackMessage[] | undefined;
  response_metadata?: SlackResponseMetadata | undefined;
}

export interface SocketEnvelopePayload {
  type: string | undefined;
  event_id: string | undefined;
  event_time: number | undefined;
  event: SlackEvent | undefined;
}

export interface SocketEnvelope {
  type: string | undefined;
  envelope_id: string | undefined;
  payload: SocketEnvelopePayload | undefined;
}

export interface SlackEventsPayload {
  type: string | undefined;
  challenge: string | undefined;
  event: SlackEvent | undefined;
  event_id: string | undefined;
  event_time: number | undefined;
}

export interface AutomationPayload {
  dryRun: boolean | undefined;
  slackEvent: SlackEvent | undefined;
  event: SlackEvent | undefined;
  responseText: string | undefined;
  agentResponse: string | undefined;
  triagePrompt: string | undefined;
}

export interface AutomationRequestBody {
  dryRun: boolean | undefined;
  payload: AutomationPayload | undefined;
  responseText: string | undefined;
  agentResponse: string | undefined;
}

export interface CodexJsonEvent {
  type: string | undefined;
  thread_id: string | undefined;
  item: {
    id: string | undefined;
    type: string | undefined;
    text: string | undefined;
    command: string | undefined;
    status: string | undefined;
    exit_code: number | undefined;
  } | undefined;
}

export function parseSlackApiResponse(value: unknown, context = "Slack API response"): SlackApiResponse {
  const record = requireRuntimeRecord(value, context);
  const metadataRecord = optionalRecordField(record, "response_metadata", context);
  const messageRecord = optionalRecordField(record, "message", context);
  return {
    ok: optionalBooleanField(record, "ok", context),
    error: optionalStringField(record, "error", context),
    url: optionalStringField(record, "url", context),
    user_id: optionalStringField(record, "user_id", context),
    bot_id: optionalStringField(record, "bot_id", context),
    user: optionalStringField(record, "user", context),
    team: optionalStringField(record, "team", context),
    team_id: optionalStringField(record, "team_id", context),
    channel: optionalStringField(record, "channel", context),
    ts: optionalStringField(record, "ts", context),
    message: messageRecord ? parseSlackMessage(messageRecord, `${context}.message`) : undefined,
    channels: optionalArrayField(record, "channels", parseSlackChannel, context),
    messages: optionalArrayField(record, "messages", parseSlackMessage, context),
    response_metadata: metadataRecord ? parseSlackResponseMetadata(metadataRecord, `${context}.response_metadata`) : undefined
  };
}

export function parseSocketEnvelope(value: unknown, context = "Slack Socket Mode envelope"): SocketEnvelope {
  const record = requireRuntimeRecord(value, context);
  const payloadRecord = optionalRecordField(record, "payload", context);
  return {
    type: optionalStringField(record, "type", context),
    envelope_id: optionalStringField(record, "envelope_id", context),
    payload: payloadRecord ? parseSocketEnvelopePayload(payloadRecord, `${context}.payload`) : undefined
  };
}

export function parseSlackEventsPayload(value: unknown, context = "Slack Events payload"): SlackEventsPayload {
  const record = requireRuntimeRecord(value, context);
  const eventRecord = optionalRecordField(record, "event", context);
  return {
    type: optionalStringField(record, "type", context),
    challenge: optionalStringField(record, "challenge", context),
    event: eventRecord ? parseSlackEvent(eventRecord, `${context}.event`) : undefined,
    event_id: optionalStringField(record, "event_id", context),
    event_time: optionalNumberField(record, "event_time", context)
  };
}

export function parseAutomationRequestBody(value: unknown, context = "automation request body"): AutomationRequestBody {
  const record = requireRuntimeRecord(value, context);
  const payloadRecord = optionalRecordField(record, "payload", context);
  return {
    dryRun: optionalBooleanField(record, "dryRun", context),
    payload: payloadRecord ? parseAutomationPayload(payloadRecord, `${context}.payload`) : undefined,
    responseText: optionalStringField(record, "responseText", context),
    agentResponse: optionalStringField(record, "agentResponse", context)
  };
}

export function parseCodexJsonEvent(value: unknown, context = "Codex JSON event"): CodexJsonEvent {
  const record = requireRuntimeRecord(value, context);
  const itemRecord = optionalRecordField(record, "item", context);
  return {
    type: optionalStringField(record, "type", context),
    thread_id: optionalStringField(record, "thread_id", context),
    item: itemRecord ? {
      id: optionalStringField(itemRecord, "id", `${context}.item`),
      type: optionalStringField(itemRecord, "type", `${context}.item`),
      text: optionalStringField(itemRecord, "text", `${context}.item`),
      command: optionalStringField(itemRecord, "command", `${context}.item`),
      status: optionalStringField(itemRecord, "status", `${context}.item`),
      exit_code: optionalNumberField(itemRecord, "exit_code", `${context}.item`)
    } : undefined
  };
}

function parseSocketEnvelopePayload(value: unknown, context: string): SocketEnvelopePayload {
  const record = requireRuntimeRecord(value, context);
  const eventRecord = optionalRecordField(record, "event", context);
  return {
    type: optionalStringField(record, "type", context),
    event_id: optionalStringField(record, "event_id", context),
    event_time: optionalNumberField(record, "event_time", context),
    event: eventRecord ? parseSlackEvent(eventRecord, `${context}.event`) : undefined
  };
}

function parseSlackChannel(value: unknown, context: string): SlackChannel {
  const record = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(record, "id", context),
    is_im: optionalBooleanField(record, "is_im", context),
    is_member: optionalBooleanField(record, "is_member", context)
  };
}

function parseSlackResponseMetadata(value: unknown, context: string): SlackResponseMetadata {
  const record = requireRuntimeRecord(value, context);
  return {
    next_cursor: optionalStringField(record, "next_cursor", context)
  };
}

function parseSlackFile(value: unknown, context: string): SlackFile {
  const record = requireRuntimeRecord(value, context);
  return {
    id: nullableStringField(record, "id", context),
    name: nullableStringField(record, "name", context),
    title: nullableStringField(record, "title", context),
    mimetype: nullableStringField(record, "mimetype", context),
    filetype: nullableStringField(record, "filetype", context),
    url_private: nullableStringField(record, "url_private", context)
  };
}

function parseSlackBotProfile(value: unknown, context: string): SlackBotProfile {
  const record = requireRuntimeRecord(value, context);
  return {
    name: nullableStringField(record, "name", context)
  };
}

export function parseSlackEvent(value: unknown, context = "Slack event"): SlackEvent {
  const message = parseSlackMessage(value, context);
  if (!message.channel) throw new Error(`${context}.channel must be a string`);
  if (!message.ts) throw new Error(`${context}.ts must be a string`);
  return {
    ...message,
    channel: message.channel,
    ts: message.ts
  };
}

function parseSlackMessage(value: unknown, context: string): SlackMessage {
  const record = requireRuntimeRecord(value, context);
  const botProfileRecord = optionalRecordField(record, "bot_profile", context);
  const metadataRecord = optionalRecordField(record, "metadata", context);
  return {
    type: optionalStringField(record, "type", context),
    subtype: optionalStringField(record, "subtype", context),
    event_id: nullableStringField(record, "event_id", context),
    event_ts: nullableStringField(record, "event_ts", context),
    channel: optionalStringField(record, "channel", context),
    channel_type: optionalStringField(record, "channel_type", context),
    user: nullableStringField(record, "user", context),
    bot_id: nullableStringField(record, "bot_id", context),
    ts: optionalStringField(record, "ts", context),
    thread_ts: nullableStringField(record, "thread_ts", context),
    client_msg_id: nullableStringField(record, "client_msg_id", context),
    metadata: metadataRecord,
    text: optionalStringField(record, "text", context),
    files: optionalArrayField(record, "files", parseSlackFile, context),
    bot_profile: botProfileRecord ? parseSlackBotProfile(botProfileRecord, `${context}.bot_profile`) : undefined
  };
}

function parseAutomationPayload(value: unknown, context: string): AutomationPayload {
  const record = requireRuntimeRecord(value, context);
  const slackEventRecord = optionalRecordField(record, "slackEvent", context);
  const eventRecord = optionalRecordField(record, "event", context);
  return {
    dryRun: optionalBooleanField(record, "dryRun", context),
    slackEvent: slackEventRecord ? parseSlackEvent(slackEventRecord, `${context}.slackEvent`) : undefined,
    event: eventRecord ? parseSlackEvent(eventRecord, `${context}.event`) : undefined,
    responseText: optionalStringField(record, "responseText", context),
    agentResponse: optionalStringField(record, "agentResponse", context),
    triagePrompt: optionalStringField(record, "triagePrompt", context)
  };
}
