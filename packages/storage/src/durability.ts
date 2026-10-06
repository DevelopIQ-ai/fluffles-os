import { DatabaseSync } from "node:sqlite";
import { requireRuntimeRecord, requiredNumberField, requiredStringField } from "./fields";

const sqliteSynchronousFull = 2;

/**
 * The non-negotiable durability contract for an authoritative ledger
 * connection: WAL for concurrent readers, FULL synchronous commits for crash
 * durability. Non-authoritative transport stores must not use this contract.
 */
export const AUTHORITATIVE_LEDGER_DURABILITY = {
  journalMode: "wal",
  synchronous: "full"
} as const;

/**
 * Verifies the durability contract on an authoritative connection. Exported
 * for startup diagnostics and regression tests.
 */
export function assertAuthoritativeLedgerDurability(db: DatabaseSync, allowEphemeralMemory = false): void {
  const journalMode = requiredStringField(
    requireRuntimeRecord(db.prepare("PRAGMA journal_mode").get(), "authoritative ledger journal_mode pragma"),
    "journal_mode",
    "authoritative ledger journal_mode pragma"
  ).toLowerCase();
  // SQLite cannot enable WAL for `:memory:` connections. Callers must opt in
  // explicitly, so a file-backed database configured with MEMORY never passes
  // as an authoritative production ledger.
  if (journalMode !== AUTHORITATIVE_LEDGER_DURABILITY.journalMode && !(allowEphemeralMemory && journalMode === "memory")) {
    throw new Error(
      `Authoritative task ledger requires journal_mode=WAL, received ${journalMode || "empty"}`
    );
  }

  const synchronous = requiredNumberField(
    requireRuntimeRecord(db.prepare("PRAGMA synchronous").get(), "authoritative ledger synchronous pragma"),
    "synchronous",
    "authoritative ledger synchronous pragma"
  );
  if (synchronous !== sqliteSynchronousFull) {
    throw new Error(
      `Authoritative task ledger requires synchronous=FULL, received ${synchronous}`
    );
  }
}
