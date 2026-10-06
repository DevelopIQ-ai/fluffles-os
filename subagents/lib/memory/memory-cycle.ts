#!/usr/bin/env node
import os from "node:os";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { defaultWorking, migrateWorking, RECENT_SUMMARY_LIMIT, renderRecentContext, renderWorkingContext, sectionBullets, validateWorking, workingFreshness } from "./memory-context";
import { localDate, localDateRange, shiftDate, validateDate } from "./memory-date";
import { assertSafeMemoryText, redactSensitiveValue } from "./memory-safety";
import { readOptionalText, withFileLock, writeAtomicText } from "./memory-storage";

const execFileAsync = promisify(execFile);
const HOME = process.env.MEMORY_CYCLE_HOME || process.env.HOME || os.homedir();
const WORKSPACE_ID = process.env.MEMORY_CYCLE_WORKSPACE_ID || "00000000-0000-0000-0000-000000000000";
const MEMORY_DIR = path.join(HOME, "memory");
const WORKING_PATH = path.join(MEMORY_DIR, "working.md");
const DAILY_DIR = path.join(MEMORY_DIR, "summaries", "daily");
const AGENTS_PATH = path.join(HOME, "AGENTS.md");
const STASH_PATH = path.join(HOME, "bin", "stash");
const DAILY_EVIDENCE_LIMIT = 200;
const DAILY_BULLET_LIMIT = 24;
const DAILY_BULLET_MAX_CHARS = 420;

type Command = "inspect" | "update-working" | "check-working" | "working-context" | "daily" | "recent" | "transcript-search" | "run" | "health";
type Args = { command: Command; json: boolean; dryRun: boolean; yesterday: boolean; date: string | null; query: string | null; replace: boolean };
type CommandResult = { ok: boolean; stdout: string; stderr: string };
type StashEvent = { id: string; at: string; agent: string; type: string; content: string; toolName: string | null; metadata: Record<string, unknown> };
type DailyEntryKind = "work.outcome" | "tool.exit" | "decision";
type DailyEntry = { id: string; at: string; component: string; kind: DailyEntryKind; result: string; summary: string; runId: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "inspect", json: false, dryRun: false, yesterday: false, date: null, query: null, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") args.json = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--yesterday") args.yesterday = true;
    else if (value === "--replace") args.replace = true;
    else if (value === "--date" || value === "--query") {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--date") args.date = validateDate(next);
      else args.query = next;
    } else if (value === "--help" || value === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (!value.startsWith("-")) {
      if (!isCommand(value)) throw new Error(`unknown command ${value}`);
      args.command = value;
    } else throw new Error(`unknown option ${value}`);
  }
  return args;
}

function isCommand(value: string): value is Command {
  return ["inspect", "update-working", "check-working", "working-context", "daily", "recent", "transcript-search", "run", "health"].includes(value);
}

function usage(): string {
  return "Usage: memory-cycle <inspect|update-working|check-working|working-context|daily|recent|transcript-search|run|health> [--json] [--dry-run] [--date YYYY-MM-DD] [--yesterday] [--replace] [--query text]";
}

function requestedDate(args: Args): string {
  if (args.date) return args.date;
  return args.yesterday ? shiftDate(localDate(), -1) : localDate();
}

async function run(file: string, args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  try {
    const result = await execFileAsync(file, args, { cwd: HOME, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, STASH_TELEMETRY: "0" } });
    return { ok: true, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim() };
  } catch (error: unknown) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: String(failure.stdout || "").trim(), stderr: String(failure.stderr || "memory dependency failed").trim() };
  }
}

