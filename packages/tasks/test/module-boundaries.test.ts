import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";


// Resolves the TypeScript sources whether this test runs from test/ or dist/test/.
const srcDir = [path.join(__dirname, "..", "src"), path.join(__dirname, "..", "..", "src")]
  .find((candidate) => existsSync(path.join(candidate, "conversation-engine.ts")));
if (!srcDir) throw new Error("could not locate tasks/src for the boundary check");

/**
 * The bridge is the extractable core: chats/messages/runs/deliveries, the
 * engine, the runtime, and the executor boundary. It may depend only on the
 * shared kernel (db/rows/types/durability/context) and node builtins, never
 * on another domain. Fluffles-specific domains depend on the bridge, not the
 * other way around.
 */
const bridgeModules = [
  "ledger/bridge-store.ts",
  "conversation-engine.ts",
  "conversation-runtime.ts",
  "executor.ts"
];

const forbiddenDomainModules = [
  "scheduler-store",
  "scheduler-rows",
  "control-store",
  "repair-store",
  "task-registry",
  "codex-sessions",
  "deployment-lifecycle",
  "reminder-time",
  "task-control",
  "task-ledger"
];

function importSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** The storage package must stay generic: only node builtins and its own modules. */
const storageSrcDir = path.join(srcDir, "..", "..", "packages", "storage", "src");
if (existsSync(storageSrcDir)) {
  for (const module of ["index.ts", "ledger-db.ts", "durability.ts", "fields.ts"]) {
    test(`storage module ${module} imports only node builtins and storage modules`, () => {
      const specifiers = importSpecifiers(path.join(storageSrcDir, module));
      const violations = specifiers.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./"));
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }
}

/** The conversations package may depend only on node builtins, storage, and itself. */
const conversationsSrcDir = path.join(srcDir, "..", "..", "packages", "conversations", "src");
if (existsSync(conversationsSrcDir)) {
  for (const module of ["index.ts", "types.ts", "rows.ts", "schema.ts", "store.ts", "engine.ts", "runtime.ts", "executor.ts", "channel.ts", "context-limits.ts", "context-budget-counter.ts"]) {
    test(`conversations module ${module} imports only node builtins, storage, and conversations modules`, () => {
      const specifiers = importSpecifiers(path.join(conversationsSrcDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./") && specifier !== "@fluffles/storage"
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }

  /** Platform SDK code stays in channels/*: no conversations source file may reach a channel or platform SDK. */
  test("conversations package sources never import channel code or platform SDKs", () => {
    for (const entry of readdirSync(conversationsSrcDir)) {
      if (!entry.endsWith(".ts")) continue;
      const specifiers = importSpecifiers(path.join(conversationsSrcDir, entry));
      const violations = specifiers.filter((specifier) =>
        specifier.startsWith("../")
        || specifier.includes("channels/")
        || /^@slack\//.test(specifier)
        || ["ws", "googleapis", "nodemailer", "imapflow", "imap", "mailparser", "twilio"].includes(specifier)
      );
      assert.deepEqual(violations, [], `${entry} must not import: ${violations.join(", ")}`);
    }
  });
}

/** The scheduler package may depend only on node builtins, storage, conversations, and itself. */
const schedulerSrcDir = path.join(srcDir, "..", "..", "packages", "scheduler", "src");
if (existsSync(schedulerSrcDir)) {
  for (const module of ["index.ts", "types.ts", "rows.ts", "schema.ts", "store.ts", "heartbeats.ts", "dispatcher.ts", "time.ts"]) {
    test(`scheduler module ${module} imports only node builtins, storage, conversations, and scheduler modules`, () => {
      const specifiers = importSpecifiers(path.join(schedulerSrcDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./")
          && specifier !== "@fluffles/storage" && specifier !== "@fluffles/conversations"
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }
}

/** The task registry package may depend only on node builtins, storage, conversations, and itself. */
const taskRegistrySrcDir = path.join(srcDir, "..", "..", "packages", "tasks", "src");
if (existsSync(taskRegistrySrcDir)) {
  for (const module of ["index.ts", "types.ts", "rows.ts", "schema.ts", "store.ts", "cancel.ts"]) {
    test(`task registry module ${module} imports only node builtins, storage, conversations, and registry modules`, () => {
      const specifiers = importSpecifiers(path.join(taskRegistrySrcDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./")
          && specifier !== "@fluffles/storage" && specifier !== "@fluffles/conversations"
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }
}

/** The repair-ledger package may depend only on node builtins, storage, and itself. */
const repairLedgerSrcDir = path.join(srcDir, "..", "..", "packages", "repair-ledger", "src");
if (existsSync(repairLedgerSrcDir)) {
  for (const module of ["index.ts", "types.ts", "rows.ts", "schema.ts", "store.ts"]) {
    test(`repair-ledger module ${module} imports only node builtins, storage, and repair-ledger modules`, () => {
      const specifiers = importSpecifiers(path.join(repairLedgerSrcDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./") && specifier !== "@fluffles/storage"
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }
}

/** The memory package may depend only on node builtins, storage, and itself. */
const memorySrcDir = path.join(srcDir, "..", "..", "packages", "memory", "src");
if (existsSync(memorySrcDir)) {
  for (const module of ["index.ts", "paths.ts", "frontmatter.ts", "safety.ts", "notes.ts", "wiki.ts", "context.ts", "tools.ts", "promote.ts", "index/schema.ts", "index/indexer.ts", "index/links.ts", "index/search.ts"]) {
    test(`memory module ${module} imports only node builtins, storage, and memory modules`, () => {
      const specifiers = importSpecifiers(path.join(memorySrcDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./") && !specifier.startsWith("../")
          && specifier !== "@fluffles/storage"
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }
}

/** The shared kernel must stay domain-neutral: no imports outside ledger/ or node builtins. */
const kernelModules = ["ledger/db.ts", "ledger/rows.ts", "ledger/types.ts", "ledger/durability.ts", "ledger/migrations.ts"];

for (const module of kernelModules) {
  test(`kernel module ${module} imports only the kernel and node builtins`, () => {
    const specifiers = importSpecifiers(path.join(srcDir, module));
    const violations = specifiers.filter((specifier) => !specifier.startsWith("node:") && specifier.startsWith(".."));
    assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
  });
}

/**
 * The agent composition layer may import packages and app modules, but the
 * dependency never points back: no package may import agent/.
 */
const agentDir = path.join(srcDir, "..", "..", "..", "agent");
if (existsSync(agentDir)) {
  const agentModules = [
    "channels/channel.ts",
    "channels/slack.ts",
    "channels/email.ts",
    "channels/phone.ts",
    "executors/codex.ts"
  ];
  for (const module of agentModules) {
    test(`agent module ${module} imports only node builtins, packages, and app modules`, () => {
      const specifiers = importSpecifiers(path.join(agentDir, module));
      const violations = specifiers.filter((specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("./")
          && !specifier.startsWith("../../packages/tasks/src/") && !specifier.startsWith("@fluffles/")
      );
      assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
    });
  }

  const packagesDir = path.join(srcDir, "..", "..");
  const packageSources = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(packagesDir, entry.name, "src")))
    .flatMap((entry) => {
      const packageSrc = path.join(packagesDir, entry.name, "src");
      return readdirSync(packageSrc)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => ({ label: `${entry.name}/src/${file}`, filePath: path.join(packageSrc, file) }));
    });

  test("packages never import agent/", () => {
    const violations = packageSources.flatMap(({ label, filePath }) =>
      importSpecifiers(filePath)
        .filter((specifier) => /(^|\/)agent\//.test(specifier))
        .map((specifier) => `${label} -> ${specifier}`)
    );
    assert.deepEqual(violations, [], `packages must not import agent/: ${violations.join(", ")}`);
  });
}

for (const module of bridgeModules) {
  test(`bridge module ${module} imports no fluffles domain module`, () => {
    const specifiers = importSpecifiers(path.join(srcDir, module));
    const violations = specifiers.filter((specifier) =>
      forbiddenDomainModules.some((domain) => specifier === `./${domain}` || specifier.endsWith(`/${domain}`))
    );
    assert.deepEqual(violations, [], `${module} must not import: ${violations.join(", ")}`);
  });
}
