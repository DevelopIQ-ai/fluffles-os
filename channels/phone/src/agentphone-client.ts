import { ExecutorMcpClient, loadExecutorMcpConfig } from "./executor-mcp-client";
import {
  normalizedPhoneCallsFromListResult,
  normalizedPhoneMessagesFromListResult,
  type NormalizedPhoneCall,
  type NormalizedPhoneMessage
} from "./phone-normalize";

export const AGENTPHONE_NUMBER_ID = "00000000-0000-0000-0000-000000000000";
export const AGENTPHONE_FROM_NUMBER = "+14155550000";

const TOOL_ROOT = "fluffles_agentphone_1555500000.org.fluffles1555500000.flufflesPhone";
const GET_MESSAGES_TOOL = `${TOOL_ROOT}.flufflesGetMessagesFor1555500000`;
const LIST_CALLS_TOOL = `${TOOL_ROOT}.flufflesListCallsFor1555500000`;
const SEND_MESSAGE_TOOL = `${TOOL_ROOT}.flufflesSendMessageFrom1555500000`;
const GET_CALL_TRANSCRIPT_TOOL = `${TOOL_ROOT}.flufflesGetCallTranscriptFor1555500000`;

export interface AgentPhoneListMessagesInput {
  limit?: number;
  before?: string;
  after?: string;
}

export interface AgentPhoneListCallsInput {
  limit?: number;
  offset?: number;
}

export interface AgentPhoneSendMessageInput {
  toNumber: string;
  body: string;
  mediaUrls?: string[];
  replyToMessageId?: string | null;
  idempotencyKey?: string;
  sendStyle?: "celebration" | "fireworks" | "lasers" | "love" | "confetti" | "balloons" | "spotlight" | "echo" | "invisible" | "gentle" | "loud" | "slam";
}

export interface AgentPhoneSendMessageResult {
  providerMessageId: string;
  response: Record<string, unknown>;
}

export interface PhoneAgentPhoneClient {
  listMessages(input: AgentPhoneListMessagesInput): Promise<NormalizedPhoneMessage[]>;
  listCalls(input: AgentPhoneListCallsInput): Promise<NormalizedPhoneCall[]>;
  getCallTranscript(callId: string): Promise<Record<string, unknown>>;
  sendMessage(input: AgentPhoneSendMessageInput): Promise<AgentPhoneSendMessageResult>;
  /** Locate a provider-accepted outbound message by the engine idempotency key. */
  findOutboundDelivery?(idempotencyKey: string): Promise<NormalizedPhoneMessage | null>;
}

export class ExecutorAgentPhoneClient implements PhoneAgentPhoneClient {
  private readonly executor: ExecutorMcpClient;

  constructor(options: { executor?: ExecutorMcpClient } = {}) {
    this.executor = options.executor || new ExecutorMcpClient(loadExecutorMcpConfig());
  }

  async listMessages(input: AgentPhoneListMessagesInput): Promise<NormalizedPhoneMessage[]> {
    const result = await this.callScopedTool(GET_MESSAGES_TOOL, compactObject(input));
    return normalizedPhoneMessagesFromListResult(result);
  }

  async listCalls(input: AgentPhoneListCallsInput): Promise<NormalizedPhoneCall[]> {
    const result = await this.callScopedTool(LIST_CALLS_TOOL, compactObject(input));
    return normalizedPhoneCallsFromListResult(result);
  }

  async getCallTranscript(callId: string): Promise<Record<string, unknown>> {
    const result = await this.callScopedTool(GET_CALL_TRANSCRIPT_TOOL, { call_id: callId });
    return requireRecord(result, "call transcript result");
  }

  async sendMessage(input: AgentPhoneSendMessageInput): Promise<AgentPhoneSendMessageResult> {
    const body: Record<string, unknown> = {
      number_id: AGENTPHONE_NUMBER_ID,
      from_number: AGENTPHONE_FROM_NUMBER,
      to_number: input.toNumber,
      body: input.body
    };
    if (input.mediaUrls && input.mediaUrls.length > 0) body.media_urls = input.mediaUrls;
    if (input.replyToMessageId) body.reply_to_message_id = input.replyToMessageId;
    if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
    if (input.sendStyle) body.send_style = input.sendStyle;

    const result = await this.callScopedTool(SEND_MESSAGE_TOOL, { body });
    const record = requireRecord(result, "send message result");
    return {
      providerMessageId: stringField(record.id) || stringField(record.message_id) || stringField(record.messageId) || "unknown",
      response: record
    };
  }

  async findOutboundDelivery(idempotencyKey: string): Promise<NormalizedPhoneMessage | null> {
    return findAgentPhoneOutboundDelivery(this, idempotencyKey);
  }

  private async callScopedTool(path: string, input: Record<string, unknown>): Promise<unknown> {
    const code = [
      `const path = ${JSON.stringify(path)};`,
      `const input = ${JSON.stringify(input)};`,
      "const result = await tools[path](input);",
      "if (!result.ok) throw new Error(`${result.error?.code || 'agentphone_error'}: ${result.error?.message || 'unknown error'}`);",
      "return result.data;"
    ].join("\n");
    return this.executor.executeJson(code);
  }
}

function compactObject(input: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) output[key] = value;
  }
  return output;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function findAgentPhoneOutboundDelivery(
  client: Pick<PhoneAgentPhoneClient, "listMessages">,
  idempotencyKey: string
): Promise<NormalizedPhoneMessage | null> {
  let before: string | undefined;
  const visited = new Set<string>();
  for (let page = 0; page < 1000; page += 1) {
    const messages = await client.listMessages({ limit: 100, ...(before ? { before } : {}) });
    const accepted = messages.find((message) => message.direction === "outbound" && deliveryIdempotencyKey(message.raw) === idempotencyKey);
    if (accepted) return accepted;
    const oldest = messages.at(-1)?.id;
    if (messages.length < 100 || !oldest || visited.has(oldest)) return null;
    visited.add(oldest);
    before = oldest;
  }
  throw new Error("AgentPhone delivery reconciliation exceeded the provider pagination safety limit");
}

function deliveryIdempotencyKey(raw: Record<string, unknown>): string | null {
  return stringField(raw.idempotency_key) || stringField(raw.idempotencyKey);
}
