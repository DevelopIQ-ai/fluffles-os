import assert from "node:assert/strict";
import test from "node:test";
import { findAgentPhoneOutboundDelivery } from "../src/agentphone-client";
import type { NormalizedPhoneMessage } from "../src/phone-normalize";

test("reconciliation paginates beyond the first provider message window", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => outboundMessage(`page-1-${100 - index}`));
  const accepted = outboundMessage("accepted", { idempotency_key: "delivery-key" });
  const requests: Array<{ limit?: number; before?: string }> = [];
  const client = {
    async listMessages(input: { limit?: number; before?: string }): Promise<NormalizedPhoneMessage[]> {
      requests.push(input);
      return input.before ? [accepted] : firstPage;
    }
  };

  const result = await findAgentPhoneOutboundDelivery(client, "delivery-key");

  assert.equal(result?.id, "accepted");
  assert.deepEqual(requests, [{ limit: 100 }, { limit: 100, before: "page-1-1" }]);
});

function outboundMessage(id: string, raw: Record<string, unknown> = {}): NormalizedPhoneMessage {
  return {
    provider: "agentphone",
    id,
    numberId: "number-1",
    conversationId: "conv-1",
    fromNumber: "+14155550000",
    toNumber: "+14155550123",
    direction: "outbound",
    channel: "sms",
    body: "sent",
    mediaUrls: [],
    createdAt: null,
    receivedAt: null,
    raw: { id, ...raw }
  };
}
