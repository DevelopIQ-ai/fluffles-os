import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAutomationRequestBody,
  parseCodexJsonEvent,
  parseSlackApiResponse,
  parseSlackEventsPayload,
  parseSocketEnvelope
} from "../src/slack-api-response";

test("Slack API responses are parsed into typed fields", () => {
  const response = parseSlackApiResponse({
    ok: true,
    team: "Puffle",
    channel: "C1",
    ts: "2.000",
    message: { type: "message", channel: "C1", ts: "2.000", text: "posted" },
    channels: [{ id: "C1", is_member: true }],
    messages: [{ type: "message", channel: "C1", ts: "1.000", text: "hi" }],
    response_metadata: { next_cursor: "next" }
  });

  assert.equal(response.ok, true);
  assert.equal(response.channel, "C1");
  assert.equal(response.ts, "2.000");
  assert.equal(response.message?.text, "posted");
  assert.equal(response.channels?.[0]?.id, "C1");
  assert.equal(response.messages?.[0]?.text, "hi");
  assert.equal(response.response_metadata?.next_cursor, "next");
});

test("Slack API response parser rejects malformed fields", () => {
  assert.throws(() => parseSlackApiResponse(null), /must be an object/);
  assert.throws(() => parseSlackApiResponse({ ok: "yes" }), /ok must be a boolean/);
  assert.throws(() => parseSlackApiResponse({ messages: [{ channel: "C1", ts: 123 }] }), /ts must be a string/);
});

test("Socket and webhook payloads require real Slack events", () => {
  const socket = parseSocketEnvelope({
    type: "events_api",
    envelope_id: "E1",
    payload: { type: "event_callback", event: { type: "message", channel: "C1", ts: "1.000", text: "hi" } }
  });
  assert.equal(socket.payload?.event?.channel, "C1");

  const webhook = parseSlackEventsPayload({
    type: "event_callback",
    event_id: "Ev1",
    event: { type: "message", channel: "C1", ts: "1.000", text: "hi" }
  });
  assert.equal(webhook.event?.ts, "1.000");
  assert.throws(() => parseSlackEventsPayload({ type: "event_callback", event: { channel: "C1" } }), /ts must be a string/);
});

test("automation and Codex JSON payloads are typed", () => {
  const automation = parseAutomationRequestBody({
    dryRun: true,
    payload: { slackEvent: { type: "message", channel: "C1", ts: "1.000" }, responseText: "ok" }
  });
  assert.equal(automation.payload?.slackEvent?.channel, "C1");

  const codex = parseCodexJsonEvent({ type: "agent_message", item: { type: "agent_message", text: "done" } });
  assert.equal(codex.item?.text, "done");
  assert.throws(() => parseAutomationRequestBody({ dryRun: "true" }), /dryRun must be a boolean/);
});
