import fs from "node:fs";
import path from "node:path";
import { dailyNoteDate, localDateStamp, type MemoryPaths } from "./paths";
import { redactSensitiveText, scanMemoryText } from "./safety";

export class MemoryWriteBlockedError extends Error {
  readonly reason: string;
  readonly quarantinePath: string;
  constructor(message: string, reason: string, quarantinePath: string) {
    super(message);
    this.name = "MemoryWriteBlockedError";
    this.reason = reason;
    this.quarantinePath = quarantinePath;
  }
}

export function dailyNotePathFor(paths: MemoryPaths, dateStamp: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStamp)) throw new Error(`invalid date stamp: ${dateStamp}`);
  return path.join(paths.root, `${dateStamp}.md`);
}

export function todayNotePath(paths: MemoryPaths, now: Date = new Date()): string {
  return dailyNotePathFor(paths, localDateStamp(now));
}

export function listDailyNotes(paths: MemoryPaths): { date: string; path: string }[] {
  if (!fs.existsSync(paths.root)) return [];
  const notes: { date: string; path: string }[] = [];
  for (const name of fs.readdirSync(paths.root)) {
    const date = dailyNoteDate(name);
    if (date) notes.push({ date, path: path.join(paths.root, name) });
  }
  notes.sort((a, b) => a.date.localeCompare(b.date));
  return notes;
}

export function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Blocked content is quarantined with a reason, never silently dropped.
 * Secret-bearing content is redacted first: raw credentials must never be
 * stored anywhere in the memory tree, quarantine included. Returns the
 * quarantine file path.
 */
export function quarantine(paths: MemoryPaths, content: string, reason: string, detail: string, now: Date = new Date()): string {
  fs.mkdirSync(paths.quarantineDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = path.join(paths.quarantineDir, `${stamp}-${reason}.md`);
  const preserved = reason === "sensitive-material" ? redactSensitiveText(content, true) : content;
  const body = `---\nquarantined_at: ${now.toISOString()}\nreason: ${reason}\ndetail: ${detail.replace(/\n/g, " ")}\n---\n\n${preserved}\n`;
  fs.writeFileSync(target, body, { mode: 0o600 });
  return target;
}

function assertWritable(paths: MemoryPaths, content: string, label: string, now: Date): void {
  const verdict = scanMemoryText(content);
  if (verdict.ok) return;
  const quarantined = quarantine(paths, content, verdict.reason, verdict.detail, now);
  throw new MemoryWriteBlockedError(
    `${label} blocked (${verdict.reason}); content quarantined at ${quarantined}`,
    verdict.reason,
    quarantined
  );
}

/** Append a block to a daily note, creating the file with a date heading when missing. */
export function appendToDailyNote(paths: MemoryPaths, content: string, options: { date?: string; now?: Date } = {}): string {
  const now = options.now ?? new Date();
  const dateStamp = options.date ?? localDateStamp(now);
  const trimmed = content.replace(/\s+$/, "");
  if (!trimmed.trim()) throw new Error("refusing to append empty content to a daily note");
  assertWritable(paths, trimmed, `daily note ${dateStamp} append`, now);
  const notePath = dailyNotePathFor(paths, dateStamp);
  fs.mkdirSync(paths.root, { recursive: true });
  const existing = readFileIfExists(notePath);
  if (existing == null) {
    fs.writeFileSync(notePath, `# ${dateStamp}\n\n${trimmed}\n`);
  } else {
    const separator = existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(notePath, `${separator}\n${trimmed}\n`);
  }
  return notePath;
}

const editableFiles = new Set(["MEMORY.md", "people.md"]);

/** Replace the full contents of MEMORY.md or people.md. Daily notes are append-only through the tools. */
export function writeEditableFile(paths: MemoryPaths, target: string, content: string, now: Date = new Date()): string {
  if (!editableFiles.has(target)) {
    throw new Error(`only ${[...editableFiles].join(" and ")} may be rewritten; daily notes are append-only`);
  }
  const trimmed = content.replace(/\s+$/, "");
  assertWritable(paths, trimmed, `${target} write`, now);
  fs.mkdirSync(paths.root, { recursive: true });
  const filePath = path.join(paths.root, target);
  fs.writeFileSync(filePath, `${trimmed}\n`);
  return filePath;
}

/** Write a wiki page (used by the sweep). Pages live under wiki/ and are named by slug. */
export function writeWikiPage(paths: MemoryPaths, slug: string, content: string, now: Date = new Date()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`invalid wiki slug: ${slug}`);
  const trimmed = content.replace(/\s+$/, "");
  assertWritable(paths, trimmed, `wiki page ${slug} write`, now);
  fs.mkdirSync(paths.wikiDir, { recursive: true });
  const filePath = path.join(paths.wikiDir, `${slug}.md`);
  fs.writeFileSync(filePath, `${trimmed}\n`);
  return filePath;
}
