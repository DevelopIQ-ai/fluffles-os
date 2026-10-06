import {
  ExecutorAgentPhoneClient,
  type AgentPhoneListCallsInput,
  type AgentPhoneListMessagesInput,
  type AgentPhoneSendMessageInput,
  type PhoneAgentPhoneClient
} from "./agentphone-client";

type CapabilityRequest =
  | { operation: "list-messages"; input?: AgentPhoneListMessagesInput }
  | { operation: "list-calls"; input?: AgentPhoneListCallsInput }
  | { operation: "get-call-transcript"; input: { callId: string } }
  | { operation: "send-message"; input: AgentPhoneSendMessageInput };

/** Executes one allow-listed AgentPhone operation for the Step 4 Executor adapter. */
export async function executeAgentPhoneCapability(client: PhoneAgentPhoneClient, request: CapabilityRequest): Promise<unknown> {
  switch (request.operation) {
    case "list-messages":
      return client.listMessages(request.input || {});
    case "list-calls":
      return client.listCalls(request.input || {});
    case "get-call-transcript":
      return client.getCallTranscript(request.input.callId);
    case "send-message":
      return client.sendMessage(request.input);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const raw = requiredFlag(argv, "--input");
  const request = parseRequest(JSON.parse(raw) as unknown);
  const result = await executeAgentPhoneCapability(new ExecutorAgentPhoneClient(), request);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

function parseRequest(value: unknown): CapabilityRequest {
  if (!isRecord(value) || typeof value.operation !== "string") throw new Error("AgentPhone capability input must include an operation");
  if (value.operation === "list-messages") return { operation: value.operation, ...(value.input === undefined ? {} : { input: listMessagesInput(value.input) }) };
  if (value.operation === "list-calls") return { operation: value.operation, ...(value.input === undefined ? {} : { input: listCallsInput(value.input) }) };
  if (value.operation === "get-call-transcript") return { operation: value.operation, input: { callId: requiredText(record(value.input, "get-call-transcript input").callId, "get-call-transcript input.callId") } };
  if (value.operation === "send-message") return { operation: value.operation, input: sendMessageInput(value.input) };
  throw new Error(`unsupported AgentPhone operation ${value.operation}`);
}

function listMessagesInput(value: unknown): AgentPhoneListMessagesInput {
  const input = record(value, "list-messages input");
  const output: AgentPhoneListMessagesInput = {};
  const limit = optionalNumber(input.limit, "list-messages input.limit");
  const before = optionalText(input.before, "list-messages input.before");
  const after = optionalText(input.after, "list-messages input.after");
  if (limit !== undefined) output.limit = limit;
  if (before !== undefined) output.before = before;
  if (after !== undefined) output.after = after;
  return output;
}

function listCallsInput(value: unknown): AgentPhoneListCallsInput {
  const input = record(value, "list-calls input");
  const output: AgentPhoneListCallsInput = {};
  const limit = optionalNumber(input.limit, "list-calls input.limit");
  const offset = optionalNumber(input.offset, "list-calls input.offset");
  if (limit !== undefined) output.limit = limit;
  if (offset !== undefined) output.offset = offset;
  return output;
}

function sendMessageInput(value: unknown): AgentPhoneSendMessageInput {
  const input = record(value, "send-message input");
  const output: AgentPhoneSendMessageInput = {
    toNumber: requiredText(input.toNumber, "send-message input.toNumber"),
    body: requiredText(input.body, "send-message input.body")
  };
  const mediaUrls = optionalStrings(input.mediaUrls, "send-message input.mediaUrls");
  const replyToMessageId = optionalText(input.replyToMessageId, "send-message input.replyToMessageId");
  const idempotencyKey = optionalText(input.idempotencyKey, "send-message input.idempotencyKey");
  const sendStyle = optionalText(input.sendStyle, "send-message input.sendStyle");
  if (mediaUrls) output.mediaUrls = mediaUrls;
  if (replyToMessageId) output.replyToMessageId = replyToMessageId;
  if (idempotencyKey) output.idempotencyKey = idempotencyKey;
  if (sendStyle) output.sendStyle = sendStyle as NonNullable<AgentPhoneSendMessageInput["sendStyle"]>;
  return output;
}

function requiredFlag(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1]) throw new Error(`${flag} is required`);
  return argv[index + 1] as string;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, context);
}

function optionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context} must be a finite number`);
  return value;
}

function optionalStrings(value: unknown, context: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((item, index) => requiredText(item, `${context}[${index}]`));
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`agentphone capability: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
