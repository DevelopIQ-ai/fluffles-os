import { assertSafeMemoryText } from "./memory-safety";

export const WORKING_CONTEXT_MAX_CHARS = 8_000;
export const RECENT_CONTEXT_MAX_CHARS = 8_000;
export const RECENT_SUMMARY_LIMIT = 3;
export const RECENT_BULLET_MAX_CHARS = 500;
const WORKING_FRESHNESS_MS = 36 * 60 * 60 * 1_000;

export function defaultWorking(now = new Date()): string {
  return [
    "# working memory",
    "",
    `Last updated: ${now.toISOString()}`,
    "",
    "## active",
    "",
    "- none recorded.",
    "",
    "## blockers",
    "",
    "- none recorded.",
    "",
    "## assumptions",
    "",
    "- none recorded.",
    "",
    "## next",
    "",
    "- review this file when work changes."
  ].join("\n");
}

export function validateWorking(text: string, title = "# working memory"): string[] {
  const required = [title, "## active", "## blockers", "## assumptions", "## next"];
  const headings = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const issues = required.filter((heading) => !headings.has(heading));
  if (workingUpdatedAt(text) == null) issues.push("missing or invalid Last updated timestamp");
  return issues;
}

export function migrateWorking(text: string): string {
  let migrated = text;
  migrated = migrated.replace(/^Last updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m, "Last updated: $1T00:00:00.000Z");
  if (!migrated.includes("## assumptions")) {
    const nextHeading = /^## next\s*$/m;
    migrated = nextHeading.test(migrated)
      ? migrated.replace(nextHeading, "## assumptions\n\n- none recorded.\n\n## next")
      : `${migrated.trimEnd()}\n\n## assumptions\n\n- none recorded.\n`;
  }
  return migrated;
}

export function workingUpdatedAt(text: string): Date | null {
  const match = /^Last updated:\s*(\S+)\s*$/m.exec(text);
  if (!match) return null;
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(match[1]) ? `${match[1]}T00:00:00.000Z` : match[1];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

export function workingFreshness(text: string, now = new Date()): { fresh: boolean; ageMs: number | null } {
  const updatedAt = workingUpdatedAt(text);
  if (updatedAt == null) return { fresh: false, ageMs: null };
  const ageMs = now.getTime() - updatedAt.getTime();
  return { fresh: ageMs >= 0 && ageMs <= WORKING_FRESHNESS_MS, ageMs };
}

export function renderWorkingContext(path: string, text: string): string {
  assertSafeMemoryText(text, path);
  const body = text.trim();
  if (!body) throw new Error("working memory is empty");
  const issues = validateWorking(body);
  if (issues.length > 0) throw new Error(`working memory is incomplete: ${issues.join(", ")}`);
  const freshness = workingFreshness(body);
  const warning = freshness.fresh ? [] : ["", "[working memory may be stale: update its Last updated timestamp after recording the current state]"];
  const bounded = body.length > WORKING_CONTEXT_MAX_CHARS
    ? `${body.slice(0, WORKING_CONTEXT_MAX_CHARS)}\n\n[working memory truncated]`
    : body;
  return ["working memory from memory hook", `source: ${path}`, "", bounded, ...warning].join("\n");
}

export function sectionBullets(text: string, names: string[]): string[] {
  const lines = text.split(/\r?\n/);
  for (const name of names) {
    const bullets: string[] = [];
    let inSection = false;
    for (const line of lines) {
      if (line.trim() === `## ${name}`) {
        inSection = true;
        continue;
      }
      if (inSection && line.startsWith("## ")) break;
      if (inSection && line.startsWith("- ")) bullets.push(line.slice(2).trim().slice(0, RECENT_BULLET_MAX_CHARS));
    }
    if (bullets.length > 0) return bullets;
  }
  return [];
}

export function renderRecentContext(directory: string, entries: Array<{ date: string; path: string; bullets: string[] }>): string {
  const lines = ["recent daily summaries from memory hook", `source: ${directory}`];
  for (const entry of entries) {
    lines.push("", `## ${entry.date}`, `file: ${entry.path}`);
    for (const bullet of entry.bullets) lines.push(`- ${bullet}`);
  }
  const text = lines.join("\n");
  return text.length > RECENT_CONTEXT_MAX_CHARS ? `${text.slice(0, RECENT_CONTEXT_MAX_CHARS)}\n\n[recent summaries truncated]` : text;
}
