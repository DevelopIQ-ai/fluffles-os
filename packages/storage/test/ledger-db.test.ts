import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LedgerDb, type SchemaMigration } from "../src/ledger-db";

const schema = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL
  );
`;

const migrations: readonly SchemaMigration[] = [
  [1, (db: DatabaseSync) => db.exec("ALTER TABLE notes ADD COLUMN created_at TEXT")],
  [2, (db: DatabaseSync) => db.exec("CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at)")]
];

test("applies the base schema and versioned migrations exactly once", () => {
  const ledger = new LedgerDb({ filePath: ":memory:", schema, migrations });
  const db = ledger.ensureDb();
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
  assert.deepEqual(versions.map((row) => row.version), [1, 2]);
  db.prepare("INSERT INTO notes (id, body, created_at) VALUES (?, ?, ?)").run("n1", "hello", "2026-01-01");
  ledger.close();
});

test("mutate serializes writes through one transaction chain", async () => {
  const ledger = new LedgerDb({ filePath: ":memory:", schema, migrations });
  const order: number[] = [];
  await Promise.all([
    ledger.mutate((db) => { order.push(1); db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("a", "x"); }),
    ledger.mutate((db) => { order.push(2); db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("b", "y"); })
  ]);
  assert.deepEqual(order, [1, 2]);
  const count = ledger.ensureDb().prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number };
  assert.equal(count.count, 2);
  ledger.close();
});

test("a failed mutate rolls back and does not poison the chain", async () => {
  const ledger = new LedgerDb({ filePath: ":memory:", schema, migrations });
  await assert.rejects(
    ledger.mutate((db) => {
      db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("c", "z");
      throw new Error("boom");
    }),
    /boom/
  );
  await ledger.mutate((db) => db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run("d", "w"));
  const rows = ledger.ensureDb().prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[];
  assert.deepEqual(rows.map((row) => row.id), ["d"]);
  ledger.close();
});
