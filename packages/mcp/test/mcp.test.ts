import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest, renderCommand, validateManifest, ManifestTool, ServerManifest } from "../src/manifest";
import { createHandler } from "../src/server";

const manifestsDir = path.resolve(__dirname, "..", "..", "..", "tools", "mcp", "manifests");

function tool(overrides: Partial<ManifestTool>): ManifestTool {
  return {
    name: "echo",
    description: "echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    command: ["/bin/echo", "{text}"],
    ...overrides
  };
}

function manifest(tools: ManifestTool[]): ServerManifest {
  return validateManifest({ name: "test", tools });
}

test("manifest validation rejects malformed definitions", () => {
  assert.throws(() => validateManifest(null), /must be an object/);
  assert.throws(() => validateManifest({ name: "Bad Name", tools: [tool({})] }), /lowercase identifier/);
  assert.throws(() => validateManifest({ name: "ok", tools: [] }), /non-empty/);
  assert.throws(() => manifest([tool({}), tool({})]), /duplicate tool name/);
  assert.throws(() => manifest([tool({ description: "" })]), /description is required/);
  assert.throws(() => manifest([tool({ command: [] })]), /non-empty array/);
  assert.throws(() => manifest([tool({ command: ["/bin/echo", "{unknown}"] })]), /unknown parameter/);
  assert.throws(
    () => manifest([tool({ command: ["/bin/echo", "--flag {unknown?}"] })]),
    /unknown parameter/
  );
  assert.throws(() => manifest([tool({ timeoutMs: -5 })]), /timeoutMs/);
});

test("manifest secrets must be a single validated Infisical path", () => {
  const withSecrets = (secrets: unknown) => validateManifest({ name: "test", secrets, tools: [tool({})] });
  assert.equal((withSecrets({ path: "/services/sample" }) as ServerManifest).secrets?.path, "/services/sample");
  assert.throws(() => withSecrets("no"), /secrets must be an object/);
  assert.throws(() => withSecrets({}), /secrets\.path/);
  assert.throws(() => withSecrets({ path: "services/sample" }), /secrets\.path/);
  assert.throws(() => withSecrets({ path: "/Services/Sample" }), /secrets\.path/);
  assert.throws(() => withSecrets({ path: "/services/sample", env: ["X"] }), /unknown keys/);
});

test("renderCommand substitutes, drops optional groups, and splits variadics", () => {
  const search = tool({
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" }, extra: { type: "string" } },
      required: ["query"]
    },
    command: ["/bin/echo", "search", "{query}", "--limit {limit?}", "{extra...}"]
  });
  assert.deepEqual(
    renderCommand(search, { query: "hello world", limit: 5, extra: "a b  c" }),
    ["/bin/echo", "search", "hello world", "--limit", "5", "a", "b", "c"]
  );
  assert.deepEqual(
    renderCommand(search, { query: "q", extra: "x" }),
    ["/bin/echo", "search", "q", "x"]
  );
  assert.throws(() => renderCommand(search, {}), /missing required argument: query/);
  assert.throws(() => renderCommand(search, { query: ["not", "scalar"] }), /must be a scalar/);
});

test("a variadic accepts an array, one argv entry per element with spaces preserved", () => {
  const run = tool({
    inputSchema: {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"]
    },
    command: ["/bin/echo", "{args...}"]
  });
  assert.deepEqual(
    renderCommand(run, { args: ["pr", "create", "--title", "many words stay one arg"] }),
    ["/bin/echo", "pr", "create", "--title", "many words stay one arg"]
  );
  assert.throws(() => renderCommand(run, { args: [{ bad: true }] }), /array of scalars/);
});

test("arguments are passed as argv entries, never through a shell", () => {
  const echo = tool({});
  const rendered = renderCommand(echo, { text: "hello; rm -rf / && $(whoami) `id`" });
  assert.deepEqual(rendered, ["/bin/echo", "hello; rm -rf / && $(whoami) `id`"]);
});

