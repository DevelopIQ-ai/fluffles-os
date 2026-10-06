import { type IncomingMessage } from "node:http";
import {
  ReplayWindow,
  booleanEnv,
  defineChannelService,
  headerValue,
  isLoopbackAddress,
  loadChannelEnv,
  numberEnv,
  startChannelService,
  verifySignedWebhook,
  type WebhookVerification
} from "@fluffles/tasks";
import { EmailChannel, defaultEmailChannelConfig } from "./email-channel";
import { GmailPubSubOidcVerifier } from "./gmail-pubsub-auth";

loadChannelEnv("email", { localSecretKeys: ["EMAIL_WEBHOOK_SECRET", "EMAIL_INTERNAL_API_SECRET"] });

const config = defaultEmailChannelConfig(process.env);
const webhookMaxAgeMs = numberEnv(process.env.EMAIL_WEBHOOK_MAX_AGE_MS, 5 * 60 * 1000, 10_000, 15 * 60 * 1000);
const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET || "";
const gmailPubSubAudience = process.env.EMAIL_GMAIL_PUBSUB_AUDIENCE || "";
const gmailPubSubServiceAccount = process.env.EMAIL_GMAIL_PUBSUB_SERVICE_ACCOUNT || "";
const gmailPubSubVerifier = gmailPubSubAudience && gmailPubSubServiceAccount
  ? new GmailPubSubOidcVerifier({ audience: gmailPubSubAudience, serviceAccount: gmailPubSubServiceAccount, maxAgeMs: webhookMaxAgeMs })
  : null;

const channel = new EmailChannel({ config });
const seenWebhookSignatures = new ReplayWindow();

const service = defineChannelService({
  service: "fluffles-channel-email",
  host: process.env.HOST || "127.0.0.1",
  port: numberEnv(process.env.PORT, 3001, 1, 65535),
  adapter: channel,
  statusPath: config.statusPath,
  pollIntervalMs: numberEnv(process.env.EMAIL_POLL_INTERVAL_MS, 60000, 5000, 60 * 60 * 1000),
  processIntervalMs: numberEnv(process.env.EMAIL_PROCESS_INTERVAL_MS, 15000, 1000, 60 * 60 * 1000),
  recoveryIntervalMs: numberEnv(process.env.EMAIL_RECOVERY_INTERVAL_MS, 30000, 1000, 60 * 60 * 1000),
  processLimit: numberEnv(process.env.EMAIL_PROCESS_LIMIT, 5, 1, 25),
  pollingEnabled: config.pollingEnabled,
  processingEnabled: booleanEnv(process.env.EMAIL_PROCESSING_ENABLED, true),
  webhookEnabled: config.webhookEnabled,
  webhookPaths: ["/webhook/email", "/email/inbound"],
  webhookMaxBodyBytes: numberEnv(process.env.EMAIL_WEBHOOK_MAX_BODY_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024),
  webhookRateLimitPerMinute: numberEnv(process.env.EMAIL_WEBHOOK_RATE_LIMIT_PER_MINUTE, 120, 1, 10_000),
  verifyWebhook,
  internalSecretHeader: "x-email-internal-secret",
  internalApiSecret: process.env.EMAIL_INTERNAL_API_SECRET || "",
  describe: () => ({ outboundMode: config.outboundMode })
});

export async function verifyWebhook(request: IncomingMessage, rawBody: string): Promise<WebhookVerification> {
  const signature = headerValue(request, "x-email-webhook-signature");
  const timestamp = headerValue(request, "x-email-webhook-timestamp");
  if (signature || timestamp) {
    return verifySignedWebhook({
      rawBody,
      signature,
      timestamp,
      secret: webhookSecret,
      maxAgeMs: webhookMaxAgeMs,
      replay: seenWebhookSignatures
    });
  }
  const authorization = headerValue(request, "authorization");
  if (authorization?.startsWith("Bearer ")) {
    if (!gmailPubSubVerifier) return { ok: false, statusCode: 503, error: "gmail_pubsub_oidc_not_configured" };
    const result = await gmailPubSubVerifier.verify(authorization, rawBody);
    if (!result.ok) {
      console.warn(JSON.stringify({ service: "fluffles-channel-email", event: "gmail_pubsub_rejected", reason: result.error }));
      return result;
    }
    if (seenWebhookSignatures.isReplay(result.replayKey)) return { ok: false, statusCode: 409, error: "replayed_webhook" };
    seenWebhookSignatures.remember(result.replayKey, webhookMaxAgeMs);
    return { ok: true };
  }
  if (isLoopbackAddress(request.socket.remoteAddress)) return { ok: true };
  // Remote ingress must be signed. The local Amalgm bridge remains compatible
  // because the service binds to loopback by default.
  if (!webhookSecret) return { ok: false, statusCode: 503, error: "webhook_secret_not_configured" };
  return { ok: false, statusCode: 401, error: "missing_webhook_signature" };
}

startChannelService(service, { adapter: channel });
