import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

type GoogleJwk = { kid?: string; kty?: string; [key: string]: unknown };

export interface GmailPubSubAuthConfig {
  audience: string;
  serviceAccount: string;
  maxAgeMs: number;
  now?: () => number;
  fetchCertificates?: typeof fetch;
}

export type GmailPubSubAuthResult =
  | { ok: true; replayKey: string }
  | { ok: false; statusCode: number; error: string };

/**
 * Verifies the OIDC token attached by Cloud Pub/Sub for direct push delivery.
 * Certificates are cached by `kid`; all claim checks are local and explicit.
 */
export class GmailPubSubOidcVerifier {
  private readonly audience: string;
  private readonly serviceAccount: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly fetchCertificates: typeof fetch;
  private certificates: Record<string, GoogleJwk> | null = null;
  private certificatesExpireAt = 0;

  constructor(config: GmailPubSubAuthConfig) {
    this.audience = required(config.audience, "Gmail Pub/Sub audience");
    this.serviceAccount = required(config.serviceAccount, "Gmail Pub/Sub service account").toLowerCase();
    this.maxAgeMs = config.maxAgeMs;
    this.now = config.now ?? Date.now;
    this.fetchCertificates = config.fetchCertificates ?? fetch;
  }

  async verify(authorization: string | undefined, rawBody: string): Promise<GmailPubSubAuthResult> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return { ok: false, statusCode: 401, error: "missing_google_oidc_token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, statusCode: 401, error: "invalid_google_oidc_token" };
    try {
      const header = decodeJson(parts[0]!);
      const claims = decodeJson(parts[1]!);
      if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, statusCode: 401, error: "unsupported_google_oidc_algorithm" };
      const nowSeconds = Math.floor(this.now() / 1000);
      if (!validIssuer(claims.iss) || claims.aud !== this.audience || !validTimestamp(claims.exp, nowSeconds, 0) || !validTimestamp(claims.iat, nowSeconds, 60, true) || (claims.nbf !== undefined && !validTimestamp(claims.nbf, nowSeconds, 60, true))) {
        return { ok: false, statusCode: 401, error: "invalid_google_oidc_claims" };
      }
      const identity = typeof claims.email === "string" ? claims.email.toLowerCase() : typeof claims.sub === "string" ? claims.sub.toLowerCase() : "";
      if (identity !== this.serviceAccount || (claims.email_verified !== undefined && claims.email_verified !== true)) {
        return { ok: false, statusCode: 401, error: "invalid_google_service_account" };
      }
      const key = await this.publicKey(header.kid);
      const signature = decodeBase64Url(parts[2]!);
      if (!verifySignature("RSA-SHA256", Buffer.from(`${parts[0]!}.${parts[1]!}`), key, signature)) {
        return { ok: false, statusCode: 401, error: "invalid_google_oidc_signature" };
      }
      const messageId = pubsubMessageId(rawBody);
      const publishTime = pubsubPublishTime(rawBody);
      if (!messageId || !publishTime || Math.abs(this.now() - publishTime) > this.maxAgeMs) {
        return { ok: false, statusCode: 401, error: "stale_or_malformed_google_pubsub_message" };
      }
      // Pub/Sub may reuse a valid OIDC token for many messages. Replay is
      // therefore keyed by the provider message id, not the JWT itself.
      return { ok: true, replayKey: `google:${messageId}:${createHash("sha256").update(token).digest("hex")}` };
    } catch {
      return { ok: false, statusCode: 401, error: "invalid_google_oidc_token" };
    }
  }

  private async publicKey(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    if (!this.certificates || this.certificatesExpireAt <= this.now() || !this.certificates[kid]) await this.refreshCertificates();
    const jwk = this.certificates?.[kid];
    if (!jwk) throw new Error("unknown_google_oidc_key");
    return createPublicKey({ key: jwk as never, format: "jwk" });
  }

  private async refreshCertificates(): Promise<void> {
    const response = await this.fetchCertificates("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) throw new Error(`google_oidc_certificates_${response.status}`);
    const value = await response.json() as unknown;
    if (!isRecord(value) || !Array.isArray(value.keys)) throw new Error("invalid_google_oidc_certificates");
    const certificates: Record<string, GoogleJwk> = {};
    for (const item of value.keys) {
      if (isRecord(item) && typeof item.kid === "string" && item.kty === "RSA") certificates[item.kid] = item as GoogleJwk;
    }
    if (Object.keys(certificates).length === 0) throw new Error("empty_google_oidc_certificates");
    this.certificates = certificates;
    this.certificatesExpireAt = this.now() + cacheMaxAgeMs(response.headers.get("cache-control"));
  }
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function decodeJson(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(decodeBase64Url(segment).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("jwt_section_not_object");
  return parsed;
}
function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  return Buffer.from(value, "base64url");
}
function validIssuer(value: unknown): boolean { return value === "accounts.google.com" || value === "https://accounts.google.com"; }
function validTimestamp(value: unknown, nowSeconds: number, skewSeconds: number, issuedAt = false): boolean {
  return typeof value === "number" && Number.isFinite(value) && (issuedAt ? value <= nowSeconds + skewSeconds : value >= nowSeconds - skewSeconds);
}
function cacheMaxAgeMs(header: string | null): number {
  const seconds = header?.match(/max-age=(\d+)/i)?.[1];
  return Math.min(24 * 60 * 60 * 1000, Math.max(60_000, (seconds ? Number(seconds) : 3600) * 1000));
}
function pubsubEnvelope(rawBody: string): Record<string, unknown> {
  const value = JSON.parse(rawBody) as unknown;
  if (!isRecord(value) || !isRecord(value.message)) throw new Error("invalid_pubsub_envelope");
  return value.message;
}
function pubsubMessageId(rawBody: string): string | null {
  const value = pubsubEnvelope(rawBody).messageId;
  return typeof value === "string" && value ? value : null;
}
function pubsubPublishTime(rawBody: string): number | null {
  const value = pubsubEnvelope(rawBody).publishTime;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
