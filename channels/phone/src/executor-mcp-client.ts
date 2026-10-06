export interface ExecutorMcpConfig {
  url: string;
  authorization: string;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

export interface ExecutorMcpClientOptions extends ExecutorMcpConfig {}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export class ExecutorMcpClient {
  private readonly options: Required<ExecutorMcpClientOptions>;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(options: ExecutorMcpClientOptions) {
    this.options = {
      protocolVersion: "2025-06-18",
      clientName: "fluffles-phone-channel",
      clientVersion: "1.0.0",
      timeoutMs: 60000,
      ...options
    };
  }

  async executeJson(code: string): Promise<unknown> {
    const result = await this.callTool("execute", { code });
    const text = textFromToolCallResult(result);
    return parseJsonFromText(text);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const response = await this.rpc({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    });
    if (!response) throw new Error("MCP tools/call returned no response");
    if (response.error) throw new Error(`MCP tools/call failed: ${response.error.message}`);
    return response.result;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    const response = await this.rpc({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: this.options.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion
        }
      }
    });
    if (!response) throw new Error("MCP initialize returned no response");
    if (response.error) throw new Error(`MCP initialize failed: ${response.error.message}`);
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async rpc(payload: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: this.options.authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      const response = await fetch(this.options.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      const text = await response.text();
      if (response.status === 202 && !text.trim()) return null;
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
      const contentType = response.headers.get("content-type") || "";
      const messages = contentType.includes("text/event-stream") ? parseSseMessages(text) : [JSON.parse(text) as unknown];
      const requestId = payload.id;
      const rpcResponse = messages.find((message): message is JsonRpcResponse =>
        isJsonRpcResponse(message) && (requestId == null || message.id === requestId)
      );
      if (!rpcResponse) throw new Error(`MCP response did not contain JSON-RPC payload: ${text.slice(0, 500)}`);
      return rpcResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function loadExecutorMcpConfig(env: NodeJS.ProcessEnv = process.env): ExecutorMcpConfig {
  const url = env.PHONE_EXECUTOR_MCP_URL;
  const authorization = env.PHONE_EXECUTOR_MCP_AUTHORIZATION;
  if (!url) throw new Error("PHONE_EXECUTOR_MCP_URL is required");
  if (!authorization) throw new Error("PHONE_EXECUTOR_MCP_AUTHORIZATION is required");
  return {
    url,
    authorization,
    timeoutMs: numberEnv(env.PHONE_EXECUTOR_MCP_TIMEOUT_MS, 60000, 1000, 5 * 60 * 1000)
  };
}

export function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  let dataLines: string[] = [];
  const flush = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data) return;
    messages.push(JSON.parse(data) as unknown);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return messages;
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
        // Try the next object boundary.
      }
    }
    for (let index = trimmed.indexOf("["); index >= 0; index = trimmed.indexOf("[", index + 1)) {
      try {
        return JSON.parse(trimmed.slice(index)) as unknown;
      } catch (_innerError) {
        // Try the next array boundary.
      }
    }
  }
  throw new Error(`could not parse json output: ${trimmed.slice(0, 300)}`);
}

function textFromToolCallResult(value: unknown): string {
  const record = requireRecord(value, "tool call result");
  const content = record.content;
  if (!Array.isArray(content)) throw new Error("tool call result content must be an array");
  const text = content
    .map((item) => requireRecord(item, "tool content"))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  if (!text) throw new Error("tool call result did not include text content");
  return text;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function numberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
