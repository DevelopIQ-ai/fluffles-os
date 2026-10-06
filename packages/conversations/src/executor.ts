import { spawn, type ChildProcess } from "node:child_process";

import type { CommunicationChannel } from "./types";

export interface CodexProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  runKey?: string;
}

export interface CodexProcessResult {
  stdout: string;
  stderr: string;
}

export interface CodexConversationProcessRequest {
  channel: CommunicationChannel;
  conversationKey: string;
  request: CodexProcessRequest;
}

export interface CodexConversationProcessResult extends CodexProcessResult {
  output: string;
  codexSessionId: string | null;
}

export interface CodexProcessError extends Error {
  code?: "RUN_STOPPED" | "PROCESS_FAILED" | "TIMEOUT" | "STDIN_FAILED";
  stdout?: string;
  stderr?: string;
}

/** Durable executor-session persistence, implemented by the ledger-backed engine. */
export interface ExecutorSessions {
  getSession(channel: CommunicationChannel, conversationKey: string): Promise<string | null>;
  saveSession(channel: CommunicationChannel, conversationKey: string, sessionId: string): Promise<void>;
}

/**
 * The model execution boundary. The runtime and channels depend on this
 * interface; Codex is the current implementation.
 */
export interface Executor {
  readonly activeCount: number;
  isActive(runKey: string): boolean;
  cancel(runKey: string): boolean;
  run(request: CodexProcessRequest): Promise<CodexProcessResult>;
  runConversation(input: CodexConversationProcessRequest, sessions: ExecutorSessions): Promise<CodexConversationProcessResult>;
}

interface ActiveCodexProcess {
  child: ChildProcess;
  stopRequested: boolean;
}

/** Shared process owner for every Codex invocation made by the harness. */
export class CodexProcessRunner implements Executor {
  private readonly active = new Map<string, ActiveCodexProcess>();

  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  get activeCount(): number {
    return this.active.size;
  }

  isActive(runKey: string): boolean {
    return this.active.has(runKey);
  }

  cancel(runKey: string): boolean {
    const active = this.active.get(runKey);
    if (!active || active.stopRequested) return false;
    active.stopRequested = true;
    active.child.kill("SIGTERM");
    return true;
  }

  async run(request: CodexProcessRequest): Promise<CodexProcessResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: [request.input == null ? "ignore" : "pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (request.runKey) this.active.delete(request.runKey);
        callback();
      };
      const failure = (
        code: NonNullable<CodexProcessError["code"]>,
        message: string
      ): CodexProcessError => {
        const error = new Error(message) as CodexProcessError;
        error.code = code;
        error.stdout = Buffer.concat(stdout).toString("utf8");
        error.stderr = Buffer.concat(stderr).toString("utf8");
        return error;
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(failure("TIMEOUT", `${request.command} timed out after ${request.timeoutMs}ms`)));
      }, request.timeoutMs);

      if (request.runKey) this.active.set(request.runKey, { child, stopRequested: false });
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code, signal) => {
        const stopped = request.runKey ? this.active.get(request.runKey)?.stopRequested === true : false;
        const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
        if (code === 0 && !stopped) {
          finish(() => resolve(result));
          return;
        }
        const detail = result.stderr || result.stdout;
        finish(() => reject(failure(
          stopped ? "RUN_STOPPED" : "PROCESS_FAILED",
          stopped
            ? `${request.command} stopped by user`
            : `${request.command} exited with code ${code}${signal ? ` signal ${signal}` : ""}: ${detail}`
        )));
      });

      if (request.input != null && child.stdin) {
        child.stdin.on("error", (error) => {
          child.kill("SIGTERM");
          finish(() => {
            const wrapped = failure("STDIN_FAILED", `${request.command} stdin failed: ${error.message}`);
            reject(wrapped);
          });
        });
        child.stdin.end(request.input);
      }
    });
  }

  /**
   * Run a conversation continuation with durable session continuity: resume
   * the persisted Codex thread, decode JSON events, and persist any newly
   * started thread through the supplied session store.
   */
  async runConversation(
    input: CodexConversationProcessRequest,
    sessions: ExecutorSessions
  ): Promise<CodexConversationProcessResult> {
    const priorSessionId = await sessions.getSession(input.channel, input.conversationKey);
    const resumeSessionId = priorSessionId ?? null;
    const result = await this.run({
      ...input.request,
      args: codexConversationArgs(input.request.args, resumeSessionId)
    });
    const events = codexJsonEvents(result.stdout);
    const startedSessionId = events.find((event) => event.type === "thread.started")?.threadId ?? null;
    const codexSessionId = startedSessionId ?? resumeSessionId;
    if (startedSessionId) {
      await sessions.saveSession(input.channel, input.conversationKey, startedSessionId);
    }
    return {
      ...result,
      output: [...events].reverse().find((event) => event.agentMessage)?.text ?? result.stdout,
      codexSessionId
    };
  }
}

