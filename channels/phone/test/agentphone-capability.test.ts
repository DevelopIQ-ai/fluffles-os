import assert from "node:assert/strict";
import test from "node:test";
import { executeAgentPhoneCapability } from "../src/agentphone-capability";
import type { PhoneAgentPhoneClient } from "../src/agentphone-client";

test("AgentPhone capability bridge dispatches only typed operations", async () => {
  const calls: string[] = [];
  const client: PhoneAgentPhoneClient = {
    async listMessages(input) {
      calls.push(`messages:${input.limit || 0}`);
      return [];
    },
    async listCalls(input) {
      calls.push(`calls:${input.limit || 0}`);
      return [];
    },
    async getCallTranscript(callId) {
      calls.push(`transcript:${callId}`);
      return { callId };
    },
    async sendMessage(input) {
      calls.push(`send:${input.toNumber}`);
      return { providerMessageId: "message-1", response: {} };
    }
  };

  await executeAgentPhoneCapability(client, { operation: "list-messages", input: { limit: 1 } });
  await executeAgentPhoneCapability(client, { operation: "get-call-transcript", input: { callId: "call-1" } });
  await executeAgentPhoneCapability(client, { operation: "send-message", input: { toNumber: "+14155550100", body: "hello" } });
  assert.deepEqual(calls, ["messages:1", "transcript:call-1", "send:+14155550100"]);
});
