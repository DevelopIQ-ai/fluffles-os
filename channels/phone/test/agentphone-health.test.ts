import assert from "node:assert/strict";
import test from "node:test";
import { checkAgentPhoneHealth } from "../src/agentphone-health";

test("AgentPhone health probe uses a bounded read-only message request", async () => {
  let received: unknown;
  const result = await checkAgentPhoneHealth({
    async listMessages(input) {
      received = input;
      return [];
    }
  });
  assert.deepEqual(received, { limit: 1 });
  assert.equal(result.ok, true);
  assert.match(result.detail, /read probe/);
});

test("AgentPhone health probe returns a safe failed result", async () => {
  const result = await checkAgentPhoneHealth({
    async listMessages() {
      throw new Error("Executor unavailable");
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "Executor unavailable");
});
