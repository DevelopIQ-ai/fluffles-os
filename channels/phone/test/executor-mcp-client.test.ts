import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ExecutorMcpClient, loadExecutorMcpConfig, parseJsonFromText, parseSseMessages } from "../src/executor-mcp-client";

test("loads executor configuration only from the injected runtime environment", () => {
  const config = loadExecutorMcpConfig({
    PHONE_EXECUTOR_MCP_URL: "https://executor.sh/org_123/mcp",
    PHONE_EXECUTOR_MCP_AUTHORIZATION: "Bearer test-token"
  });
  assert.deepEqual(config, {
    url: "https://executor.sh/org_123/mcp",
    authorization: "Bearer test-token",
    timeoutMs: 60000
  });
});

test("rejects a missing injected executor authorization", () => {
  assert.throws(
    () => loadExecutorMcpConfig({ PHONE_EXECUTOR_MCP_URL: "https://executor.sh/org_123/mcp" }),
    /PHONE_EXECUTOR_MCP_AUTHORIZATION is required/
  );
});

test("does not use legacy Codex configuration or bearer-token fallbacks", () => {
  assert.throws(
    () => loadExecutorMcpConfig({
      HOME: "/tmp/legacy-codex-home",
      CODEX_CONFIG_PATH: "/tmp/legacy-codex-config.toml",
      PHONE_EXECUTOR_MCP_CONFIG_PATH: "/tmp/legacy-phone-config.toml",
      PHONE_EXECUTOR_MCP_BEARER_TOKEN: "legacy-token",
      PHONE_EXECUTOR_MCP_URL: "https://executor.sh/org_123/mcp"
    }),
    /PHONE_EXECUTOR_MCP_AUTHORIZATION is required/
  );
});

test("parses event-stream JSON-RPC messages", () => {
  const messages = parseSseMessages(`event: message
id: 1
data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}

`);
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("parses json embedded after log text", () => {
  assert.deepEqual(parseJsonFromText("log line\n{\"ok\":true}"), { ok: true });
});

test("ignores MCP notifications that precede the matching tool response", async (t) => {
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method?: string };
    if (payload.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    if (payload.method === "initialize") {
      response.end(`data: {"jsonrpc":"2.0","id":${payload.id},"result":{"protocolVersion":"2025-06-18"}}\n\n`);
      return;
    }
    response.end(
      `data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n` +
      `data: {"jsonrpc":"2.0","id":${payload.id},"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n`
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const client = new ExecutorMcpClient({
    url: `http://127.0.0.1:${address.port}`,
    authorization: "Bearer test"
  });
  assert.deepEqual(await client.executeJson("return { ok: true };"), { ok: true });
});