interface CodexJsonEvent {
  type: string;
  threadId?: string;
  text?: string;
  /** Codex reports the model's message as an `item.completed` carrying an
   *  `agent_message` item, so the event type alone does not identify it. */
  agentMessage?: boolean;
}

/**
 * `codex exec resume` accepts neither `--sandbox` nor its short form. The
 * sandbox mode is still configurable there through the config override that
 * `--sandbox` is sugar for, so translate rather than drop it: silently losing
 * the mode would run a resumed turn under a different sandbox than its first.
 */
function sandboxOverrideForResume(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument !== "--sandbox" && argument !== "-s") {
      result.push(argument);
      continue;
    }
    const mode = args[index + 1];
    if (mode === undefined) throw new Error("--sandbox requires a mode");
    result.push("-c", `sandbox_mode=${JSON.stringify(mode)}`);
    index += 1;
  }
  return result;
}

/**
 * Codex falls back to `config.toml` when an invocation names no sandbox, and
 * that file is unmanaged machine state: on the mini it declares
 * `danger-full-access` with `approval_policy = "never"`, so the Slack path,
 * which passed no mode, ran every turn unsandboxed. A turn states the envelope
 * it wants rather than inheriting whatever the machine happens to hold.
 */
function declaresSandboxMode(args: string[]): boolean {
  return args.some((argument, index) => {
    if (argument === "--sandbox" || argument === "-s") return args[index + 1] !== undefined;
    if (argument !== "-c" && argument !== "--config") return false;
    return /^sandbox_mode=/.test(args[index + 1] ?? "");
  });
}

function codexConversationArgs(args: string[], codexSessionId: string | null): string[] {
  if (args[0] !== "exec") throw new Error("Codex conversation command must begin with exec");
  if (!declaresSandboxMode(args)) {
    throw new Error("Codex conversation turns must declare a sandbox mode rather than inherit config.toml");
  }
  const result = codexSessionId ? sandboxOverrideForResume(args) : [...args];
  if (codexSessionId) {
    result.splice(1, 0, "resume");
    const stdinIndex = result.lastIndexOf("-");
    // The final argument is the model prompt. Codex requires the durable
    // session identifier before it, not after it.
    if (stdinIndex === -1) result.splice(Math.max(2, result.length - 1), 0, codexSessionId);
    else result.splice(stdinIndex, 0, codexSessionId);
  }
  if (!result.includes("--json")) {
    result.splice(codexSessionId ? 2 : 1, 0, "--json");
  }
  return result;
}

function codexJsonEvents(stdout: string): CodexJsonEvent[] {
  const events: CodexJsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string") continue;
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? event.item as Record<string, unknown>
      : null;
    const agentMessage = event.type === "agent_message" || item?.type === "agent_message";
    events.push({
      type: event.type,
      ...(agentMessage ? { agentMessage: true } : {}),
      ...(typeof event.thread_id === "string" ? { threadId: event.thread_id } : {}),
      ...(typeof event.text === "string"
        ? { text: event.text }
        : item?.type === "agent_message" && typeof item.text === "string"
          ? { text: item.text }
          : {})
    });
  }
  return events;
}
