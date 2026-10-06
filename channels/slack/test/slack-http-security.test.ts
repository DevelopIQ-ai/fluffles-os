import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
  readSlackRequestBody,
  SlackRequestBodyLimitError,
  verifySlackRequest
} from "../src/slack-http-security";

function request(headers: Record<string, string>): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, { headers });
  return stream as unknown as IncomingMessage;
}

test("Slack request verification rejects stale, malformed, and replay-window-expired signatures", () => {
  const secret = "signing-secret";
  const body = '{"type":"event_callback"}';
  const now = 1_700_000_000_000;
  const timestamp = String(now / 1000);
  const signature = `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  assert.equal(verifySlackRequest(request({ "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }), body, secret, now), true);
  assert.equal(verifySlackRequest(request({ "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=invalid" }), body, secret, now), false);
  assert.equal(verifySlackRequest(request({ "x-slack-request-timestamp": "not-a-time", "x-slack-signature": signature }), body, secret, now), false);
  assert.equal(verifySlackRequest(request({ "x-slack-request-timestamp": String(now / 1000 - 301), "x-slack-signature": signature }), body, secret, now), false);
});

test("Slack request bodies are bounded before parsing", async () => {
  const input = request({}) as unknown as PassThrough;
  const result = readSlackRequestBody(input as unknown as IncomingMessage, 8);
  input.end("0123456789");
  await assert.rejects(result, SlackRequestBodyLimitError);
});
