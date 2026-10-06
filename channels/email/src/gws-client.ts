import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { GmailMessage } from "./email-normalize";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandRunOptions): Promise<CommandResult>;
}

export interface CommandRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GwsAuthStatus {
  token_valid: boolean;
  token_error?: string;
  error?: string;
  auth_method?: string;
  project_id?: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string | null;
}

export interface GmailMessagePage {
  messages: GmailMessageSummary[];
  nextPageToken: string | null;
}

export interface GmailProfile {
  historyId: string;
}

export interface GmailHistoryPage extends GmailMessagePage {
  historyId: string | null;
}

export interface SendReplyInput {
  messageId: string;
  body: string;
  from?: string | null;
  draft: boolean;
  idempotencyKey?: string;
}

export interface SendReplyResult {
  ok: boolean;
  mode: "draft" | "send";
  response: unknown;
  providerMessageId?: string | null;
  providerDraftId?: string | null;
  providerThreadId?: string | null;
}

export class ExecFileRunner implements CommandRunner {
  async run(command: string, args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      if (isExecError(error)) {
        return {
          stdout: typeof error.stdout === "string" ? error.stdout : "",
          stderr: typeof error.stderr === "string" ? error.stderr : error.message,
          code: typeof error.code === "number" ? error.code : 1
        };
      }
      throw error;
    }
  }
}

export class GwsClient {
  private readonly binPath: string;
  private readonly runner: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { binPath?: string; runner?: CommandRunner; env?: NodeJS.ProcessEnv } = {}) {
    this.binPath = options.binPath || `${process.env.HOME ?? os.homedir()}/bin/gws`;
    this.runner = options.runner || new ExecFileRunner();
    this.env = options.env || process.env;
  }

  async authStatus(): Promise<GwsAuthStatus> {
    const result = await this.runner.run(this.binPath, ["auth", "status"], {
      timeoutMs: 15000,
      maxBuffer: 1024 * 1024,
      env: this.env
    });
    if (result.code !== 0) {
      return { token_valid: false, error: result.stderr || `gws auth status exited ${result.code}` };
    }
    const parsed = parseJsonFromText(result.stdout);
    return authStatusFromUnknown(parsed);
  }

  async listMessages(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    const page = await this.listMessagesPage(query, maxResults);
    return page.messages;
  }

  async listMessagesPage(query: string, maxResults: number, pageToken?: string | null): Promise<GmailMessagePage> {
    const params = {
      userId: "me",
      q: query,
      maxResults,
      ...(pageToken ? { pageToken } : {})
    };
    const result = await this.runGws([
      "gmail",
      "users",
      "messages",
      "list",
      "--params",
      JSON.stringify(params)
    ]);
    const parsed = parseJsonFromText(result.stdout);
    return messagePageFromUnknown(parsed);
  }

  async listHistory(startHistoryId: string, maxResults: number, pageToken?: string | null): Promise<GmailHistoryPage> {
    const params = {
      userId: "me",
      startHistoryId,
      maxResults,
      ...(pageToken ? { pageToken } : {})
    };
    const result = await this.runGws([
      "gmail", "users", "history", "list", "--params", JSON.stringify(params)
    ]);
    return historyPageFromUnknown(parseJsonFromText(result.stdout));
  }

  async getProfile(): Promise<GmailProfile> {
    const result = await this.runGws([
      "gmail", "users", "getProfile", "--params", JSON.stringify({ userId: "me" })
    ]);
    const parsed = parseJsonFromText(result.stdout);
    if (!isRecord(parsed) || typeof parsed.historyId !== "string" || !parsed.historyId.trim()) {
      throw new Error("gws Gmail profile response is missing historyId");
    }
    return { historyId: parsed.historyId };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const params = {
      userId: "me",
      id,
      format: "full"
    };
    const result = await this.runGws([
      "gmail",
      "users",
      "messages",
      "get",
      "--params",
      JSON.stringify(params)
    ]);
    return gmailMessageFromUnknown(parseJsonFromText(result.stdout));
  }

  async reply(input: SendReplyInput): Promise<SendReplyResult> {
    const args = [
      "gmail",
      "+reply",
      "--message-id",
      input.messageId,
      "--body",
      input.idempotencyKey ? htmlReplyBody(input.body, input.idempotencyKey) : input.body,
      "--format",
      "json"
    ];
    if (input.idempotencyKey) args.push("--html");
    if (input.from) args.push("--from", input.from);
    if (input.draft) args.push("--draft");
    const result = await this.runGws(args, 120000);
    const response = parseJsonFromText(result.stdout);
    const identifiers = deliveryIdentifiers(response, input.draft);
    return {
      ok: true,
      mode: input.draft ? "draft" : "send",
      response,
      ...identifiers
    };
  }

  async findDelivery(messageId: string, idempotencyKey: string): Promise<{ [key: string]: string | boolean | null } | null> {
    const message = await this.getMessage(messageId);
    const threadId = optionalString(message.threadId);
    if (!threadId) return null;
    const result = await this.runGws([
      "gmail", "users", "threads", "get", "--params",
      JSON.stringify({ userId: "me", id: threadId, format: "full" })
    ]);
    const thread = parseJsonFromText(result.stdout);
    if (containsDeliveryMarker(thread, idempotencyKey)) return { threadId, idempotencyKey, reconciled: true };
    let pageToken: string | null = null;
    do {
      const drafts = await this.runGws([
        "gmail", "users", "drafts", "list", "--params",
        JSON.stringify({ userId: "me", maxResults: 100, ...(pageToken ? { pageToken } : {}) })
      ]);
      const parsedDrafts = parseJsonFromText(drafts.stdout);
      for (const draftId of draftIds(parsedDrafts)) {
      const draft = await this.runGws([
        "gmail", "users", "drafts", "get", "--params",
        JSON.stringify({ userId: "me", id: draftId })
      ]);
      if (containsDeliveryMarker(parseJsonFromText(draft.stdout), idempotencyKey)) {
        return { threadId, idempotencyKey, reconciled: true };
      }
      }
      pageToken = nextPageToken(parsedDrafts);
    } while (pageToken);
    return null;
  }

  private async runGws(args: string[], timeoutMs = 60000): Promise<CommandResult> {
    const result = await this.runner.run(this.binPath, args, {
      timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: this.env
    });
    if (result.code !== 0) {
      throw new Error(`gws ${args.join(" ")} exited ${result.code}: ${result.stderr.slice(0, 500)}`);
    }
    return result;
  }
}

