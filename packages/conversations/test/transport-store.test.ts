import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SQLiteTransportStore,
  claimInboundReceiptInDb,
  migrateLegacyTransportReceipts,
  type TransportInboundReceipt
} from "../src/transport-store";

class TestTransportStore extends SQLiteTransportStore {
  record(input: TransportInboundReceipt): void {
    this.writeInboundReceipt(input);
  }

  recordOutbound(action: string): void {
    this.writeOutboundReceipt({
      conversationKey: "slack:c1",
      runId: "run-1",
      provider: "gmail",
      providerMessageId: `m-${action}`,
      action,
      mode: "send"
    });
  }

  counts(): ReturnType<SQLiteTransportStore["receiptCounts"]> {
    return this.receiptCounts();
  }

  outbound(action: string): number {
    return this.countOutboundByAction(action);
  }

  protected channelSchema(): string {
    return "CREATE TABLE IF NOT EXISTS channel_specific (id TEXT PRIMARY KEY);";
  }
}

function inbound(providerEventId: string, overrides: Partial<TransportInboundReceipt> = {}): TransportInboundReceipt {
  return {
    provider: "gmail",
    providerEventId,
    action: "accepted",
    details: { subject: "hello" },
    ...overrides
  };
}

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "transport-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("receipts dedupe on the provider event id and keep the latest disposition", () => {
  const store = new TestTransportStore({ filePath: ":memory:" });
  assert.equal(store.hasInboundReceipt("gmail", "m1"), false);

  store.record(inbound("m1", { taskDisposition: "queued" }));
  assert.equal(store.hasInboundReceipt("gmail", "m1"), true);

  store.record(inbound("m1", { action: "error", error: "boom", taskDisposition: "failed" }));
  assert.deepEqual(store.counts(), {
    inboundTotal: 1,
    inboundAccepted: 0,
    inboundSkipped: 0,
    inboundErrors: 1,
    outboundTotal: 0
  });

  // The same id under a different provider is a different event.
  store.record(inbound("m1", { provider: "agentphone" }));
  assert.equal(store.counts().inboundTotal, 2);
  store.close();
});

test("claim keeps the first receipt and reports the duplicate", () => {
  const store = new TestTransportStore({ filePath: ":memory:" });
  store.record(inbound("m1"));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, action TEXT NOT NULL,
      details_json TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
      error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    )
  `);
  assert.equal(claimInboundReceiptInDb(db, inbound("m1", { details: { text: "first" } }), "t0"), true);
  assert.equal(claimInboundReceiptInDb(db, inbound("m1", { details: { text: "second" } }), "t1"), false);
  const row = db.prepare("SELECT details_json AS details FROM inbound_receipts").get() as { details: string };
  assert.deepEqual(JSON.parse(row.details), { text: "first" });
  db.close();
  store.close();
});

test("outbound counters are per action and the destination column is optional", () => {
  const store = new TestTransportStore({ filePath: ":memory:" });
  store.recordOutbound("sent");
  store.recordOutbound("sent");
  store.recordOutbound("failed");
  assert.equal(store.counts().outboundTotal, 3);
  assert.equal(store.outbound("sent"), 2);
  assert.equal(store.outbound("failed"), 1);
  assert.equal(store.outbound("drafted"), 0);
  store.close();
});

test("a deployed email receipt table keeps every row and dedupe key", () => {
  withDir((dir) => {
    const filePath = path.join(dir, "email-transport.sqlite");
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE inbound_receipts (
        provider TEXT NOT NULL, provider_message_id TEXT NOT NULL, thread_id TEXT,
        subject TEXT NOT NULL, sender TEXT NOT NULL, classification_json TEXT NOT NULL,
        action TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
        error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_message_id)
      );
      CREATE TABLE outbound_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, run_id TEXT NOT NULL,
        provider TEXT NOT NULL, provider_message_id TEXT NOT NULL, action TEXT NOT NULL,
        mode TEXT NOT NULL, response_json TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO inbound_receipts VALUES (
        'gmail', 'm1', 't1', 'Invoice', 'kush@puffle.ai', '{"intent":"reply"}',
        'accepted', 'email:t1', 'queued', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO outbound_receipts (conversation_key, run_id, provider, provider_message_id, action, mode, response_json, created_at)
      VALUES ('email:t1', 'run-1', 'gmail', 'out-1', 'sent', 'send', 'null', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const store = new TestTransportStore({ filePath });
    assert.equal(store.hasInboundReceipt("gmail", "m1"), true);
    assert.deepEqual(store.counts(), {
      inboundTotal: 1,
      inboundAccepted: 1,
      inboundSkipped: 0,
      inboundErrors: 0,
      outboundTotal: 1
    });
    store.close();

    const migrated = new DatabaseSync(filePath);
    const row = migrated.prepare("SELECT * FROM inbound_receipts").get() as Record<string, unknown>;
    assert.deepEqual(JSON.parse(String(row.details_json)), {
      threadId: "t1",
      subject: "Invoice",
      sender: "kush@puffle.ai",
      classification: { intent: "reply" }
    });
    assert.equal(row.task_conversation_key, "email:t1");
    assert.equal(row.received_at, "2026-01-01T00:00:00.000Z");
    // The email outbound table predates AgentPhone's destination column.
    const outbound = migrated.prepare("SELECT destination FROM outbound_receipts").get() as { destination: unknown };
    assert.equal(outbound.destination, null);
    assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'inbound_receipts_legacy'").get(), undefined);
    migrated.close();
  });
});

test("a deployed phone receipt table migrates its own column names", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, conversation_id TEXT,
      sender TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
      task_conversation_key TEXT, task_disposition TEXT, error TEXT,
      received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    INSERT INTO inbound_receipts VALUES (
      'agentphone', 'e1', 'conv-1', '+15550000000', 'call', 'error',
      NULL, NULL, 'transcript missing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
    );
  `);
  migrateLegacyTransportReceipts(db);
  const row = db.prepare("SELECT * FROM inbound_receipts").get() as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(row.details_json)), {
    conversationId: "conv-1",
    sender: "+15550000000",
    kind: "call"
  });
  assert.equal(row.error, "transcript missing");
  assert.equal(row.updated_at, "2026-01-01T00:00:01.000Z");
  db.close();
});

