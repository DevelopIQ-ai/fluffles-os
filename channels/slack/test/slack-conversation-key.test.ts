import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSlackConversationKey,
  legacySlackConversationKeys,
  rootTsForSlackEvent
} from "../src/slack-conversation-key";

test("canonicalSlackConversationKey uses slack:team:channel:rootTs", () => {
  assert.equal(
    canonicalSlackConversationKey({ teamId: "T1", channelId: "C1", rootTs: "1000.1" }),
    "slack:T1:C1:1000.1"
  );
});

test("legacySlackConversationKeys exposes historical thread and DM keys", () => {
  assert.deepEqual(
    legacySlackConversationKeys({ teamId: "T1", channelId: "C1", rootTs: "1000.1", surface: "ambient" }),
    ["thread:C1:1000.1"]
  );
  assert.deepEqual(
    legacySlackConversationKeys({ teamId: "T1", channelId: "D1", rootTs: "1000.1", surface: "dm" }),
    ["dm:D1"]
  );
});

test("rootTsForSlackEvent prefers thread_ts", () => {
  assert.equal(rootTsForSlackEvent("2000.2", "1000.1"), "2000.2");
  assert.equal(rootTsForSlackEvent(null, "1000.1"), "1000.1");
});
