import { type IncomingMessage } from "node:http";
import {
  ReplayWindow,
  booleanEnv,
  defineChannelService,
  isLoopbackAddress,
  loadChannelEnv,
  numberEnv,
  startChannelService,
  type WebhookVerification
} from "@fluffles/tasks";
import { PhoneChannel, defaultPhoneChannelConfig } from "./phone-channel";
import { AGENTPHONE_REPLAY_WINDOW_MS, agentPhoneWebhookHeadersFromRequest, checkAgentPhoneWebhook } from "./phone-webhook";

loadChannelEnv("phone", {
  localSecretKeys: ["PHONE_EXECUTOR_MCP_AUTHORIZATION", "PHONE_WEBHOOK_SECRET", "PHONE_INTERNAL_API_SECRET"]
});

const config = defaultPhoneChannelConfig(process.env);
const webhookSecret = process.env.PHONE_WEBHOOK_SECRET || "";
const channel = new PhoneChannel({ config });
const seenWebhookDeliveries = new ReplayWindow();

const service = defineChannelService({
  service: "fluffles-channel-phone",
  host: process.env.HOST || "127.0.0.1",
  port: numberEnv(process.env.PORT, 3002, 1, 65535),
  adapter: channel,
  statusPath: config.statusPath,
  pollIntervalMs: numberEnv(process.env.PHONE_POLL_INTERVAL_MS, 60000, 5000, 60 * 60 * 1000),
  processIntervalMs: numberEnv(process.env.PHONE_PROCESS_INTERVAL_MS, 15000, 1000, 60 * 60 * 1000),
  recoveryIntervalMs: numberEnv(process.env.PHONE_RECOVERY_INTERVAL_MS, 30000, 1000, 60 * 60 * 1000),
  processLimit: numberEnv(process.env.PHONE_PROCESS_LIMIT, 5, 1, 25),
  pollingEnabled: config.pollingEnabled,
  processingEnabled: booleanEnv(process.env.PHONE_PROCESSING_ENABLED, true),
  webhookEnabled: config.webhookEnabled,
  webhookPaths: ["/webhook/phone", "/phone/inbound"],
  webhookMaxBodyBytes: numberEnv(process.env.PHONE_WEBHOOK_MAX_BODY_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
  webhookRateLimitPerMinute: numberEnv(process.env.PHONE_WEBHOOK_RATE_LIMIT_PER_MINUTE, 120, 1, 10_000),
  verifyWebhook,
  internalSecretHeader: "x-phone-internal-secret",
  internalApiSecret: process.env.PHONE_INTERNAL_API_SECRET || "",
  describe: () => ({ outboundMode: config.outboundMode, phoneNumber: config.fromNumber }),
  pollSucceeded: (result) => (result as { errors: number }).errors === 0,
  processSucceeded: (result) => (result as { failed: number }).failed === 0
});

export function verifyWebhook(request: IncomingMessage, rawBody: string): WebhookVerification {
  const headers = agentPhoneWebhookHeadersFromRequest(request);
  if (headers.signature || headers.timestamp) {
    if (!webhookSecret) return { ok: false, statusCode: 503, error: "webhook_secret_not_configured" };
    if (!headers.signature || !headers.timestamp) return { ok: false, statusCode: 401, error: "missing_agentphone_signature" };
    const checked = checkAgentPhoneWebhook(rawBody, headers, webhookSecret);
    if (!checked.ok) return { ok: false, statusCode: 401, error: checked.error };
    if (seenWebhookDeliveries.isReplay(checked.replayKey)) {
      return { ok: false, statusCode: 409, error: "replayed_webhook" };
    }
    seenWebhookDeliveries.remember(checked.replayKey, AGENTPHONE_REPLAY_WINDOW_MS);
    return { ok: true };
  }
  if (isLoopbackAddress(request.socket.remoteAddress)) return { ok: true };
  if (!webhookSecret) return { ok: false, statusCode: 503, error: "webhook_secret_not_configured" };
  return { ok: false, statusCode: 401, error: "missing_agentphone_signature" };
}

startChannelService(service, { adapter: channel, closeOnFailure: false });
