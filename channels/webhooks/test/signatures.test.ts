import test from "node:test";
import assert from "node:assert/strict";
import { hmacSha256Hex, verifyGitHubSignature, verifySharedSecret } from "../src/signatures";

test("verifies shared secrets", () => {
  assert.equal(verifySharedSecret("secret", "secret").ok, true);
  assert.equal(verifySharedSecret("Bearer secret", "secret").ok, true);
  assert.equal(verifySharedSecret("wrong", "secret").ok, false);
});

test("verifies GitHub signatures", () => {
  const body = Buffer.from('{"ok":true}');
  const secret = "github-secret";
  const signature = `sha256=${hmacSha256Hex(secret, body)}`;
  assert.equal(verifyGitHubSignature(body, signature, secret).ok, true);
  assert.equal(verifyGitHubSignature(body, signature, "wrong").ok, false);
});
