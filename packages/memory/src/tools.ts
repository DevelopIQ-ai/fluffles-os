import fs from "node:fs";
import path from "node:path";
import { LedgerDb } from "@fluffles/storage";
import { resolveMemoryPaths, type MemoryPaths } from "./paths";
import { MEMORY_MIGRATIONS, MEMORY_SCHEMA } from "./index/schema";
import { indexMemory, type IndexResult } from "./index/indexer";
import { searchMemory, unresolvedLinks, type SearchFilters, type SearchHit, type UnresolvedLink } from "./index/search";
import { appendToDailyNote, writeEditableFile } from "./notes";
import { getMemoryDocument, generateWikiIndex, type WikiPage } from "./wiki";
import { buildContextBlock } from "./context";
import { runSweep, type SweepResult } from "./promote";

/**
 * The memory tool surface: search, get, write, plus the maintenance verbs the
 * CLI exposes. One instance owns one LedgerDb over the derived index.
 */
export class MemoryStore {
  readonly paths: MemoryPaths;
  private readonly db: LedgerDb;
  private readonly now: () => Date;
  private readonly indexFilePath: string;

  constructor(options: { paths?: MemoryPaths; dbPath?: string; now?: () => Date } = {}) {
    this.paths = options.paths ?? resolveMemoryPaths();
    this.now = options.now ?? (() => new Date());
    const filePath = options.dbPath ?? this.paths.indexFile;
    ensureMemoryLayout(this.paths);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new LedgerDb({
      filePath,
      schema: MEMORY_SCHEMA,
      migrations: MEMORY_MIGRATIONS
    });
    this.db.ensureDb();
    enforceIndexPermissions(filePath);
    this.indexFilePath = filePath;
  }

  close(): void {
    this.db.close();
    enforceIndexPermissions(this.indexFilePath);
  }

  async index(): Promise<IndexResult & { wikiIndex: string }> {
    const result = await indexMemory(this.db, this.paths, this.now());
    const wikiIndex = generateWikiIndex(this.db, this.paths, this.now());
    return { ...result, wikiIndex };
  }

  search(query: string, filters?: SearchFilters, limit?: number): SearchHit[] {
    return searchMemory(this.db, query, filters, limit);
  }

  get(pathOrTitle: string, lineStart?: number, lineEnd?: number): WikiPage | null {
    return getMemoryDocument(this.db, this.paths, pathOrTitle, lineStart, lineEnd);
  }

  /** Append to today's note, or rewrite MEMORY.md or people.md. */
  write(target: "note" | "MEMORY.md" | "people.md", content: string): string {
    if (target === "note") return appendToDailyNote(this.paths, content, { now: this.now() });
    return writeEditableFile(this.paths, target, content, this.now());
  }

  context(): string {
    return buildContextBlock(this.paths, this.now());
  }

  async promote(): Promise<SweepResult> {
    await indexMemory(this.db, this.paths, this.now());
    const result = await runSweep(this.db, this.paths, this.now());
    await indexMemory(this.db, this.paths, this.now());
    generateWikiIndex(this.db, this.paths, this.now());
    return result;
  }

  unresolvedLinks(): UnresolvedLink[] {
    return unresolvedLinks(this.db);
  }

  assertDurability(): void {
    this.db.assertAuthoritativeDurability();
  }
}

/**
 * Runtime memory files are excluded from the source deployment, so a fresh
 * install starts empty: create the directories and durable file stubs here.
 */
function ensureMemoryLayout(paths: MemoryPaths): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.wikiDir, { recursive: true });
  if (!fs.existsSync(paths.memoryFile)) {
    fs.writeFileSync(
      paths.memoryFile,
      "# MEMORY\n\nDurable facts and standing decisions, loaded at the start of every session.\nMaintained by the nightly sweep and direct edits. Keep it small: only facts\nneeded in most sessions belong here.\n"
    );
  }
  if (!fs.existsSync(paths.peopleFile)) {
    fs.writeFileSync(
      paths.peopleFile,
      "# people\n\nPeople, contact conventions, and preferences, loaded at the start of every\nsession.\n"
    );
  }
}

/**
 * The index and its WAL sidecars hold memory text: keep every file that
 * exists at mode 600. The -wal and -shm files appear and disappear with use,
 * so this runs at open and close rather than once.
 */
function enforceIndexPermissions(filePath: string): void {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    fs.chmodSync(candidate, 0o600);
  }
}
