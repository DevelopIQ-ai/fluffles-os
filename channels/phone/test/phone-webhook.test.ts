import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { checkAgentPhoneWebhook, verifyAgentPhoneWebhook } from "../src/phone-webhook";

const secret = "test-webhook-secret";

test("accepts a current AgentPhone webhook with a valid signature", () => {
  const rawBody = '{"event":"agent.message","data":{"id":"message-1"}}';
  const timestamp = String(Math.floor(Date.now() / 1000));

  assert.equal(verifyAgentPhoneWebhook(rawBody, signedHeaders(rawBody, timestamp), secret), true);
});

test("rejects tampered and stale AgentPhone webhook replays", () => {
  const rawBody = '{"event":"agent.message","data":{"id":"message-1"}}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = signedHeaders(rawBody, timestamp);

  assert.equal(verifyAgentPhoneWebhook(`${rawBody}x`, headers, secret), false);
  assert.equal(verifyAgentPhoneWebhook(rawBody, signedHeaders(rawBody, String(Number(timestamp) - 301)), secret), false);
});

test("a stale signature is reported apart from a forged one", () => {
  const rawBody = '{"event":"agent.message","data":{"id":"message-1"}}';
  const timestamp = String(Math.floor(Date.now() / 1000));

  assert.deepEqual(checkAgentPhoneWebhook(rawBody, signedHeaders(rawBody, String(Number(timestamp) - 301)), secret), {
    ok: false,
    error: "stale_agentphone_signature"
  });
  assert.deepEqual(checkAgentPhoneWebhook(`${rawBody}x`, signedHeaders(rawBody, timestamp), secret), {
    ok: false,
    error: "invalid_agentphone_signature"
  });
  assert.deepEqual(checkAgentPhoneWebhook(rawBody, { signature: "sha256=zz", timestamp: "not-a-number" }, secret), {
    ok: false,
    error: "invalid_agentphone_signature"
  });
});

test("the replay key prefers AgentPhone's delivery id and falls back to the signature", () => {
  const rawBody = '{"event":"agent.message","data":{"id":"message-1"}}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = signedHeaders(rawBody, timestamp);

  const withId = checkAgentPhoneWebhook(rawBody, { ...headers, webhookId: "delivery-1" }, secret);
  assert.deepEqual(withId, { ok: true, replayKey: "id:delivery-1" });

  const withoutId = checkAgentPhoneWebhook(rawBody, headers, secret);
  assert.deepEqual(withoutId, { ok: true, replayKey: `sig:${headers.signature}` });

  // A redelivery of the same body under a fresh timestamp is a different
  // signature, so the id is what makes provider retries one event.
  const later = checkAgentPhoneWebhook(rawBody, signedHeaders(rawBody, String(Number(timestamp) - 1)), secret);
  assert.ok(later.ok && later.replayKey !== withoutId.replayKey && withId.ok);
});

function signedHeaders(rawBody: string, timestamp: string): { signature: string; timestamp: string } {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, signature: `sha256=${signature}` };
}
