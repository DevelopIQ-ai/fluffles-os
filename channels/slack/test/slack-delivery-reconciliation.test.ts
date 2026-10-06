import assert from "node:assert/strict";
import test from "node:test";
import { findSlackDelivery } from "../src/slack-delivery-reconciliation";

test("delivery reconciliation searches paginated Slack history before declaring a send absent", async () => {
  const visited: Array<string | null> = [];
  const found = await findSlackDelivery("delivery-key", async (cursor) => {
    visited.push(cursor);
    if (cursor == null) return { messages: [{ ts: "1", client_msg_id: "other" }], nextCursor: "page-2" };
    return {
      messages: [{ ts: "2", metadata: { event_type: "fluffles_delivery", event_payload: { idempotency_key: "delivery-key" } } }],
      nextCursor: null
    };
  });
  assert.deepEqual(visited, [null, "page-2"]);
  assert.equal(found?.ts, "2");
});

test("delivery reconciliation fails safe on a provider cursor loop", async () => {
  await assert.rejects(
    () => findSlackDelivery("delivery-key", async () => ({ messages: [], nextCursor: "loop" })),
    /cursor loop/
  );
});