function dailyFiles(): Array<{ date: string; path: string }> {
  try {
    return fs.readdirSync(DAILY_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => {
        const date = validateDate(entry.name.slice(0, -3));
        return { date, path: path.join(DAILY_DIR, entry.name) };
      })
      .sort((left, right) => left.date.localeCompare(right.date));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function validateDailyText(text: string, date: string, filePath: string): void {
  assertSafeMemoryText(text, filePath);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== `# daily summary: ${date}`) {
    throw new Error(`${filePath} has an invalid daily summary title`);
  }
  const headings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line.startsWith("## "));
  const allowed = new Set(["## what happened and results", "## work and decisions", "## decisions", "## unresolved", "## evidence"]);
  if (headings.some((entry) => !allowed.has(entry.line))) throw new Error(`${filePath} has an unknown daily summary section`);
  if (new Set(headings.map((entry) => entry.line)).size !== headings.length) throw new Error(`${filePath} has duplicate daily summary sections`);

  const workSections = headings.filter((entry) => entry.line === "## what happened and results" || entry.line === "## work and decisions");
  const work = workSections[0];
  const unresolved = headings.find((entry) => entry.line === "## unresolved");
  const evidence = headings.find((entry) => entry.line === "## evidence");
  const decisions = headings.find((entry) => entry.line === "## decisions");
  if (workSections.length !== 1 || !unresolved || !evidence) throw new Error(`${filePath} is missing required daily summary sections or duplicates a required section`);
  if (!(work.index < (decisions?.index ?? unresolved.index) && (decisions?.index ?? work.index) < unresolved.index && unresolved.index < evidence.index)) {
    throw new Error(`${filePath} has invalid daily summary section order`);
  }
  for (const section of [work, decisions, unresolved, evidence].filter((entry) => entry != null)) {
    const nextHeading = headings.find((entry) => entry.index > section.index);
    const body = lines.slice(section.index + 1, nextHeading?.index ?? lines.length);
    if (!body.some((line) => line.trim().startsWith("- "))) throw new Error(`${filePath} has an empty ${section.line.slice(3)} section`);
  }
}

async function validateExistingDaily(filePath: string, date: string): Promise<boolean> {
  if (!fileStatus(filePath)) return false;
  const existing = await readOptionalText(filePath);
  if (existing == null) throw new Error(`${filePath} disappeared while validating`);
  validateDailyText(existing, date, filePath);
  return true;
}

