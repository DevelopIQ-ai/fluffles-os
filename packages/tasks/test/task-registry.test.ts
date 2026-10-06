import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskLedger, TaskLedgerMessageInput } from "../src/task-ledger";

async function withRegistryDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-registry-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openLedger(dir: string): SQLiteTaskLedger {
  return new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
}

function slackMessage(overrides: Partial<TaskLedgerMessageInput> = {}): TaskLedgerMessageInput {
  return {
    channel: "slack",
    conversationKey: "thread:C123:1000.000100",
    externalMessageId: "Ev1",
    authorId: "U123",
    text: "ship the report",
    receivedAt: "2026-01-01T00:00:00.000Z",
    title: "ship the report",
    replyTarget: { type: "slack_thread", channel: "C123", threadTs: "1000.000100" },
    metadata: {},
    ...overrides
  };
}

const conversationKey = "thread:C123:1000.000100";

test("agent tasks persist objective, progress, next_action, and result across a restart", async () => {
  await withRegistryDir(async (dir) => {
    let taskId: string;
    const ledger = openLedger(dir);
    try {
      await ledger.recordMessage(slackMessage());
      const created = await ledger.createConversationTask({
        channel: "slack",
        conversationKey,
        objective: "compile the weekly report"
      });
      taskId = created.id;
      assert.equal(created.status, "in_progress");
      assert.equal(created.result, null);
      const updated = await ledger.updateConversationTask(taskId, {
        progress: "gathered the data",
        nextAction: "draft the summary"
      });
      assert.equal(updated.progress, "gathered the data");
      assert.equal(updated.nextAction, "draft the summary");
    } finally {
      ledger.close();
    }

    const reopened = openLedger(dir);
    try {
      const unfinished = await reopened.unfinishedConversationTask("slack", conversationKey);
      assert.ok(unfinished, "the unfinished task must survive a restart");
      assert.equal(unfinished.id, taskId);
      assert.equal(unfinished.nextAction, "draft the summary");
      const completed = await reopened.updateConversationTask(taskId, {
        status: "completed",
        result: "report sent"
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.result, "report sent");
      assert.equal(await reopened.unfinishedConversationTask("slack", conversationKey), null);
    } finally {
      reopened.close();
    }
  });
});

test("one unfinished task per conversation; terminal statuses require a result and stay immutable", async () => {
  await withRegistryDir(async (dir) => {
    const ledger = openLedger(dir);
    try {
      await ledger.recordMessage(slackMessage());
      const first = await ledger.createConversationTask({ channel: "slack", conversationKey, objective: "first" });
      await assert.rejects(
        ledger.createConversationTask({ channel: "slack", conversationKey, objective: "second" }),
        /already has an unfinished task/
      );
      await assert.rejects(
        ledger.updateConversationTask(first.id, { status: "completed" }),
        /must record a result/
      );
      await assert.rejects(
        ledger.updateConversationTask(first.id, { status: "failed", result: "  " }),
        /must record a result/
      );
      const failed = await ledger.updateConversationTask(first.id, { status: "failed", result: "provider unavailable" });
      assert.equal(failed.result, "provider unavailable");
      await assert.rejects(
        ledger.updateConversationTask(first.id, { progress: "more" }),
        /already failed/
      );
      const second = await ledger.createConversationTask({ channel: "slack", conversationKey, objective: "second" });
      const tasks = await ledger.conversationTasks("slack", conversationKey);
      assert.deepEqual(tasks.map((task) => task.id), [first.id, second.id]);
    } finally {
      ledger.close();
    }
  });
});

test("creating a task requires an existing conversation", async () => {
  await withRegistryDir(async (dir) => {
    const ledger = openLedger(dir);
    try {
      await assert.rejects(
        ledger.createConversationTask({ channel: "slack", conversationKey: "thread:C9:9.9", objective: "x" }),
        /Unknown task conversation/
      );
      assert.deepEqual(await ledger.conversationTasks("slack", "thread:C9:9.9"), []);
      assert.equal(await ledger.unfinishedConversationTask("slack", "thread:C9:9.9"), null);
    } finally {
      ledger.close();
    }
  });
});

test("stopping a conversation cancels its unfinished task but leaves reminder tasks alone", async () => {
  await withRegistryDir(async (dir) => {
    const ledger = openLedger(dir);
    try {
      await ledger.recordMessage(slackMessage());
      const task = await ledger.createConversationTask({ channel: "slack", conversationKey, objective: "long job" });
      const reminder = await ledger.createReminder({
        channel: "slack",
        conversationKey,
        instruction: "ping me later",
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        displayTimezone: "UTC"
      });
      await ledger.stopConversation("slack", conversationKey, "user said stop");
      const cancelled = (await ledger.conversationTasks("slack", conversationKey)).find((t) => t.id === task.id);
      assert.ok(cancelled);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.result, "user said stop");
      const reminderAfter = await ledger.getReminder(reminder.id);
      assert.equal(reminderAfter?.status, "scheduled");
    } finally {
      ledger.close();
    }
  });
});
