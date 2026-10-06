import { execFile } from "node:child_process";
import readline from "node:readline";
import { ManifestTool, ServerManifest, deniedPrefix, renderCommand } from "./manifest";

// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. It speaks
// just enough of the protocol for a gateway to discover and call the tools a
// manifest declares: initialize, tools/list, tools/call, ping. Commands run
// via execFile with rendered argument vectors; no shell is ever involved.

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

type Responder = (message: Record<string, unknown>) => void;

export function createHandler(manifest: ServerManifest, respond: Responder) {
  const toolsByName = new Map<string, ManifestTool>(manifest.tools.map((tool) => [tool.name, tool]));

  return async function handle(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    const reply = (result: Record<string, unknown>) => {
      if (id !== undefined && id !== null) {
        respond({ jsonrpc: "2.0", id, result });
      }
    };
    const fail = (code: number, message: string) => {
      if (id !== undefined && id !== null) {
        respond({ jsonrpc: "2.0", id, error: { code, message } });
      }
    };

    switch (request.method) {
      case "initialize":
        reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: manifest.name, version: "1.0.0" }
        });
        return;
      case "notifications/initialized":
        return;
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({
          tools: manifest.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        });
        return;
      case "tools/call": {
        const params = request.params ?? {};
        const name = params.name;
        if (typeof name !== "string" || !toolsByName.has(name)) {
          fail(-32602, `unknown tool: ${String(name)}`);
          return;
        }
        const tool = toolsByName.get(name)!;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        let command: string[];
        try {
          command = renderCommand(tool, args);
        } catch (error) {
          fail(-32602, error instanceof Error ? error.message : String(error));
          return;
        }
        const denied = deniedPrefix(tool, command);
        if (denied !== null) {
          reply({
            content: [{ type: "text", text: `refused: "${denied.join(" ")}" is a denied argument prefix for ${tool.name}` }],
            isError: true
          });
          return;
        }
        const outcome = await runCommand(command, manifest, tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        reply({
          content: [{ type: "text", text: outcome.text }],
          isError: outcome.isError
        });
        return;
      }
      default:
        fail(-32601, `method not found: ${request.method}`);
    }
  };
}

type CommandOutcome = { text: string; isError: boolean };

function runCommand(command: string[], manifest: ServerManifest, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      command[0],
      command.slice(1),
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: manifest.cwd,
        env: { ...process.env, ...manifest.env }
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stdout, stderr, error.message].filter((part) => part.length > 0).join("\n").trim();
          resolve({ text: detail.slice(0, MAX_OUTPUT_BYTES), isError: true });
          return;
        }
        const text = stdout.length > 0 ? stdout : stderr;
        resolve({ text: text.slice(0, MAX_OUTPUT_BYTES), isError: false });
      }
    );
  });
}

export function serve(manifest: ServerManifest): void {
  const respond: Responder = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const handle = createHandler(manifest, respond);
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  let queue: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    queue = queue.then(() => handle(request));
  });
  lines.on("close", () => {
    void queue.then(() => process.exit(0));
  });
}
