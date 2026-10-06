import { DatabaseSync } from "node:sqlite";

/**
 * Cancels every unfinished Step 2 registry task on a stopped conversation.
 * Shared by the bridge's stop transaction and the registry store so a stop
 * can never commit while a registry task still claims active work.
 */
export function cancelOpenConversationTasksInDb(
  db: DatabaseSync,
  conversationId: string,
  reason: string,
  updatedAt: string
): void {
  db.prepare(`
    UPDATE tasks
    SET status = 'cancelled', result = COALESCE(result, ?), updated_at = ?
    WHERE conversation_id = ? AND task_kind = 'conversation' AND status IN ('pending', 'in_progress')
  `).run(reason, updatedAt, conversationId);
}
