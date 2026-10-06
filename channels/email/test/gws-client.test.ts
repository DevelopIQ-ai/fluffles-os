import assert from "node:assert/strict";
import test from "node:test";
import { GwsClient, parseJsonFromText, type CommandRunner, type CommandResult } from "../src/gws-client";

class RecordingRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  responses: CommandResult[] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const response = this.responses.shift();
    if (!response) throw new Error("missing fake command response");
    return response;
  }
}

test("authStatus parses JSON even when gws prints a prelude", async () => {
  const runner = new RecordingRunner();
  runner.responses.push({
    code: 0,
    stdout: 'Using keyring backend: file\n{"token_valid":false,"token_error":"invalid_rapt"}\n',
    stderr: ""
  });
  const client = new GwsClient({ binPath: "/tmp/gws", runner });

  const status = await client.authStatus();

  assert.equal(status.token_valid, false);
  assert.equal(status.token_error, "invalid_rapt");
});

test("listMessages calls Gmail list with user, query, and max results", async () => {
  const runner = new RecordingRunner();
  runner.responses.push({
    code: 0,
    stdout: '{"messages":[{"id":"m1","threadId":"t1"}]}',
    stderr: ""
  });
  const client = new GwsClient({ binPath: "/tmp/gws", runner });

  const messages = await client.listMessages("in:inbox is:unread", 3);

  assert.deepEqual(messages, [{ id: "m1", threadId: "t1" }]);
  assert.deepEqual(runner.calls[0]?.args.slice(0, 4), ["gmail", "users", "messages", "list"]);
  assert.equal(JSON.parse(runner.calls[0]?.args.at(-1) || "{}").q, "in:inbox is:unread");
  assert.equal(JSON.parse(runner.calls[0]?.args.at(-1) || "{}").maxResults, 3);
});

test("listMessagesPage preserves Gmail's page token for restart-safe polling", async () => {
  const runner = new RecordingRunner();
  runner.responses.push({
    code: 0,
    stdout: '{"messages":[{"id":"m2","threadId":"t1"}],"nextPageToken":"next-page"}',
    stderr: ""
  });
  const client = new GwsClient({ binPath: "/tmp/gws", runner });

  const page = await client.listMessagesPage("in:inbox", 25, "previous-page");

  assert.deepEqual(page, { messages: [{ id: "m2", threadId: "t1" }], nextPageToken: "next-page" });
  const body = JSON.parse(runner.calls[0]?.args.at(-1) || "{}");
  assert.equal(body.pageToken, "previous-page");
});

test("listHistory returns added Gmail messages and the provider history cursor", async () => {
  const runner = new RecordingRunner();
  runner.responses.push({
    code: 0,
    stdout: '{"historyId":"42","history":[{"messagesAdded":[{"message":{"id":"m3","threadId":"t2"}}]}]}',
    stderr: ""
  });
  const client = new GwsClient({ binPath: "/tmp/gws", runner });

  const page = await client.listHistory("41", 25, null);

  assert.deepEqual(page, { messages: [{ id: "m3", threadId: "t2" }], nextPageToken: null, historyId: "42" });
  assert.deepEqual(runner.calls[0]?.args.slice(0, 4), ["gmail", "users", "history", "list"]);
  assert.deepEqual(JSON.parse(runner.calls[0]?.args.at(-1) || "{}"), { userId: "me", startHistoryId: "41", maxResults: 25 });
});

test("reply uses Gmail helper with draft flag when requested", async () => {
  const runner = new RecordingRunner();
  runner.responses.push({
    code: 0,
    stdout: '{"id":"draft-1"}',
    stderr: ""
  });
  const client = new GwsClient({ binPath: "/tmp/gws", runner });

  const result = await client.reply({
    messageId: "gmail-message-1",
    body: "I checked it.",
    from: "fluffles@puffle.ai",
    draft: true
  });

  assert.equal(result.mode, "draft");
  assert.equal(result.providerDraftId, "draft-1");
  assert.deepEqual(runner.calls[0]?.args, [
    "gmail",
    "+reply",
    "--message-id",
    "gmail-message-1",
    "--body",
    "I checked it.",
    "--format",
    "json",
    "--from",
    "fluffles@puffle.ai",
    "--draft"
  ]);
});

test("parseJsonFromText parses arrays after non-json prelude", () => {
  assert.deepEqual(parseJsonFromText("log line\n[{\"ok\":true}]"), [{ ok: true }]);
});
