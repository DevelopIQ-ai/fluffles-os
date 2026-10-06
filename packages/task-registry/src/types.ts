import type { TaskChannel } from "@fluffles/conversations";

export type PersistentTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** Durable state for one meaningful unit of work in a conversation. */
export interface PersistentTask {
  id: string;
  conversationId: string;
  objective: string;
  status: PersistentTaskStatus;
  progress: string | null;
  nextAction: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePersistentTaskInput {
  progress?: string | null;
  nextAction?: string | null;
}

/** Step 2 registry: create durable state for meaningful conversation work. */
export interface CreateConversationTaskInput {
  channel: TaskChannel;
  conversationKey: string;
  objective: string;
  status?: Extract<PersistentTaskStatus, "pending" | "in_progress">;
  progress?: string | null;
  nextAction?: string | null;
}

export interface UpdateConversationTaskInput {
  status?: PersistentTaskStatus;
  progress?: string | null;
  nextAction?: string | null;
  result?: string | null;
}

/**
 * The task registry: passive durable state the agent updates while working.
 * It records objective/status/progress/next_action/result per conversation;
 * it never executes anything.
 */
export interface TaskRegistryLedger {
  createConversationTask(input: CreateConversationTaskInput): Promise<PersistentTask>;
  updateConversationTask(taskId: string, input: UpdateConversationTaskInput): Promise<PersistentTask>;
  conversationTasks(channel: TaskChannel, conversationKey: string): Promise<PersistentTask[]>;
  unfinishedConversationTask(channel: TaskChannel, conversationKey: string): Promise<PersistentTask | null>;
}

export function isTerminalPersistentTaskStatus(status: PersistentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
