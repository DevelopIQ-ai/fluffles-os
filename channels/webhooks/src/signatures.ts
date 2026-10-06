import crypto from "node:crypto";

export type VerificationResult = {
  ok: boolean;
  trusted: boolean;
  reason: string;
};

export function sha256Hex(buffer: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hmacSha256Hex(secret: string, value: crypto.BinaryLike): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifySharedSecret(headerValue: unknown, secret: string): VerificationResult {
  if (!secret) return { ok: false, trusted: false, reason: "secret-not-configured" };
  if (!headerValue) return { ok: false, trusted: false, reason: "missing-secret-header" };
  const normalized = String(headerValue).replace(/^Bearer\s+/i, "");
  const ok = safeEqual(normalized, secret);
  return { ok, trusted: ok, reason: ok ? "shared-secret-ok" : "shared-secret-mismatch" };
}

export function verifyGitHubSignature(rawBody: Buffer, signatureHeader: unknown, secret: string): VerificationResult {
  if (!secret) return { ok: false, trusted: false, reason: "github-secret-not-configured" };
  if (!signatureHeader || !String(signatureHeader).startsWith("sha256=")) return { ok: false, trusted: false, reason: "missing-github-signature" };
  const expected = `sha256=${hmacSha256Hex(secret, rawBody)}`;
  const ok = safeEqual(expected, signatureHeader);
  return { ok, trusted: ok, reason: ok ? "github-signature-ok" : "github-signature-mismatch" };
}
