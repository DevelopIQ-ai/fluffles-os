import fs from "node:fs";
import path from "node:path";
import { LedgerDb, requiredStringField, runtimeRecordArray } from "@fluffles/storage";
import { localDateStamp, type MemoryPaths } from "./paths";
import { listDailyNotes, readFileIfExists, writeWikiPage } from "./notes";
import { extractLinks, normalizeTitle, slugForTitle } from "./index/links";
import { resolveTitle } from "./index/search";
import { serializeFrontMatter } from "./frontmatter";
import { scanMemoryText } from "./safety";

export interface SweepAction {
  kind: "promoted" | "filed" | "superseded" | "skipped";
  date: string;
  target: string;
  fact: string;
  reason?: string;
}

export interface SweepResult {
  sweptDates: string[];
  actions: SweepAction[];
}

interface Candidate {
  fact: string;
  line: number;
  targets: string[];
  promote: boolean;
}

/**
 * Deterministic candidate extraction: a note line that links `[[somewhere]]`
 * is a candidate durable fact for each page it links, and a line marked
 * `promote:` is a candidate for MEMORY.md. Everything else stays in the note
 * and remains reachable through search.
 */
function extractCandidates(noteText: string): Candidate[] {
  const candidates: Candidate[] = [];
  const lines = noteText.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    const bare = raw.replace(/^[-*]\s+/, "");
    const promote = /^promote:\s*/i.test(bare);
    const fact = bare.replace(/^promote:\s*/i, "").trim();
    if (!fact) continue;
    const targets = extractLinks(raw).map((link) => link.target);
    if (!targets.length && !promote) continue;
    candidates.push({ fact, line: i + 1, targets, promote });
  }
  return candidates;
}

function normalizeFact(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, " ").replace(/\s*\(source:[^)]*\)\s*$/, "").trim();
}

/** The subject of `label: detail` facts, used to supersede in place. */
function factSubject(fact: string): string | null {
  const match = /^([^:\[\]]{1,60}):\s+\S/.exec(fact.replace(/\[\[|\]\]/g, ""));
  return match?.[1] ? match[1].trim().toLowerCase() : null;
}

function pageContentFor(title: string): string {
  return `${serializeFrontMatter({ title: normalizeTitle(title), tags: ["auto"] })}\n`;
}

async function sweptDates(db: LedgerDb): Promise<Set<string>> {
  const rows = db.ensureDb().prepare("SELECT date FROM memory_sweeps").all();
  return new Set(runtimeRecordArray(rows, "memory sweep rows").map((row) => requiredStringField(row, "date", "memory sweep")));
}

/**
 * The nightly sweep. Idempotent per date: a swept date is recorded in the
 * index and never reprocessed; rerunning is a no-op. A failed date writes
 * nothing and stays unswept, so a missed night is caught up by rerunning.
 */
export async function runSweep(db: LedgerDb, paths: MemoryPaths, now: Date = new Date()): Promise<SweepResult> {
  const today = localDateStamp(now);
  const done = await sweptDates(db);
  const pending = listDailyNotes(paths).filter((note) => note.date < today && !done.has(note.date));
  const result: SweepResult = { sweptDates: [], actions: [] };

  for (const note of pending) {
    const actions = sweepOneDate(db, paths, note.date, note.path, now);
    appendPromotions(paths, note.date, actions, now);
    await db.mutate((raw) => {
      raw.prepare("INSERT OR IGNORE INTO memory_sweeps (date, swept_at, summary) VALUES (?, ?, ?)")
        .run(note.date, now.toISOString(), JSON.stringify({
          promoted: actions.filter((action) => action.kind === "promoted").length,
          filed: actions.filter((action) => action.kind === "filed").length,
          superseded: actions.filter((action) => action.kind === "superseded").length,
          skipped: actions.filter((action) => action.kind === "skipped").length
        }));
    });
    result.sweptDates.push(note.date);
    result.actions.push(...actions);
  }
  return result;
}

