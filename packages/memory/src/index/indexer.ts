import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LedgerDb, requiredNumberField, requiredStringField, runtimeRecordArray } from "@fluffles/storage";
import { frontMatterList, parseFrontMatter } from "../frontmatter";
import { isDailyNoteName, dailyNoteDate, type MemoryPaths } from "../paths";
import { extractLinks, normalizeTitle } from "./links";

export interface IndexResult {
  indexed: number;
  removed: number;
  unchanged: number;
  documents: number;
}

interface SourceFile {
  /** Path relative to the memory root, the stable document key. */
  relPath: string;
  absPath: string;
  kind: "note" | "wiki" | "durable";
}

interface ParsedDocument extends SourceFile {
  title: string;
  date: string | null;
  sha256: string;
  mtimeMs: number;
  tags: [string, string][];
  aliases: string[];
  links: { target: string; line: number }[];
  chunks: { lineStart: number; lineEnd: number; body: string }[];
}

const DURABLE_FILES = ["MEMORY.md", "people.md"] as const;

function listSourceFiles(paths: MemoryPaths): SourceFile[] {
  const files: SourceFile[] = [];
  if (fs.existsSync(paths.root)) {
    for (const name of fs.readdirSync(paths.root)) {
      if (isDailyNoteName(name)) {
        files.push({ relPath: name, absPath: path.join(paths.root, name), kind: "note" });
      }
    }
  }
  for (const name of DURABLE_FILES) {
    const absPath = path.join(paths.root, name);
    if (fs.existsSync(absPath)) files.push({ relPath: name, absPath, kind: "durable" });
  }
  if (fs.existsSync(paths.wikiDir)) {
    for (const name of fs.readdirSync(paths.wikiDir)) {
      if (!name.endsWith(".md") || name === "index.md") continue;
      files.push({ relPath: `wiki/${name}`, absPath: path.join(paths.wikiDir, name), kind: "wiki" });
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function parseDocument(file: SourceFile, text: string, mtimeMs: number): ParsedDocument {
  const front = parseFrontMatter(text);
  const lines = text.split("\n");
  const bodyStart = front.lineCount;
  const fallbackTitle = file.kind === "note"
    ? (dailyNoteDate(path.basename(file.relPath)) ?? file.relPath)
    : path.basename(file.relPath, ".md");
  const titleField = front.fields.title;
  const title = typeof titleField === "string" && titleField.trim() ? titleField.trim() : fallbackTitle;
  const dateField = front.fields.date;
  const date = typeof dateField === "string" && dateField
    ? dateField
    : dailyNoteDate(path.basename(file.relPath));

  const tags: [string, string][] = [];
  for (const [key, value] of Object.entries(front.fields)) {
    if (key === "title" || key === "aliases") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item) tags.push([key, String(item)]);
    }
  }

  const chunks: { lineStart: number; lineEnd: number; body: string }[] = [];
  let start = -1;
  for (let i = bodyStart; i <= lines.length; i += 1) {
    const blank = i === lines.length || !(lines[i] ?? "").trim();
    if (!blank && start === -1) start = i;
    if (blank && start !== -1) {
      chunks.push({
        lineStart: start + 1,
        lineEnd: i,
        body: lines.slice(start, i).join("\n")
      });
      start = -1;
    }
  }

  return {
    ...file,
    title,
    date,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    mtimeMs: Math.floor(mtimeMs),
    tags,
    aliases: frontMatterList(front.fields, "aliases"),
    links: extractLinks(text),
    chunks
  };
}

/**
 * Incremental scan by mtime plus sha256. Unchanged documents keep their rows;
 * changed or new documents are replaced; documents whose file disappeared are
 * removed. Alias and link resolution is rebuilt as a whole because it is
 * global and cheap.
 */
export async function indexMemory(db: LedgerDb, paths: MemoryPaths, now: Date = new Date()): Promise<IndexResult> {
  const files = listSourceFiles(paths);
  const parsed: ParsedDocument[] = [];
  for (const file of files) {
    const stat = fs.statSync(file.absPath);
    parsed.push(parseDocument(file, fs.readFileSync(file.absPath, "utf8"), stat.mtimeMs));
  }

  return db.mutate((raw) => {
    const existing = new Map<string, { sha256: string; mtimeMs: number }>();
    for (const row of runtimeRecordArray(raw.prepare("SELECT path, sha256, mtime_ms FROM memory_documents").all(), "memory_documents rows")) {
      existing.set(requiredStringField(row, "path", "memory document"), {
        sha256: requiredStringField(row, "sha256", "memory document"),
        mtimeMs: requiredNumberField(row, "mtime_ms", "memory document")
      });
    }

    const seen = new Set<string>();
    let indexed = 0;
    let unchanged = 0;
    for (const document of parsed) {
      seen.add(document.relPath);
      const prior = existing.get(document.relPath);
      if (prior && prior.sha256 === document.sha256 && prior.mtimeMs === document.mtimeMs) {
        unchanged += 1;
        continue;
      }
      raw.prepare("DELETE FROM memory_fts WHERE path = ?").run(document.relPath);
      raw.prepare("DELETE FROM memory_tags WHERE path = ?").run(document.relPath);
      raw.prepare(
        "INSERT INTO memory_documents (path, kind, title, date, sha256, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, title = excluded.title, date = excluded.date, " +
        "sha256 = excluded.sha256, mtime_ms = excluded.mtime_ms, indexed_at = excluded.indexed_at"
      ).run(document.relPath, document.kind, document.title, document.date, document.sha256, document.mtimeMs, now.toISOString());
      for (const [key, value] of document.tags) {
        raw.prepare("INSERT OR IGNORE INTO memory_tags (path, key, value) VALUES (?, ?, ?)").run(document.relPath, key, value);
      }
      for (const chunk of document.chunks) {
        raw.prepare(
          "INSERT INTO memory_fts (path, kind, line_start, line_end, title, body) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(document.relPath, document.kind, chunk.lineStart, chunk.lineEnd, document.title, chunk.body);
      }
      indexed += 1;
    }

    let removed = 0;
    for (const stalePath of existing.keys()) {
      if (seen.has(stalePath)) continue;
      raw.prepare("DELETE FROM memory_documents WHERE path = ?").run(stalePath);
      raw.prepare("DELETE FROM memory_fts WHERE path = ?").run(stalePath);
      raw.prepare("DELETE FROM memory_tags WHERE path = ?").run(stalePath);
      removed += 1;
    }

    // Aliases and links are global: rebuild both directions from the parse.
    raw.prepare("DELETE FROM memory_aliases").run();
    raw.prepare("DELETE FROM memory_links").run();
    for (const document of parsed) {
      if (document.kind !== "wiki") continue;
      raw.prepare("INSERT OR REPLACE INTO memory_aliases (alias, title, path) VALUES (?, ?, ?)")
        .run(normalizeTitle(document.title), document.title, document.relPath);
      for (const alias of document.aliases) {
        raw.prepare("INSERT OR REPLACE INTO memory_aliases (alias, title, path) VALUES (?, ?, ?)")
          .run(normalizeTitle(alias), document.title, document.relPath);
      }
    }
    const aliasToPath = new Map<string, string>();
    for (const row of runtimeRecordArray(raw.prepare("SELECT alias, path FROM memory_aliases").all(), "memory_aliases rows")) {
      aliasToPath.set(requiredStringField(row, "alias", "memory alias"), requiredStringField(row, "path", "memory alias"));
    }
    for (const document of parsed) {
      for (const link of document.links) {
        const resolved = aliasToPath.get(normalizeTitle(link.target)) ?? null;
        raw.prepare("INSERT INTO memory_links (from_path, to_title, to_path, line) VALUES (?, ?, ?, ?)")
          .run(document.relPath, link.target, resolved, link.line);
      }
    }

    return { indexed, removed, unchanged, documents: parsed.length };
  });
}
