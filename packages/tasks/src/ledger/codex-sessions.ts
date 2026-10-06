import { DatabaseSync } from "node:sqlite";
import { BridgeStore } from "./bridge-store";
import { LedgerDb } from "./db";
import { cloneCodexSession, codexSessionFromRow, optionalCodexSessionRowFromSql, requireCommunicationChannel, requireNonEmptyText } from "./rows";
import { CodexSession, CommunicationChannel, ExecutorSessionLedger } from "./types";

/**
 * Executor session continuity: maps a conversation to its persisted Codex
 * session so multi-turn context survives restarts.
 */
export class CodexSessionStore implements ExecutorSessionLedger {
  constructor(private readonly db: LedgerDb, private readonly bridge: BridgeStore) {}


  async getCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<CodexSession | null> {
    const session = this.codexSessionInDb(
      this.db.ensureDb(),
      requireCommunicationChannel(channel, "Codex session channel"),
      requireNonEmptyText(conversationKey, "Codex session conversation key")
    );
    return session ? cloneCodexSession(session) : null;
  }

  async saveCodexSession(channel: CommunicationChannel, conversationKey: string, codexSessionId: string): Promise<CodexSession> {
    return this.db.mutate<CodexSession>((db) => {
      const normalizedChannel = requireCommunicationChannel(channel, "Codex session channel");
      const normalizedKey = requireNonEmptyText(conversationKey, "Codex session conversation key");
      const normalizedSessionId = requireNonEmptyText(codexSessionId, "Codex session id");
      this.bridge.requireConversationInDb(db, normalizedChannel, normalizedKey);
      const now = this.db.isoNow();
      const existing = this.codexSessionInDb(db, normalizedChannel, normalizedKey);
      const session: CodexSession = {
        channel: normalizedChannel,
        conversationKey: normalizedKey,
        codexSessionId: normalizedSessionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      this.upsertCodexSession(db, session);
      return cloneCodexSession(session);
    });
  }

  async clearCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<void> {
    await this.db.mutate<void>((db) => {
      db.prepare("DELETE FROM codex_sessions WHERE channel = ? AND conversation_key = ?")
        .run(
          requireCommunicationChannel(channel, "Codex session channel"),
          requireNonEmptyText(conversationKey, "Codex session conversation key")
        );
    });
  }

  private codexSessionInDb(db: DatabaseSync, channel: CommunicationChannel, conversationKey: string): CodexSession | null {
    const row = optionalCodexSessionRowFromSql(db.prepare(`
      SELECT ${codexSessionColumns()} FROM codex_sessions WHERE channel = ? AND conversation_key = ?
    `).get(channel, conversationKey), `Codex session ${channel}:${conversationKey}`);
    return row ? codexSessionFromRow(row) : null;
  }

  private upsertCodexSession(db: DatabaseSync, session: CodexSession): void {
    db.prepare(`
      INSERT INTO codex_sessions (channel, conversation_key, codex_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, conversation_key) DO UPDATE SET
        codex_session_id = excluded.codex_session_id,
        updated_at = excluded.updated_at
    `).run(session.channel, session.conversationKey, session.codexSessionId, session.createdAt, session.updatedAt);
  }
}

function codexSessionColumns(): string {
  return `
    channel,
    conversation_key AS conversationKey,
    codex_session_id AS codexSessionId,
    created_at AS createdAt,
    updated_at AS updatedAt
  `;
}