function sweepOneDate(db: LedgerDb, paths: MemoryPaths, date: string, notePath: string, now: Date): SweepAction[] {
  const noteText = readFileIfExists(notePath);
  if (noteText == null) return [];
  const actions: SweepAction[] = [];

  for (const candidate of extractCandidates(noteText)) {
    const source = `(source: memory/${date}.md:${candidate.line})`;
    const verdict = scanMemoryText(candidate.fact);
    if (!verdict.ok) {
      actions.push({ kind: "skipped", date, target: "-", fact: candidate.fact, reason: verdict.reason });
      continue;
    }
    for (const target of candidate.targets) {
      actions.push(attempt(date, target, candidate.fact, () => fileFactOnPage(db, paths, target, candidate.fact, source, date, now)));
    }
    if (candidate.promote) {
      actions.push(attempt(date, "MEMORY.md", candidate.fact, () => promoteToMemoryFile(paths, candidate.fact, source, date)));
    }
  }
  return actions;
}

/**
 * One bad candidate (an unslugifiable page name, a page whose contents fail
 * the safety scan) must not abort the whole sweep: it becomes a `skipped`
 * action with the error as the reason and lands in PROMOTIONS.md.
 */
function attempt(date: string, target: string, fact: string, run: () => SweepAction): SweepAction {
  try {
    return run();
  } catch (error) {
    return { kind: "skipped", date, target, fact, reason: error instanceof Error ? error.message : String(error) };
  }
}

function fileFactOnPage(db: LedgerDb, paths: MemoryPaths, target: string, fact: string, source: string, date: string, now: Date): SweepAction {
  const resolved = resolveTitle(db, target);
  const slug = resolved ? path.basename(resolved.path, ".md") : slugForTitle(target);
  const pagePath = path.join(paths.wikiDir, `${slug}.md`);
  let content = readFileIfExists(pagePath) ?? pageContentFor(target);
  const factLine = `- ${fact} ${source}`;
  const normalized = normalizeFact(fact);
  const lines = content.split("\n");
  if (lines.some((line) => normalizeFact(line.replace(/^[-*]\s+/, "")) === normalized)) {
    return { kind: "skipped", date, target: `wiki/${slug}.md`, fact, reason: "duplicate" };
  }
  const subject = factSubject(fact);
  if (subject) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? "").replace(/^[-*]\s+/, "");
      if (!line || !/\(source:[^)]*\)\s*$/.test(line)) continue;
      if (factSubject(line) === subject) {
        lines[i] = factLine;
        writeWikiPage(paths, slug, lines.join("\n"), now);
        return { kind: "superseded", date, target: `wiki/${slug}.md`, fact };
      }
    }
  }
  content = `${content.replace(/\s+$/, "")}\n${factLine}`;
  writeWikiPage(paths, slug, content, now);
  return { kind: "filed", date, target: `wiki/${slug}.md`, fact };
}

function promoteToMemoryFile(paths: MemoryPaths, fact: string, source: string, date: string): SweepAction {
  const existing = readFileIfExists(paths.memoryFile) ?? "# MEMORY\n\nDurable facts and standing decisions. Maintained by the nightly sweep and direct edits.\n";
  const normalized = normalizeFact(fact);
  if (existing.split("\n").some((line) => normalizeFact(line.replace(/^[-*]\s+/, "")) === normalized)) {
    return { kind: "skipped", date, target: "MEMORY.md", fact, reason: "duplicate" };
  }
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.memoryFile, `${existing.replace(/\s+$/, "")}\n- ${fact} ${source}\n`);
  return { kind: "promoted", date, target: "MEMORY.md", fact };
}

/** Everything promoted, filed, superseded, and skipped lands in PROMOTIONS.md. */
function appendPromotions(paths: MemoryPaths, date: string, actions: SweepAction[], now: Date): void {
  const lines = [
    `## sweep of ${date} at ${now.toISOString()}`,
    ...(actions.length
      ? actions.map((action) => `- ${action.kind}: ${action.fact} -> ${action.target}${action.reason ? ` (${action.reason})` : ""}`)
      : ["- no candidates"]),
    ""
  ];
  fs.mkdirSync(paths.root, { recursive: true });
  const existing = readFileIfExists(paths.promotionsFile);
  const header = existing == null ? "# promotions\n\nSweep ledger. Appended by `memory promote`.\n\n" : "";
  fs.appendFileSync(paths.promotionsFile, `${header}${lines.join("\n")}\n`);
}
