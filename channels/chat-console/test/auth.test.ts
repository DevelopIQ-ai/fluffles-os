import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { ConsoleAuth } from "../src/auth";

function request(address: string, cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: address }
  } as unknown as IncomingMessage;
}

test("a local operator who opts in reaches the console without a password", () => {
  const auth = new ConsoleAuth(undefined, true);
  assert.deepEqual(auth.authorize(request("127.0.0.1")), { ok: true, reason: "loopback" });
});

test("a console with no password configured refuses every client", () => {
  const auth = new ConsoleAuth(undefined);
  assert.deepEqual(auth.authorize(request("100.64.0.9")), { ok: false, reason: "no_password_configured" });
  assert.deepEqual(auth.authorize(request("127.0.0.1")), { ok: false, reason: "no_password_configured" });
});

test("a loopback peer address does not skip the password", () => {
  // Tailscale on macOS proxies tailnet connections through userspace
  // networking, so a remote browser reaches the console as 127.0.0.1.
  const auth = new ConsoleAuth("console-password");
  assert.deepEqual(auth.authorize(request("127.0.0.1")), { ok: false, reason: "no_session" });

  const token = auth.signIn(request("127.0.0.1"), "console-password");
  assert.ok(token);
  assert.deepEqual(
    auth.authorize(request("127.0.0.1", `fluffles_console_session=${token}`)),
    { ok: true, reason: "authenticated" }
  );
});

test("the shared password buys a session cookie the console then accepts", () => {
  const auth = new ConsoleAuth("console-password");
  const remote = request("100.64.0.9");

  assert.equal(auth.signIn(remote, "wrong"), null);
  const token = auth.signIn(remote, "console-password");
  assert.ok(token);

  const cookie = auth.sessionCookie(token, true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  const signed = request("100.64.0.9", `fluffles_console_session=${token}`);
  assert.deepEqual(auth.authorize(signed), { ok: true, reason: "authenticated" });

  auth.signOut(signed);
  assert.deepEqual(auth.authorize(signed), { ok: false, reason: "no_session" });
});

test("guessing is rate limited per client", () => {
  const auth = new ConsoleAuth("console-password");
  const remote = request("100.64.0.9");
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal(auth.signIn(remote, "wrong"), null);
  assert.equal(auth.signIn(remote, "console-password"), null);
  assert.equal(auth.signIn(request("100.64.0.10"), "console-password") === null, false);
});
