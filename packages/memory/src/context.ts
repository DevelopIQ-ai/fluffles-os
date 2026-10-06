import { localDateStamp, type MemoryPaths } from "./paths";
import { dailyNotePathFor, readFileIfExists } from "./notes";

/**
 * The always-loaded block: MEMORY.md, people.md, and today's and yesterday's
 * notes (AGENTS.md is loaded by the host tool itself). Roughly 3.7k tokens at
 * the ceiling, fixed no matter how much history exists. If a file outgrows its
 * budget the file on disk is never touched; only the injected copy is
 * truncated, and the block header reports raw versus injected size.
 */
const CHARS_PER_TOKEN = 4;

interface ContextSource {
  label: string;
  filePath: string;
  budgetTokens: number;
  /** Notes keep their tail (most recent entries); durable files keep their head. */
  keep: "head" | "tail";
}

export function buildContextBlock(paths: MemoryPaths, now: Date = new Date()): string {
  const today = localDateStamp(now);
  const yesterday = localDateStamp(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const sources: ContextSource[] = [
    { label: "memory/MEMORY.md", filePath: paths.memoryFile, budgetTokens: 1400, keep: "head" },
    { label: "memory/people.md", filePath: paths.peopleFile, budgetTokens: 700, keep: "head" },
    { label: `memory/${yesterday}.md`, filePath: dailyNotePathFor(paths, yesterday), budgetTokens: 700, keep: "tail" },
    { label: `memory/${today}.md`, filePath: dailyNotePathFor(paths, today), budgetTokens: 900, keep: "tail" }
  ];

  const sections: string[] = [];
  for (const source of sources) {
    const raw = readFileIfExists(source.filePath);
    if (raw == null) {
      sections.push(`## ${source.label} (missing)`);
      continue;
    }
    const trimmed = raw.trimEnd();
    const budgetChars = source.budgetTokens * CHARS_PER_TOKEN;
    let injected = trimmed;
    if (trimmed.length > budgetChars) {
      injected = source.keep === "head"
        ? `${trimmed.slice(0, budgetChars)}\n[...truncated]`
        : `[truncated...]\n${trimmed.slice(trimmed.length - budgetChars)}`;
    }
    const header = trimmed.length > budgetChars
      ? `## ${source.label} (raw ${trimmed.length} chars, injected ${injected.length} chars)`
      : `## ${source.label} (${trimmed.length} chars)`;
    sections.push(`${header}\n\n${injected}`);
  }
  return `# memory context\n\n${sections.join("\n\n")}\n`;
}
