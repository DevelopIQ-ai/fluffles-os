import { createHmac } from "node:crypto";

/**
 * Signs a relayed provider event and posts it to the automations daemon.
 *
 * The relay lives on the far side of a provider we do not control, so the
 * shared secret stays here: the provider only pipes the event it received into
 * this command and reports whether it exited cleanly. A non-zero exit is the
 * provider's signal to redeliver, and the daemon deduplicates on the delivery
 * id this command forwards.
 */

const endpoint = process.env.AUTOMATIONS_RELAY_URL ?? "http://127.0.0.1:8788/events/inbound";
const timeoutMs = Number(process.env.AUTOMATIONS_RELAY_TIMEOUT_MS ?? 30000);

function fail(message: string): never {
  process.stderr.write(`automations-relay: ${message}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function envelope(raw: string): { source: string; event: string; payload: unknown; deliveryId: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("stdin was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) fail("stdin was not a JSON object");
  const record = parsed as Record<string, unknown>;
  const source = typeof record.source === "string" ? record.source : "";
  const event = typeof record.event === "string" ? record.event : "";
  if (!source || !event) fail("the event envelope needs a source and an event");
  const deliveryId = typeof record.deliveryId === "string" && record.deliveryId ? record.deliveryId : null;
  return { source, event, payload: record.payload ?? {}, deliveryId };
}

async function main(): Promise<void> {
  const secretEnv = process.env.AUTOMATIONS_EVENT_SECRET_ENV ?? "AUTOMATIONS_EVENT_SECRET";
  const secret = process.env[secretEnv];
  if (!secret) fail(`${secretEnv} is not in the environment; run this through infisical-run`);

  if (process.argv.includes("--health")) {
    // A health probe must never deliver an event, so it proves only the two
    // halves this command depends on: the secret above, and a daemon that
    // answers on the endpoint it would post to.
    const health = new URL("/healthz", endpoint);
    const probe = await fetch(health, { signal: AbortSignal.timeout(timeoutMs) }).catch((error: unknown) =>
      fail(`could not reach ${health.href}: ${(error as Error).message}`)
    );
    if (!probe.ok) fail(`daemon answered ${probe.status} at ${health.href}`);
    process.stdout.write(`ok ${health.href}\n`);
    return;
  }

  const { source, event, payload, deliveryId } = envelope(await readStdin());
  const body = Buffer.from(JSON.stringify({ source, event, payload }), "utf8");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-webhook-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  };
  // Without a delivery id the daemon falls back to hashing these bytes, which
  // is weaker: two identical events would collapse into one run.
  if (deliveryId) headers["x-delivery-id"] = deliveryId;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs)
  }).catch((error: unknown) => fail(`could not reach ${endpoint}: ${(error as Error).message}`));

  const text = await response.text();
  if (!response.ok) fail(`daemon answered ${response.status}: ${text.slice(0, 500)}`);
  process.stdout.write(`${text}\n`);
}

void main().catch((error: unknown) => fail((error as Error).message));