function fileStatus(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

async function inspect(): Promise<Record<string, unknown>> {
  const agents = await readOptionalText(AGENTS_PATH);
  if (agents != null) assertSafeMemoryText(agents, AGENTS_PATH);
  const working = await readOptionalText(WORKING_PATH);
  const workingIssues = working == null ? ["missing"] : validateWorking(working);
  if (working != null) assertSafeMemoryText(working, WORKING_PATH);
  return {
    ok: fileStatus(AGENTS_PATH) && workingIssues.length === 0 && fileStatus(STASH_PATH),
    layers: {
      agents: { path: AGENTS_PATH, exists: fileStatus(AGENTS_PATH) },
      working: { path: WORKING_PATH, issues: workingIssues, freshness: working == null ? null : workingFreshness(working) },
      daily: { path: DAILY_DIR, count: dailyFiles().length },
      transcripts: { command: STASH_PATH, available: fileStatus(STASH_PATH) }
    }
  };
}

async function updateWorking(args: Args): Promise<Record<string, unknown>> {
  return withFileLock(WORKING_PATH, async () => {
    const existing = await readOptionalText(WORKING_PATH);
    if (existing == null) {
      const text = defaultWorking();
      if (!args.dryRun) await writeAtomicText(WORKING_PATH, text);
      return { ok: true, created: true, path: WORKING_PATH };
    }
    assertSafeMemoryText(existing, WORKING_PATH);
    const migrated = migrateWorking(existing);
    if (migrated !== existing && !args.dryRun) await writeAtomicText(WORKING_PATH, migrated);
    const issues = validateWorking(migrated);
    return { ok: issues.length === 0, created: false, migrated: migrated !== existing, path: WORKING_PATH, issues, freshness: workingFreshness(migrated) };
  });
}

async function checkWorking(): Promise<Record<string, unknown>> {
  const text = await readOptionalText(WORKING_PATH);
  if (text == null) return { ok: false, path: WORKING_PATH, issues: ["missing"] };
  assertSafeMemoryText(text, WORKING_PATH);
  const issues = validateWorking(text);
  return { ok: issues.length === 0, path: WORKING_PATH, issues, freshness: workingFreshness(text) };
}

async function workingContext(): Promise<Record<string, unknown>> {
  const text = await readOptionalText(WORKING_PATH);
  if (text == null) throw new Error("working memory is missing");
  return { ok: true, text: renderWorkingContext(WORKING_PATH, text) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseStashEvents(stdout: string): StashEvent[] {
  const parsed: unknown = JSON.parse(stdout);
  const events = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.events) ? parsed.events : null;
  if (events == null) throw new Error("Stash event query returned invalid data");
  return events.map((entry): StashEvent => {
    const value = entry as Record<string, unknown>;
    return {
      id: String(value.id || ""),
      at: String(value.created_at || ""),
      agent: String(value.agent_name || "unknown"),
      type: String(value.event_type || ""),
      content: String(value.content || ""),
      toolName: value.tool_name == null ? null : String(value.tool_name),
      metadata: isRecord(value.metadata) ? value.metadata : {}
    };
  });
}

function eventOccursInRange(event: StashEvent, range: { from: string; until: string }): boolean {
  const timestamp = Date.parse(event.at);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(range.from) && timestamp < Date.parse(range.until);
}

function normalizedEvidenceLine(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").trim();
}

function eventSummary(lines: string[]): string {
  return lines.slice(0, 3).join(" ").replace(/\s+/g, " ").trim().slice(0, DAILY_BULLET_MAX_CHARS);
}

function explicitDecisionValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return [];
}

function assistantEvidence(event: StashEvent): { decisions: string[]; outcome: string } {
  assertSafeMemoryText(event.content, "Stash daily evidence");
  const decisions = [
    ...explicitDecisionValues(event.metadata.decision),
    ...explicitDecisionValues(event.metadata.decisions)
  ];
  const outcomeLines: string[] = [];
  let inDecisionSection = false;
  for (const rawLine of event.content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^#{1,6}\s+decisions?(?:\s+made)?\s*$/i.test(trimmed)) {
      inDecisionSection = true;
      continue;
    }
    if (inDecisionSection && /^#{1,6}\s+/.test(trimmed)) inDecisionSection = false;
    const line = normalizedEvidenceLine(rawLine);
    if (!line || /^```/.test(line)) continue;
    if (inDecisionSection) {
      decisions.push(line);
      continue;
    }
    const directDecision = /^(?:decision|decisions made)\s*:\s*(.+)$/i.exec(line);
    if (directDecision) {
      decisions.push(directDecision[1].trim());
      continue;
    }
    outcomeLines.push(line);
  }
  const safeDecisions = decisions
    .map((decision) => {
      assertSafeMemoryText(decision, "Stash daily decision evidence");
      return eventSummary([decision]);
    })
    .filter(Boolean)
    .filter((decision, index, entries) => entries.indexOf(decision) === index);
  return { decisions: safeDecisions, outcome: eventSummary(outcomeLines) };
}

function decisionId(event: StashEvent, index: number, summary: string): string {
  const prefix = event.id || `${event.at}:${event.agent}`;
  return `${prefix}:decision:${index}:${summary}`;
}

function decisionEntries(event: StashEvent, decisions: string[]): DailyEntry[] {
  return decisions.map((summary, index) => ({
    id: decisionId(event, index, summary),
    at: event.at,
    component: event.agent,
    kind: "decision",
    result: "decided",
    summary,
    runId: null
  }));
}

function failedToolExit(event: StashEvent): number | null {
  const exitCode = event.metadata.exit_code ?? event.metadata.exitCode;
  const value = typeof exitCode === "number" ? exitCode : typeof exitCode === "string" ? Number(exitCode) : NaN;
  return Number.isInteger(value) && value !== 0 ? value : null;
}

async function dailyEvidence(date: string): Promise<DailyEntry[]> {
  const range = localDateRange(date);
  const result = await run(STASH_PATH, ["sessions", "query", "--ws", WORKSPACE_ID, "--after", range.from, "--order", "asc", "--limit", String(DAILY_EVIDENCE_LIMIT), "--json"]);
  if (!result.ok) throw new Error("daily raw-evidence lookup failed");
  const records = parseStashEvents(result.stdout).filter((event) => eventOccursInRange(event, range));
  if (records.length >= DAILY_EVIDENCE_LIMIT) throw new Error("daily raw-evidence limit reached; summary would be incomplete");
  const entries: DailyEntry[] = [];
  for (const event of records.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))) {
    if (event.type === "assistant_message") {
      const evidence = assistantEvidence(event);
      entries.push(...decisionEntries(event, evidence.decisions));
      const summary = evidence.outcome;
      if (summary) entries.push({ id: event.id || `${event.at}:${event.agent}:${summary}`, at: event.at, component: event.agent, kind: "work.outcome", result: "done", summary, runId: null });
      continue;
    }
    const exitCode = event.type === "tool_use" ? failedToolExit(event) : null;
    if (exitCode != null) {
      entries.push({
        id: event.id || `${event.at}:${event.agent}:${event.toolName || "tool"}:${exitCode}`,
        at: event.at,
        component: event.toolName || event.agent,
        kind: "tool.exit",
        result: "attention",
        summary: `${event.toolName || "tool"} failed with exit ${exitCode}`,
        runId: null
      });
    }
  }
  return entries;
}

function newestFirst(entries: DailyEntry[]): DailyEntry[] {
  return [...entries].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
}

function renderDaily(date: string, evidence: DailyEntry[], previouslyOmitted = 0): string {
  const important = newestFirst(evidence.filter((entry) => entry.result === "attention"));
  const decisions = newestFirst(evidence.filter((entry) => entry.kind === "decision"));
  const ordinary = newestFirst(evidence.filter((entry) => entry.result !== "attention" && entry.kind !== "decision"));
  const required = [important[0], decisions[0], ordinary[0]].filter((entry): entry is DailyEntry => entry != null);
  const selected = [...required, ...important, ...decisions, ...ordinary]
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id && candidate.at === entry.at) === index)
    .slice(0, DAILY_BULLET_LIMIT)
    .sort((left, right) => left.at.localeCompare(right.at));
  const omitted = Math.max(0, previouslyOmitted) + evidence.length - selected.length;
  const selectedDecisions = selected.filter((entry) => entry.kind === "decision");
  const selectedOrdinary = selected.filter((entry) => entry.result !== "attention" && entry.kind !== "decision");
  const selectedImportant = selected.filter((entry) => entry.result === "attention");
  const lines = [`# daily summary: ${date}`, "", "## what happened and results", ""];
  if (selected.length === 0) lines.push("- no activity was recorded.");
  else if (selectedOrdinary.length === 0) lines.push("- no non-decision work was recorded.");
  else for (const entry of selectedOrdinary) lines.push(`- ${entry.component} (${entry.result}): ${entry.summary}`);
  if (selectedDecisions.length > 0) {
    lines.push("", "## decisions", "");
    for (const entry of selectedDecisions) lines.push(`- ${entry.component} (${entry.result}): ${entry.summary}`);
  }
  lines.push("", "## unresolved", "");
  if (selectedImportant.length === 0) lines.push("- no unresolved attention records were captured.");
  else for (const entry of selectedImportant) lines.push(`- ${entry.component} (${entry.result}): ${entry.summary}`);
  lines.push("", "## evidence", "", `- raw transcript lookup: \`$HOME/bin/memory-cycle transcript-search --query "${date}"\``, "");
  if (omitted > 0) lines.push(`- ${omitted} additional raw evidence records are available in Stash for this date.`);
  return lines.join("\n");
}

async function writeDaily(date: string, args: Args): Promise<Record<string, unknown>> {
  const outputPath = path.join(DAILY_DIR, `${date}.md`);
  if (args.dryRun) {
    if (!args.replace && await validateExistingDaily(outputPath, date)) return { ok: true, date, path: outputPath, skipped: true };
    const evidence = await dailyEvidence(date);
    return { ok: true, date, path: outputPath, skipped: false, records: evidence.length };
  }
  return withFileLock(outputPath, async () => {
    if (!args.replace && await validateExistingDaily(outputPath, date)) return { ok: true, date, path: outputPath, skipped: true };
    const evidence = await dailyEvidence(date);
    await writeAtomicText(outputPath, renderDaily(date, evidence));
    return { ok: true, date, path: outputPath, skipped: false, records: evidence.length };
  });
}

async function recent(): Promise<Record<string, unknown>> {
  const entries: Array<{ date: string; path: string; bullets: string[] }> = [];
  for (const file of dailyFiles().reverse()) {
    const text = await readOptionalText(file.path);
    if (text == null) continue;
    validateDailyText(text, file.date, file.path);
    const bullets = sectionBullets(text, ["what happened and results", "work and decisions", "focus", "next"]);
    entries.push({ date: file.date, path: file.path, bullets: bullets.slice(0, 4) });
    if (entries.length === RECENT_SUMMARY_LIMIT) break;
  }
  return { ok: true, entries, text: renderRecentContext(DAILY_DIR, entries) };
}

async function transcriptSearch(args: Args): Promise<Record<string, unknown>> {
  const query = args.query?.trim();
  if (!query) throw new Error("transcript-search requires --query");
  assertSafeMemoryText(query, "transcript search query");
  const result = await run(STASH_PATH, ["search", query, "--ws", WORKSPACE_ID, "--limit", "20", "--json"]);
  if (!result.ok) return { ok: false, error: "transcript search failed" };
  try {
    return { ok: true, result: redactSensitiveValue(JSON.parse(result.stdout)) };
  } catch {
    return { ok: false, error: "transcript search returned invalid JSON" };
  }
}

function missingDailyDates(target: string): string[] {
  const files = dailyFiles();
  if (files.length === 0) return [target];
  const existing = new Set(files.map((file) => file.date));
  if (target < files[0].date) return existing.has(target) ? [] : [target];
  const dates: string[] = [];
  for (let date = files[0].date; date <= target; date = shiftDate(date, 1)) if (!existing.has(date)) dates.push(date);
  return dates;
}

async function validateDailyHistory(target: string): Promise<void> {
  for (const file of dailyFiles()) {
    if (file.date > target) break;
    await validateExistingDaily(file.path, file.date);
  }
}

async function runCycle(args: Args): Promise<Record<string, unknown>> {
  const target = requestedDate(args);
  await validateDailyHistory(target);
  const written: Array<Record<string, unknown>> = [];
  for (const date of missingDailyDates(target)) written.push(await writeDaily(date, args));
  const working = await updateWorking(args);
  return { ok: written.every((item) => item.ok === true) && working.ok === true, target, daily: written, working };
}

async function dispatch(args: Args): Promise<Record<string, unknown>> {
  if (args.command === "inspect" || args.command === "health") return inspect();
  if (args.command === "update-working") return updateWorking(args);
  if (args.command === "check-working") return checkWorking();
  if (args.command === "working-context") return workingContext();
  if (args.command === "daily") return writeDaily(requestedDate(args), args);
  if (args.command === "recent") return recent();
  if (args.command === "transcript-search") return transcriptSearch(args);
  return runCycle(args);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const payload = await dispatch(args);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else if ("text" in payload) console.log(payload.text);
  else console.log(JSON.stringify(payload, null, 2));
  if (payload.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { assistantEvidence, dailyEvidence, localDateRange, missingDailyDates, renderDaily, requestedDate, validateDate };
