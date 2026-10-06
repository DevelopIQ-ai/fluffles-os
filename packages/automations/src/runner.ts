import { spawn } from "node:child_process";
import { renderTemplate } from "./template";
import type { AutomationEvent, AutomationSpec, CommandStep, HttpStep, Step, StepExecutors, StepResult } from "./types";

export type { StepExecutors };

export type RunOutcome = {
  ok: boolean;
  steps: readonly StepResult[];
  error: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeCommandStep(step: CommandStep, event: AutomationEvent): Promise<string> {
  const argv = step.argv.map((entry) => String(renderTemplate(entry, { event, payload: event.payload })));
  const [command, ...args] = argv as [string, ...string[]];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: step.cwd ?? process.cwd(),
      env: { ...process.env, ...step.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`step ${step.name} timed out after ${step.timeoutMs}ms`));
    }, step.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(stdout.trim().slice(-2000)); return; }
      reject(new Error(`step ${step.name} exited ${code}: ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

export async function executeHttpStep(step: HttpStep, event: AutomationEvent): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), step.timeoutMs);
  try {
    const body = step.body === null
      ? undefined
      : JSON.stringify(renderTemplate(step.body, { event, payload: event.payload }));
    const response = await fetch(step.url, {
      method: step.method,
      headers: { "content-type": "application/json", ...step.headers },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal
    });
    const text = (await response.text()).slice(0, 2000);
    if (!response.ok) throw new Error(`step ${step.name} got ${response.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export const defaultStepExecutors: StepExecutors = {
  command: executeCommandStep,
  http: executeHttpStep
};

/** Runs an automation's steps in order, stopping at the first failure. */
export async function runSteps(
  spec: AutomationSpec,
  event: AutomationEvent,
  executors: StepExecutors = defaultStepExecutors,
  now: () => Date = () => new Date()
): Promise<RunOutcome> {
  const results: StepResult[] = [];
  for (const step of spec.steps) {
    const startedAt = now().toISOString();
    try {
      const detail = await executeStep(step, event, executors);
      results.push({ name: step.name, kind: step.kind, ok: true, detail, startedAt, finishedAt: now().toISOString() });
    } catch (error) {
      const message = errorMessage(error);
      results.push({ name: step.name, kind: step.kind, ok: false, detail: message, startedAt, finishedAt: now().toISOString() });
      return { ok: false, steps: results, error: message };
    }
  }
  return { ok: true, steps: results, error: null };
}

function executeStep(step: Step, event: AutomationEvent, executors: StepExecutors): Promise<string> {
  return step.kind === "command" ? executors.command(step, event) : executors.http(step, event);
}
