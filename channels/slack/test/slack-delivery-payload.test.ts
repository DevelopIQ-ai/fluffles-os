import assert from "node:assert/strict";
import test from "node:test";
import {
  createSlackDeliveryPayload,
  parseSlackDeliveryPayload,
  type SlackDeliveryPayload
} from "../src/slack-delivery-payload";

type DeliveryInput = Parameters<typeof parseSlackDeliveryPayload>[0];

function delivery(payload: DeliveryInput["payload"]): DeliveryInput {
  return { id: "delivery-1", payload };
}

function payload(surface: SlackDeliveryPayload["surface"]): SlackDeliveryPayload {
  return createSlackDeliveryPayload({
    channel: "C1",
    sourceTs: "1000.0001",
    threadTs: "1000.0001",
    surface,
    text: "reply"
  });
}

test("Slack delivery payload accepts every runtime delivery surface", () => {
  for (const surface of ["ambient", "mention", "thread", "dm", "message"] as const) {
    assert.deepEqual(parseSlackDeliveryPayload(delivery(payload(surface))), payload(surface));
  }
});

test("Slack delivery payload rejects malformed values", () => {
  assert.throws(() => parseSlackDeliveryPayload(delivery({
    channel: "C1",
    sourceTs: "1000.0001",
    threadTs: "1000.0001",
    surface: "threaded",
    text: "reply"
  })), /invalid Slack delivery payload delivery-1/);
  assert.throws(() => parseSlackDeliveryPayload(delivery({
    channel: "C1",
    surface: "thread",
    text: "reply"
  })), /invalid Slack delivery payload delivery-1/);
  assert.throws(() => parseSlackDeliveryPayload(delivery({
    channel: "C1",
    sourceTs: "1000.0001",
    surface: "thread",
    text: 42
  })), /invalid Slack delivery payload delivery-1/);
});
