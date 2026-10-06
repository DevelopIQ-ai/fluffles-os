import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { GmailPubSubOidcVerifier } from "../src/gmail-pubsub-auth";

const now = Date.parse("2026-07-30T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

function token(claims: Record<string, unknown>): string {
  const header = base64url({ alg: "RS256", kid: "test-key" });
  const payload = base64url(claims);
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64url(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function body(publishTime = new Date(now).toISOString()): string {
  return JSON.stringify({ message: { messageId: "pubsub-message-1", publishTime, data: "e30=" } });
}
function verifier(): GmailPubSubOidcVerifier {
  return new GmailPubSubOidcVerifier({
    audience: "https://email.example/webhook/email",
    serviceAccount: "gmail-push@example.iam.gserviceaccount.com",
    maxAgeMs: 5 * 60_000,
    now: () => now,
    fetchCertificates: async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", kty: "RSA" }] }), {
      status: 200, headers: { "cache-control": "max-age=600" }
    })
  });
}
function validClaims(): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com", aud: "https://email.example/webhook/email",
    email: "gmail-push@example.iam.gserviceaccount.com", email_verified: true,
    iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 300
  };
}

test("verifies a direct Gmail Pub/Sub OIDC token and derives a message replay key", async () => {
  const result = await verifier().verify(`Bearer ${token(validClaims())}`, body());
  assert.deepEqual(result.ok, true);
  if (result.ok) assert.match(result.replayKey, /^google:pubsub-message-1:/);
});

test("rejects direct Gmail Pub/Sub tokens with invalid audience, expiry, or stale payload", async () => {
  const invalidAudience = await verifier().verify(`Bearer ${token({ ...validClaims(), aud: "https://wrong.example" })}`, body());
  assert.deepEqual(invalidAudience, { ok: false, statusCode: 401, error: "invalid_google_oidc_claims" });
  const expired = await verifier().verify(`Bearer ${token({ ...validClaims(), exp: Math.floor(now / 1000) - 1 })}`, body());
  assert.deepEqual(expired, { ok: false, statusCode: 401, error: "invalid_google_oidc_claims" });
  const stale = await verifier().verify(`Bearer ${token(validClaims())}`, body(new Date(now - 6 * 60_000).toISOString()));
  assert.deepEqual(stale, { ok: false, statusCode: 401, error: "stale_or_malformed_google_pubsub_message" });
});
