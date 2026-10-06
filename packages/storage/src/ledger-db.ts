import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertAuthoritativeLedgerDurability } from "./durability";
import { requiredNumberField, runtimeRecordArray } from "./fields";

const sqliteBusyTimeoutMs = 5_000;
const sqliteLockRetryAttempts = 8;
const sqliteLockRetryBaseDelayMs = 10;
const sqliteLockRetryMaxDelayMs = 100;

export type SchemaMigration = readonly [number, (db: DatabaseSync) => void];

export interface LedgerDbOptions {
  filePath: string;
  /**
   * Idempotent base schema executed at every startup. Must create the
   * `schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
   * table the migration runner records into.
   */
  schema: string;
  /** Ordered versioned migrations applied on top of the base schema. */
  migrations: readonly SchemaMigration[];
  now?: () => Date;
  idFactory?: () => string;
}

/**
 * Owns a shared authoritative SQLite connection: durability contract,
 * schema migrations, and the single serialized write chain every domain
 * store mutates through. Schema and migrations are supplied by the embedder.
 */
export class LedgerDb {
  readonly filePath: string;
  private readonly schema: string;
  private readonly migrations: readonly SchemaMigration[];
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private db: DatabaseSync | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LedgerDbOptions) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.migrations = options.migrations;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    // Fail process startup before it can accept work if the authoritative
    // persistence contract or its migrations cannot be established.
    this.ensureDb();
  }

  newId(): string { return this.idFactory(); }

  nowDate(): Date { return this.now(); }


  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Throws if the authoritative SQLite connection has lost its WAL + FULL contract. */
  assertAuthoritativeDurability(): void {
    assertAuthoritativeLedgerDurability(this.ensureDb(), this.filePath === ":memory:");
  }

  async mutate<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    const run = this.writeChain.then(() => this.withTransactionRetry(operation));
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTransactionRetry<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.withTransaction(operation);
      } catch (error) {
        if (!isSqliteLockError(error) || attempt >= sqliteLockRetryAttempts) throw error;
        await delay(sqliteLockRetryDelayMs(attempt));
      }
    }
  }

  private withTransaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.ensureDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(db);
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureDb(): DatabaseSync {
    if (this.db) return this.db;
    if (this.filePath !== ":memory:") mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Connection setup can hit SQLITE_BUSY without consulting the busy
    // handler (e.g. `PRAGMA journal_mode = WAL` while another process holds
    // the write lock during initial schema creation), so retry startup on
    // lock errors like any other write.
    for (let attempt = 0; ; attempt += 1) {
      const db = new DatabaseSync(this.filePath);
      try {
        this.initializeDb(db);
        this.db = db;
        return db;
      } catch (error) {
        // Do not retain a partially initialized handle after a failed
        // durability check. The next attempt must make a fresh start.
        db.close();
        if (!isSqliteLockError(error) || attempt >= sqliteLockRetryAttempts) throw error;
        delaySync(sqliteLockRetryDelayMs(attempt));
      }
    }
  }

  private initializeDb(db: DatabaseSync): void {
    db.exec(`
      PRAGMA busy_timeout = ${sqliteBusyTimeoutMs};
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `);
    db.exec(this.schema);
    // `synchronous` is connection-local. Validate this exact connection at
    // every startup so a filesystem or SQLite configuration failure cannot
    // silently weaken provider-acceptance durability.
    assertAuthoritativeLedgerDurability(db, this.filePath === ":memory:");
    this.applyMigrations(db);
  }

  private applyMigrations(db: DatabaseSync): void {
    const appliedVersions = new Set<number>(
      runtimeRecordArray(
        db.prepare("SELECT version FROM schema_migrations").all(),
        "schema_migrations rows"
      ).map((row) => requiredNumberField(row, "version", "schema_migrations row"))
    );

    for (const [version, migrate] of this.migrations) {
      if (appliedVersions.has(version)) continue;
      this.applyMigrationWithRetry(db, version, migrate);
    }
  }

  private applyMigrationWithRetry(
    db: DatabaseSync,
    version: number,
    migrate: (db: DatabaseSync) => void
  ): void {
    for (let attempt = 0; ; attempt += 1) {
      let transactionStarted = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionStarted = true;
        const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1").get(version);
        if (applied) {
          db.exec("COMMIT");
          return;
        }
        migrate(db);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, this.isoNow());
        db.exec("COMMIT");
        return;
      } catch (error) {
        if (transactionStarted) {
          try {
            db.exec("ROLLBACK");
          } catch (_rollbackError) {
            // The failed transaction may already have been rolled back by SQLite.
          }
        }
        if (!isSqliteLockError(error) || attempt >= sqliteLockRetryAttempts) throw error;
        delaySync(sqliteLockRetryDelayMs(attempt));
      }
    }
  }

  isoNow(): string { return this.now().toISOString(); }
}

function isSqliteLockError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_(BUSY|LOCKED)|database is (busy|locked)/i.test(error.message);
}


function sqliteLockRetryDelayMs(attempt: number): number {
  return Math.min(sqliteLockRetryMaxDelayMs, sqliteLockRetryBaseDelayMs * 2 ** attempt);
}


function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


function delaySync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
