import assert from "node:assert/strict";
import test from "node:test";
import { isThreadRequestAckAlreadyPresent, threadRequestAckPolicy } from "../src/thread-request-ack";
import type { IntakeDisposition } from "../src/thread-request-store";

const workDispositions: IntakeDisposition[] = [
  "new_request",
  "running_update",
  "queued_update",
  "thread_update"
];

test("work request intake is acknowledged with an eyes reaction", () => {
  for (const disposition of workDispositions) {
    assert.deepEqual(threadRequestAckPolicy(disposition), {
      kind: "reaction",
      reactionName: "eyes"
    });
  }
});

test("duplicate intake does not acknowledge again", () => {
  assert.deepEqual(threadRequestAckPolicy("duplicate"), { kind: "none" });
});


test("already_reacted is treated as an already-present thread ack", () => {
  const error = Object.assign(new Error("Slack reactions.add failed: already_reacted"), {
    slack: { ok: false, error: "already_reacted" }
  });

  assert.equal(isThreadRequestAckAlreadyPresent(error), true);
  assert.equal(isThreadRequestAckAlreadyPresent(new Error("other failure")), false);
  assert.equal(isThreadRequestAckAlreadyPresent({ slack: { ok: false, error: "ratelimited" } }), false);
});
