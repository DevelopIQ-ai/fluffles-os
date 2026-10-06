import fs from "node:fs";
import path from "node:path";

/**
 * The envelope every conversation turn runs inside.
 *
 * Codex confines model-generated shell writes to its working directory, so the
 * working directory is the security boundary. Turns used to run with the
 * harness home as their workdir, which made the durable ledger, the markdown
 * memory, `auth/`, and the installed source writable by any command the model
 * chose to run. They write through the MCP tools instead, which the executor
 * daemon runs outside the sandbox, so the model never needed that reach.
 *
 * Scratch is therefore the workdir and the writable roots name the one
 * exception: the project checkouts, where editing files is the work itself and
 * where git already makes a mistake recoverable.
 */
export const CONVERSATION_SANDBOX_MODE = "workspace-write";

export interface ConversationSandbox {
  /** Working directory for the Codex process running a turn. */
  cwd: string;
  /** Sandbox arguments to place in a `codex exec` invocation. */
  args: string[];
}

/**
 * Codex reads AGENTS.md relative to its working directory and does not walk up
 * to a parent, so a scratch workdir silently costs a turn its identity and
 * standing rules. Link the harness copy into scratch to keep the file path the
 * model reads pointing at the reviewed one.
 *
 * Scratch is writable by design, so a turn can unlink or replace that entry
 * even though the sandbox denies writes to what it resolves to. Call this
 * before every turn rather than once at startup: tampering then costs the turn
 * that did it nothing and never reaches the next one. A turn with no standing
 * rules is worse than a failed turn, so a missing harness copy raises instead
 * of running the model without it.
 */
export function prepareConversationWorkdir(home: string): string {
  const cwd = path.join(home, "work");
  const target = path.join(home, "AGENTS.md");
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Refusing to run a turn without standing rules: ${target} is missing`);
  }
  fs.mkdirSync(cwd, { recursive: true });
  const instructions = path.join(cwd, "AGENTS.md");
  let current: string | null = null;
  try {
    current = fs.readlinkSync(instructions);
  } catch {
    current = null;
  }
  if (current !== target) {
    fs.rmSync(instructions, { force: true, recursive: true });
    fs.symlinkSync(target, instructions);
  }
  return cwd;
}

export function conversationSandbox(home: string): ConversationSandbox {
  return {
    cwd: prepareConversationWorkdir(home),
    args: [
      "--sandbox",
      CONVERSATION_SANDBOX_MODE,
      "-c",
      `sandbox_workspace_write.writable_roots=[${JSON.stringify(path.join(home, "projects"))}]`
    ]
  };
}
