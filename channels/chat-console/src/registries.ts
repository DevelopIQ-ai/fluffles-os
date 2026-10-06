import fs from "node:fs";
import path from "node:path";
import { loadRegistry, type AutomationSpec } from "@fluffles/automations";
import { loadToolRegistry } from "@fluffles/capabilities";
import { codexModel, codexReasoningEffort, codexServiceTier, home, sourceRoot } from "./config";

export interface AutomationTrigger {
  kind: string;
  detail: string | null;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  stepCount: number;
  triggers: AutomationTrigger[];
}

export interface Hook {
  tool: string;
  event: string;
  command: string;
  timeoutSeconds: number | null;
  statusMessage: string | null;
}

export interface Connection {
  name: string;
  description: string;
  command: string;
  toolNames: string[];
  required: boolean;
  hasHealthProbe: boolean;
}

export interface Skill {
  name: string;
  description: string | null;
  path: string;
  source: string | null;
  sourceType: string | null;
}

export interface ModelInfo {
  executor: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
}

/** Automations are what fires Fluffles: the declarative specs and the triggers they carry. */
export function loadAutomations(): Automation[] {
  const registry = loadRegistry({ root: path.join(sourceRoot, "automations"), stateDir: path.join(home, "state") });
  return registry.automations.map(({ spec }) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description ?? null,
    enabled: spec.enabled,
    stepCount: spec.steps.length,
    triggers: spec.triggers.map((trigger) => ({ kind: trigger.kind, detail: triggerDetail(trigger) }))
  }));
}

/** Hooks are the harness-owned event handlers, one row per hook command. */
export function loadHooks(hooksRoot = path.join(sourceRoot, "hooks")): Hook[] {
  if (!fs.existsSync(hooksRoot)) return [];
  return fs.readdirSync(hooksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(hooksRoot, entry.name, "hooks.json")))
    .flatMap((entry) => readHookManifest(entry.name, path.join(hooksRoot, entry.name, "hooks.json")));
}

/** Connections are the MCP-manifest-derived tool inventory. */
export function loadConnections(): Connection[] {
  const registry = loadToolRegistry({
    manifestsDir: path.join(sourceRoot, "tools", "mcp", "manifests"),
    harnessPath: path.join(sourceRoot, "tools", "capabilities", "harness.json")
  });
  return registry.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    command: tool.command,
    toolNames: tool.toolNames,
    required: tool.required,
    hasHealthProbe: tool.health !== null
  }));
}

/** Skills are the installed SKILL.md files, annotated with lock-file provenance. */
export function loadSkills(): Skill[] {
  const skillsRoot = path.join(sourceRoot, "skills");
  if (!fs.existsSync(skillsRoot)) return [];
  const lock = readSkillsLock(path.join(skillsRoot, "skills-lock.json"));
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => {
      const relativePath = path.join("skills", entry.name, "SKILL.md");
      const front = frontMatter(fs.readFileSync(path.join(skillsRoot, entry.name, "SKILL.md"), "utf8"));
      const locked = lock[entry.name];
      return {
        name: front.name ?? entry.name,
        description: front.description ?? null,
        path: relativePath,
        source: locked?.source ?? null,
        sourceType: locked?.sourceType ?? null
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function modelInfo(): ModelInfo {
  return { executor: "codex", model: codexModel, reasoningEffort: codexReasoningEffort, serviceTier: codexServiceTier };
}

function triggerDetail(trigger: AutomationSpec["triggers"][number]): string | null {
  if (trigger.kind === "schedule") return `${trigger.cron} ${trigger.tz}`;
  if (trigger.kind === "http") return `${trigger.method} ${trigger.path}`;
  if (trigger.kind === "event") return `${trigger.source}.${trigger.event}`;
  return null;
}

/**
 * A hook manifest nests command entries two groups deep under each event, the
 * shape the host tool reads, so the console flattens it into one row per
 * command and ignores anything that is not a command hook.
 */
function readHookManifest(tool: string, filePath: string): Hook[] {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const events = record(value)?.hooks;
  const byEvent = record(events);
  if (!byEvent) return [];
  const hooks: Hook[] = [];
  for (const [event, groups] of Object.entries(byEvent)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = record(group)?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const hook = record(entry);
        if (!hook || hook.type !== "command" || typeof hook.command !== "string") continue;
        hooks.push({
          tool,
          event,
          command: hook.command,
          timeoutSeconds: typeof hook.timeout === "number" ? hook.timeout : null,
          statusMessage: typeof hook.statusMessage === "string" ? hook.statusMessage : null
        });
      }
    }
  }
  return hooks;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSkillsLock(filePath: string): Record<string, { source?: string; sourceType?: string }> {
  if (!fs.existsSync(filePath)) return {};
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (typeof value !== "object" || value === null) return {};
  const skills = (value as { skills?: unknown }).skills;
  if (typeof skills !== "object" || skills === null) return {};
  const entries = Object.entries(skills as Record<string, unknown>).flatMap(([name, entry]) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as { source?: unknown; sourceType?: unknown };
    return [[name, {
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(typeof record.sourceType === "string" ? { sourceType: record.sourceType } : {})
    }]] as [string, { source?: string; sourceType?: string }][];
  });
  return Object.fromEntries(entries);
}

/** Reads only the two SKILL.md front-matter fields the console displays. */
function frontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line);
    if (!field?.[1] || !field[2]) continue;
    const value = field[2].trim().replace(/^["']|["']$/g, "");
    if (field[1] === "name") result.name = value;
    else result.description = value;
  }
  return result;
}