test("migration is idempotent and leaves an already-canonical table alone", () => {
  const store = new TestTransportStore({ filePath: ":memory:" });
  store.record(inbound("m1"));
  store.close();

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, action TEXT NOT NULL,
      details_json TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
      error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    INSERT INTO inbound_receipts VALUES ('gmail', 'm1', 'accepted', '{"a":1}', NULL, NULL, NULL, 't', 't');
  `);
  migrateLegacyTransportReceipts(db);
  migrateLegacyTransportReceipts(db);
  const row = db.prepare("SELECT details_json AS details FROM inbound_receipts").get() as { details: string };
  assert.deepEqual(JSON.parse(row.details), { a: 1 });
  db.close();
});

test("a half-migrated database left by an interrupted migration is finished, not lost", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts_legacy (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, conversation_id TEXT,
      sender TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
      task_conversation_key TEXT, task_disposition TEXT, error TEXT,
      received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    INSERT INTO inbound_receipts_legacy VALUES
      ('agentphone', 'e1', 'conv-1', '+15550000000', 'call', 'accepted', 'phone:conv-1', 'queued', NULL, 't1', 't1'),
      ('agentphone', 'e2', 'conv-2', '+15550000001', 'sms', 'skipped', NULL, NULL, NULL, 't2', 't2');
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, action TEXT NOT NULL,
      details_json TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
      error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    INSERT INTO inbound_receipts VALUES
      ('agentphone', 'e1', 'accepted', '{"conversationId":"conv-1","sender":"+15550000000","kind":"call"}',
       'phone:conv-1', 'queued', NULL, 't1', 't1');
  `);

  migrateLegacyTransportReceipts(db);

  const rows = db.prepare("SELECT provider_event_id AS id, action, received_at AS at FROM inbound_receipts ORDER BY provider_event_id")
    .all()
    .map((row) => ({ ...(row as { id: string; action: string; at: string }) }));
  assert.deepEqual(rows, [
    { id: "e1", action: "accepted", at: "t1" },
    { id: "e2", action: "skipped", at: "t2" }
  ]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbound_receipts_legacy'").get(), undefined);

  migrateLegacyTransportReceipts(db);
  const total = db.prepare("SELECT COUNT(*) AS n FROM inbound_receipts").get() as { n: number };
  assert.equal(total.n, 2);
  db.close();
});

test("a migration that fails midway leaves the legacy table intact", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, conversation_id TEXT,
      sender TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
      task_conversation_key TEXT, task_disposition TEXT, error TEXT,
      received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    INSERT INTO inbound_receipts VALUES
      ('agentphone', 'e1', 'conv-1', '+15550000000', 'call', 'accepted', NULL, NULL, NULL, 't1', 't1');
    -- An index on the destination name makes CREATE TABLE inbound_receipts fail.
    CREATE TABLE inbound_receipts_legacy (x TEXT);
  `);

  assert.throws(() => migrateLegacyTransportReceipts(db));

  const columns = db.prepare("SELECT name FROM pragma_table_info('inbound_receipts')").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "conversation_id"));
  const row = db.prepare("SELECT COUNT(*) AS n FROM inbound_receipts").get() as { n: number };
  assert.equal(row.n, 1);
  db.close();
});

test("a copy that fails partway rolls the whole migration back, not just the failing row", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE inbound_receipts_legacy (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, conversation_id TEXT,
      sender TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
      task_conversation_key TEXT, task_disposition TEXT, error TEXT,
      received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    );
    -- The canonical table rejects a row in the middle, so the copy fails only
    -- after earlier rows are already written. Failing on the first row would
    -- hold whether or not the migration is transactional.
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, action TEXT NOT NULL,
      details_json TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
      error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id),
      CHECK (provider_event_id <> 'row-0005')
    );
  `);
  const insert = db.prepare("INSERT INTO inbound_receipts_legacy VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 't1', 't1')");
  for (let index = 0; index < 10; index += 1) {
    insert.run("agentphone", `row-${String(index).padStart(4, "0")}`, `conv-${index}`, "+15550000000", "message", "accepted");
  }

  assert.throws(() => migrateLegacyTransportReceipts(db));

  const copied = db.prepare("SELECT COUNT(*) AS n FROM inbound_receipts").get() as { n: number };
  assert.equal(copied.n, 0, "a half-copied migration must roll back completely");
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM inbound_receipts_legacy").get() as { n: number };
  assert.equal(legacy.n, 10);
  db.close();
});