function htmlReplyBody(body: string, idempotencyKey: string): string {
  return `<div style="white-space: pre-wrap">${escapeHtml(body)}</div><!-- fluffles-delivery:${idempotencyKey} -->`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] || character);
}

function containsDeliveryMarker(value: unknown, idempotencyKey: string): boolean {
  const marker = `fluffles-delivery:${idempotencyKey}`;
  if (typeof value === "string") return value.includes(marker) || decodeBase64Url(value).includes(marker);
  if (Array.isArray(value)) return value.some((item) => containsDeliveryMarker(item, idempotencyKey));
  if (isRecord(value)) return Object.values(value).some((item) => containsDeliveryMarker(item, idempotencyKey));
  return false;
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch (_error) {
    return "";
  }
}

function draftIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.drafts)) return [];
  return value.drafts.flatMap((draft) => isRecord(draft) && typeof draft.id === "string" && draft.id ? [draft.id] : []);
}

export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty json output");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (_error) {
    for (let index = trimmed.indexOf("{"); index >= 0; index = trimmed.indexOf("{", index + 1)) {
      try {
        return JSON.parse(trimmed.slice(index)) as unknown;
      } catch (_innerError) {
        // Try the next object-looking boundary.
      }
    }
    for (let index = trimmed.indexOf("["); index >= 0; index = trimmed.indexOf("[", index + 1)) {
      try {
        return JSON.parse(trimmed.slice(index)) as unknown;
      } catch (_innerError) {
        // Try the next array-looking boundary.
      }
    }
  }
  throw new Error(`could not parse json output: ${trimmed.slice(0, 300)}`);
}

function authStatusFromUnknown(value: unknown): GwsAuthStatus {
  const record = requireRecord(value, "auth status");
  const status: GwsAuthStatus = {
    token_valid: record.token_valid === true
  };
  const tokenError = optionalString(record.token_error);
  const error = optionalString(record.error);
  const authMethod = optionalString(record.auth_method);
  const projectId = optionalString(record.project_id);
  if (tokenError) status.token_error = tokenError;
  if (error) status.error = error;
  if (authMethod) status.auth_method = authMethod;
  if (projectId) status.project_id = projectId;
  return status;
}

function messagePageFromUnknown(value: unknown): GmailMessagePage {
  const record = requireRecord(value, "messages list");
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return {
    messages: messages.map((item, index) => {
    const message = requireRecord(item, `messages[${index}]`);
    const id = requiredString(message.id, `messages[${index}].id`);
    return {
      id,
      threadId: optionalString(message.threadId) || null
    };
    }),
    nextPageToken: nextPageToken(record)
  };
}

function historyPageFromUnknown(value: unknown): GmailHistoryPage {
  const record = requireRecord(value, "gmail history list");
  const messages = new Map<string, GmailMessageSummary>();
  const history = Array.isArray(record.history) ? record.history : [];
  for (const item of history) {
    const entry = requireRecord(item, "gmail history entry");
    const candidates = [
      ...(Array.isArray(entry.messages) ? entry.messages : []),
      ...(Array.isArray(entry.messagesAdded) ? entry.messagesAdded.map((added) => isRecord(added) ? added.message : null) : [])
    ];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) continue;
      messages.set(candidate.id, { id: candidate.id, threadId: optionalString(candidate.threadId) || null });
    }
  }
  return {
    messages: [...messages.values()],
    nextPageToken: nextPageToken(record),
    historyId: optionalString(record.historyId) || null
  };
}

function nextPageToken(value: unknown): string | null {
  return isRecord(value) ? optionalString(value.nextPageToken) || null : null;
}

function deliveryIdentifiers(value: unknown, draft: boolean): {
  providerMessageId: string | null;
  providerDraftId: string | null;
  providerThreadId: string | null;
} {
  if (!isRecord(value)) return { providerMessageId: null, providerDraftId: null, providerThreadId: null };
  const message = isRecord(value.message) ? value.message : null;
  return {
    providerMessageId: optionalString(message?.id) || (draft ? null : optionalString(value.id)) || null,
    providerDraftId: draft ? optionalString(value.id) || null : null,
    providerThreadId: optionalString(message?.threadId) || optionalString(value.threadId) || null
  };
}

function gmailMessageFromUnknown(value: unknown): GmailMessage {
  if (!isRecord(value)) throw new Error("gmail message must be an object");
  return value;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${context} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isExecError(value: unknown): value is Error & { code?: unknown; stdout?: unknown; stderr?: unknown } {
  return value instanceof Error;
}
