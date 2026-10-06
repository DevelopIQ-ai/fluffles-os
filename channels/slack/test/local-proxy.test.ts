import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalProxyEvent,
  localProxyText,
  materializeLocalProxyEvent
} from "../src/local-proxy";

test("local proxy only matches bridge-authored prefixed messages", () => {
  const options = { botUserId: "U_BOT", botId: "B_BOT", prefix: "LOCAL_PROXY:", userId: "U_KUSH" };

  assert.equal(isLocalProxyEvent({ user: "U_BOT", text: "LOCAL_PROXY: ping" }, options), true);
  assert.equal(isLocalProxyEvent({ bot_id: "B_BOT", text: "  LOCAL_PROXY: ping" }, options), true);
  assert.equal(isLocalProxyEvent({ user: "U_BOT", text: "normal bot output" }, options), false);
  assert.equal(isLocalProxyEvent({ user: "U_KUSH", text: "LOCAL_PROXY: ping" }, options), false);
});

test("materializeLocalProxyEvent strips the prefix and reattributes the event", () => {
  const event = {
    type: "message",
    user: "U_BOT",
    bot_id: "B_BOT",
    subtype: "bot_message",
    event_id: "Ev1",
    text: "  LOCAL_PROXY: please check status"
  };

  const materialized = materializeLocalProxyEvent(event, {
    botUserId: "U_BOT",
    botId: "B_BOT",
    prefix: "LOCAL_PROXY:",
    userId: "U_KUSH"
  });

  assert.equal(materialized.user, "U_KUSH");
  assert.equal(materialized.bot_id, null);
  assert.equal(materialized.subtype, undefined);
  assert.equal(materialized.event_id, "local-proxy:Ev1");
  assert.equal(materialized.text, "please check status");
});

test("localProxyText is stable for unprefixed text", () => {
  assert.equal(localProxyText("hello", "LOCAL_PROXY:"), "hello");
});
