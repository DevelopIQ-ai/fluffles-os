import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { FixedWindowRateLimiter, isLoopbackAddress } from "@fluffles/tasks";

export interface AuthDecision {
  ok: boolean;
  reason: "authenticated" | "loopback" | "no_session" | "no_password_configured";
}

const sessionCookieName = "fluffles_console_session";
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
const maxAttemptsPerMinute = 10;

/**
 * Access control for a remotely reachable console: a single shared password
 * exchanged for an httpOnly session cookie. The peer address earns no trust by
 * default, because Tailscale on macOS forwards tailnet connections through
 * userspace networking, so every remote client arrives as 127.0.0.1 and a
 * loopback exemption would hand the console to the whole tailnet. A local
 * operator who wants no login opts in with `trustLoopback`.
 */
export class ConsoleAuth {
  private readonly passwordHash: Buffer | null;
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new FixedWindowRateLimiter(maxAttemptsPerMinute);

  constructor(password: string | undefined, private readonly trustLoopback = false) {
    const trimmed = password?.trim();
    this.passwordHash = trimmed ? sha256(trimmed) : null;
  }

  get configured(): boolean {
    return this.passwordHash !== null;
  }

  authorize(request: IncomingMessage): AuthDecision {
    if (this.trustLoopback && isLoopback(request)) return { ok: true, reason: "loopback" };
    if (!this.passwordHash) return { ok: false, reason: "no_password_configured" };
    const token = sessionCookie(request);
    if (token && this.validSession(token)) return { ok: true, reason: "authenticated" };
    return { ok: false, reason: "no_session" };
  }

  /** Returns a session token, or null when the password is wrong or the client is rate limited. */
  signIn(request: IncomingMessage, password: string): string | null {
    if (!this.passwordHash) return null;
    if (!this.attempts.allow(request.socket.remoteAddress)) return null;
    const supplied = sha256(password);
    if (supplied.length !== this.passwordHash.length || !timingSafeEqual(supplied, this.passwordHash)) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + sessionTtlMs);
    return token;
  }

  signOut(request: IncomingMessage): void {
    const token = sessionCookie(request);
    if (token) this.sessions.delete(token);
  }

  sessionCookie(token: string, secure: boolean): string {
    const attributes = [
      `${sessionCookieName}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(sessionTtlMs / 1000)}`
    ];
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  clearedCookie(): string {
    return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private validSession(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt == null) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
}

export function isLoopback(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress);
}

function sessionCookie(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === sessionCookieName) return rest.join("=") || null;
  }
  return null;
}


function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
