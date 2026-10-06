#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME, resolveConfig } from "./config";
import { SPEC_FILENAME } from "./registry";
import { createAutomations } from "./service";

const USAGE = `Usage: automations <command> [args]

  init                 Scaffold a registry, config, and example automation.
  list                 List automations with their triggers and next run.
  validate             Validate every spec.
  sync                 Refresh stored next-run times from the specs.
  run <id> [json]      Run one automation now.
  fire <source.event> [json]
                       Deliver an event to matching automations.
  runs <id> [limit]    Show recent runs.
  doctor               Report spec validity and schedule liveness.
  serve                Run the clock and ingress in the foreground.`;

const EXAMPLE_SPEC = {
  id: "example",
  name: "Example",
  description: "Replace this with real work.",
  enabled: false,
  triggers: [
    { kind: "schedule", cron: "*/30 * * * *", tz: "UTC" },
    { kind: "manual" }
  ],
  steps: [
    { kind: "command", name: "hello", argv: ["/bin/echo", "hello from automations"] }
  ],
  limits: { maxConcurrentRuns: 1, queueLimit: 0 }
};

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function parsePayload(args: readonly string[]): unknown {
  const text = args.join(" ").trim();
  return text ? JSON.parse(text) : {};
}

function initRegistry(): void {
  const config = resolveConfig();
  fs.mkdirSync(path.join(config.root, "example"), { recursive: true });
  const specPath = path.join(config.root, "example", SPEC_FILENAME);
  if (!fs.existsSync(specPath)) fs.writeFileSync(specPath, `${JSON.stringify(EXAMPLE_SPEC, null, 2)}\n`, "utf8");
  const configPath = path.join(process.cwd(), CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    const scaffold = {
      root: path.relative(process.cwd(), config.root) || "automations",
      stateDir: path.relative(process.cwd(), config.stateDir) || ".state/automations",
      ingress: { host: "127.0.0.1", port: 8787 }
    };
    fs.writeFileSync(configPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8");
  }
  print({ ok: true, root: config.root, stateDir: config.stateDir, config: configPath });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return;
  }
  if (command === "init") return initRegistry();

  const automations = createAutomations(resolveConfig());
  try {
    if (command === "list") {
      print(await automations.summarize());
      return;
    }
    if (command === "validate") {
      const report = automations.validate();
      print(report);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (command === "sync") {
      const result = await automations.sync();
      print(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === "run") {
      const [id, ...rest] = args;
      if (!id) throw new Error("run needs an automation id");
      const record = await automations.run(id, parsePayload(rest));
      print(record);
      if (record.status !== "completed") process.exitCode = 1;
      return;
    }
    if (command === "fire") {
      const [name, ...rest] = args;
      if (!name || !name.includes(".")) throw new Error("fire needs <source>.<event>");
      const separator = name.indexOf(".");
      const runs = await automations.dispatchEvent({
        source: name.slice(0, separator),
        event: name.slice(separator + 1),
        payload: parsePayload(rest),
        headers: {},
        receivedAt: new Date().toISOString()
      });
      print({ matched: runs.length, runs });
      if (runs.some((run) => run.status !== "completed")) process.exitCode = 1;
      return;
    }
    if (command === "runs") {
      const [id, limit] = args;
      if (!id) throw new Error("runs needs an automation id");
      print(await automations.recentRuns(id, limit ? Number(limit) : 20));
      return;
    }
    if (command === "doctor") {
      const report = await automations.doctor();
      print(report);
      if (report.ok !== true) process.exitCode = 1;
      return;
    }
    if (command === "serve") {
      await automations.serve();
      const shutdown = (): void => { void automations.stop().then(() => process.exit(0)); };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      return;
    }
    print(USAGE);
    process.exitCode = 2;
  } finally {
    if (command !== "serve") await automations.stop();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
