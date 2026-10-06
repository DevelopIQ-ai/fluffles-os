#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Registers every manifest in tools/mcp/manifests as a stdio MCP integration
// on the local Executor daemon, idempotently: an integration whose command
// and manifest fingerprint already match is left alone, a drifted one is
// replaced (which makes the daemon re-discover the tools), and integrations
// are never removed here (removal is a deliberate act, not a sync side
// effect). Run after deploy so the catalog always reflects the shipped
// manifests.

// @ts-expect-error the deploy host library ships no type declarations
import { hostServices, resolveHost } from "../../../deploy/lib/host.mjs";

const HOME = process.env.FLUFFLES_HOME ?? process.env.HOME ?? os.homedir();
const PORT = process.env.EXECUTOR_PORT ?? executorPortFromHost();
const BASE = `http://127.0.0.1:${PORT}`;

// One source of truth for the port: the rendered executor service from the
// deploy host config, the same declaration the daemon and launchd use.
function executorPortFromHost(): string {
  const host = resolveHost({ name: process.env.FLUFFLES_HOST ?? "", home: HOME });
  const service = hostServices(host).find((candidate: { name: string }) => candidate.name === "executor");
  if (!service) throw new Error(`host ${host.name} does not run executor`);
  const port = service.env?.EXECUTOR_PORT;
  if (typeof port !== "string" || port.length === 0) throw new Error("executor service declares no EXECUTOR_PORT");
  return port;
}
const MANIFESTS_DIR = path.join(HOME, "tools", "mcp", "manifests");
const AUTH_PATH = path.join(HOME, ".executor", "server-control", "auth.json");

type ServerState = { description?: string; config?: { command?: string; args?: string[] } } | null;

// The daemon discovers an integration's tools once, when it is registered,
// and the per-server route does not report the result. The flat catalog
// does: each entry names its integration, so counting entries per
// integration reveals an integration whose discovery failed (zero tools).
async function discoveredToolCounts(token: string): Promise<Map<string, number>> {
  const response = await request(token, "GET", "/api/tools");
  if (!response.ok) {
    throw new Error(`GET /api/tools: ${response.status} ${await response.text()}`);
  }
  const entries = (await response.json()) as Array<{ integration?: string }>;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (typeof entry.integration !== "string") continue;
    counts.set(entry.integration, (counts.get(entry.integration) ?? 0) + 1);
  }
  return counts;
}

function readToken(): string {
  const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")) as { token?: string };
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error(`no daemon token at ${AUTH_PATH}`);
  }
  return parsed.token;
}

async function request(token: string, method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function main(): Promise<void> {
  const token = readToken();
  const names = fs
    .readdirSync(MANIFESTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  if (names.length === 0) {
    throw new Error(`no manifests in ${MANIFESTS_DIR}`);
  }

  const command = path.join(HOME, "bin", "mcp-serve");
  const toolCounts = await discoveredToolCounts(token);
  const results: Array<{ name: string; action: string }> = [];

  for (const name of names) {
    const text = fs.readFileSync(path.join(MANIFESTS_DIR, `${name}.json`), "utf8");
    const manifest = JSON.parse(text) as { name?: string; description?: string };
    if (manifest.name !== name) {
      throw new Error(`${name}.json declares name ${String(manifest.name)}; file name and manifest name must match`);
    }
    // The fingerprint rides in the description so a manifest edit (new tools,
    // changed schemas) forces a replace and a fresh tool discovery even when
    // the spawn command is identical.
    const fingerprint = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
    const description = `${manifest.description ?? name} [manifest:${fingerprint}]`;

    const existing = await request(token, "GET", `/api/mcp/servers/${name}`);
    if (!existing.ok) {
      throw new Error(`GET ${name}: ${existing.status} ${await existing.text()}`);
    }
    const state = (await existing.json()) as ServerState;
    const current = state?.config;
    const desiredArgs = JSON.stringify([name]);
    if (
      current &&
      current.command === command &&
      JSON.stringify(current.args ?? []) === desiredArgs &&
      state?.description === description &&
      (toolCounts.get(name) ?? 0) > 0
    ) {
      results.push({ name, action: "unchanged" });
      continue;
    }
    // A matching registration with zero discovered tools is replaced so the
    // daemon retries discovery; there is no refresh route in the daemon API.
    if (state !== null) {
      const removed = await request(token, "DELETE", `/api/mcp/servers/${name}`);
      if (!removed.ok) {
        throw new Error(`DELETE ${name}: ${removed.status} ${await removed.text()}`);
      }
    }
    const added = await request(token, "POST", "/api/mcp/servers", {
      transport: "stdio",
      name,
      slug: name,
      description,
      command,
      args: [name],
      env: { FLUFFLES_HOME: HOME }
    });
    if (!added.ok) {
      throw new Error(`POST ${name}: ${added.status} ${await added.text()}`);
    }
    results.push({ name, action: state === null ? "added" : "replaced" });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, endpoint: BASE, integrations: results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