async function callHandler(definition: ServerManifest, request: Record<string, unknown>) {
  const responses: Record<string, unknown>[] = [];
  const handle = createHandler(definition, (message) => responses.push(message));
  await handle({ jsonrpc: "2.0", id: 1, ...request } as any);
  return responses;
}

test("handler answers initialize, ping, and tools/list from the manifest", async () => {
  const definition = manifest([tool({})]);

  const init = await callHandler(definition, { method: "initialize" });
  assert.equal((init[0] as any).result.serverInfo.name, "test");
  assert.ok((init[0] as any).result.protocolVersion);

  const ping = await callHandler(definition, { method: "ping" });
  assert.deepEqual((ping[0] as any).result, {});

  const list = await callHandler(definition, { method: "tools/list" });
  const tools = (list[0] as any).result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");
  assert.equal(tools[0].inputSchema.type, "object");
});

test("tools/call runs the rendered command and returns its output", async () => {
  const definition = manifest([tool({})]);
  const responses = await callHandler(definition, {
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hello" } }
  });
  const result = (responses[0] as any).result;
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text.trim(), "hello");
});

test("tools/call surfaces command failure as isError, not a protocol error", async () => {
  const definition = manifest([
    tool({ name: "fail", command: ["/bin/false"], inputSchema: { type: "object", properties: {} } })
  ]);
  const responses = await callHandler(definition, {
    method: "tools/call",
    params: { name: "fail", arguments: {} }
  });
  assert.equal((responses[0] as any).result.isError, true);
});

test("a denied argument prefix is refused without running the command", async () => {
  const definition = manifest([
    tool({
      name: "cli",
      inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" } } }, required: ["args"] },
      command: ["/bin/echo", "{args...}"],
      deny: [["auth"], ["secrets", "print"]]
    })
  ]);
  const denied = await callHandler(definition, {
    method: "tools/call",
    params: { name: "cli", arguments: { args: ["auth", "token"] } }
  });
  assert.equal((denied[0] as any).result.isError, true);
  assert.match((denied[0] as any).result.content[0].text, /refused/);

  const allowed = await callHandler(definition, {
    method: "tools/call",
    params: { name: "cli", arguments: { args: ["pr", "view", "auth"] } }
  });
  assert.equal((allowed[0] as any).result.isError, false);
  assert.throws(() => manifest([tool({ deny: [[]] })]), /deny/);
});

test("unknown tools and methods produce JSON-RPC errors", async () => {
  const definition = manifest([tool({})]);
  const unknownTool = await callHandler(definition, {
    method: "tools/call",
    params: { name: "nope", arguments: {} }
  });
  assert.equal((unknownTool[0] as any).error.code, -32602);

  const unknownMethod = await callHandler(definition, { method: "bogus/method" });
  assert.equal((unknownMethod[0] as any).error.code, -32601);
});

test("missing required arguments fail the call without spawning anything", async () => {
  const definition = manifest([tool({})]);
  const responses = await callHandler(definition, {
    method: "tools/call",
    params: { name: "echo", arguments: {} }
  });
  assert.match((responses[0] as any).error.message, /missing required argument/);
});

test("every checked-in manifest is valid and home-relative", () => {
  const files = fs.readdirSync(manifestsDir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "no manifests found");
  for (const file of files) {
    const loaded = loadManifest(path.join(manifestsDir, file), "/test/home");
    assert.ok(loaded.tools.length > 0, `${file}: no tools`);
    for (const entry of loaded.tools) {
      assert.ok(entry.description.length > 0, `${file}: ${entry.name} lacks description`);
    }
    const raw = fs.readFileSync(path.join(manifestsDir, file), "utf8");
    assert.ok(!raw.includes("/Users/ai"), `${file}: names a specific harness home; use {{HOME}}`);
    const substituted = JSON.stringify(loaded);
    assert.ok(!substituted.includes("{{HOME}}"), `${file}: unsubstituted {{HOME}}`);
  }
});
