import { LedgerDb, nullableStringField, requiredNumberField, requiredStringField, runtimeRecordArray } from "@fluffles/storage";

export interface SearchFilters {
  /** Front matter filters: each entry requires `key: value` on the document. */
  tags?: Record<string, string>;
  kind?: "note" | "wiki" | "durable";
  dateFrom?: string;
  dateTo?: string;
}

export interface SearchHit {
  path: string;
  kind: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  rank: number;
}

/** Escape a user query into FTS5 string syntax: each term quoted, joined with implicit AND. */
function ftsQuery(query: string): string {
  const terms = query.match(/"[^"]+"|\S+/g) ?? [];
  return terms
    .map((term) => {
      const bare = term.replace(/^"|"$/g, "").replace(/"/g, "");
      return bare ? `"${bare}"` : null;
    })
    .filter((term): term is string => term != null)
    .join(" ");
}

export function searchMemory(db: LedgerDb, query: string, filters: SearchFilters = {}, limit = 10): SearchHit[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const raw = db.ensureDb();
  const conditions: string[] = ["memory_fts MATCH ?"];
  const parameters: (string | number)[] = [match];
  for (const [key, value] of Object.entries(filters.tags ?? {})) {
    conditions.push("memory_fts.path IN (SELECT path FROM memory_tags WHERE key = ? AND value = ?)");
    parameters.push(key, value);
  }
  if (filters.kind) {
    conditions.push("memory_fts.kind = ?");
    parameters.push(filters.kind);
  }
  if (filters.dateFrom) {
    conditions.push("memory_fts.path IN (SELECT path FROM memory_documents WHERE date >= ?)");
    parameters.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push("memory_fts.path IN (SELECT path FROM memory_documents WHERE date <= ?)");
    parameters.push(filters.dateTo);
  }
  parameters.push(limit);
  const rows = raw.prepare(
    `SELECT path, kind, title, line_start, line_end, rank,
            snippet(memory_fts, 5, '[', ']', ' … ', 16) AS snip
     FROM memory_fts
     WHERE ${conditions.join(" AND ")}
     ORDER BY rank
     LIMIT ?`
  ).all(...parameters);
  return runtimeRecordArray(rows, "memory search rows").map((row) => ({
    path: requiredStringField(row, "path", "search hit"),
    kind: requiredStringField(row, "kind", "search hit"),
    title: requiredStringField(row, "title", "search hit"),
    lineStart: requiredNumberField(row, "line_start", "search hit"),
    lineEnd: requiredNumberField(row, "line_end", "search hit"),
    snippet: requiredStringField(row, "snip", "search hit"),
    rank: requiredNumberField(row, "rank", "search hit")
  }));
}

export interface ResolvedPage {
  path: string;
  title: string;
}

/** Resolve a wiki title or alias, case-insensitively, to its page path. */
export function resolveTitle(db: LedgerDb, titleOrAlias: string): ResolvedPage | null {
  const raw = db.ensureDb();
  const row = raw.prepare("SELECT title, path FROM memory_aliases WHERE alias = ?").get(titleOrAlias.trim().toLowerCase());
  if (!row) return null;
  const record = runtimeRecordArray([row], "memory alias row")[0];
  if (!record) return null;
  return {
    path: requiredStringField(record, "path", "memory alias"),
    title: requiredStringField(record, "title", "memory alias")
  };
}

export interface Backlink {
  fromPath: string;
  line: number;
}

export function backlinksFor(db: LedgerDb, pagePath: string): Backlink[] {
  const rows = db.ensureDb()
    .prepare("SELECT from_path, line FROM memory_links WHERE to_path = ? ORDER BY from_path, line")
    .all(pagePath);
  return runtimeRecordArray(rows, "memory backlink rows").map((row) => ({
    fromPath: requiredStringField(row, "from_path", "backlink"),
    line: requiredNumberField(row, "line", "backlink")
  }));
}

export interface UnresolvedLink {
  fromPath: string;
  target: string;
  line: number;
}

/** An unresolved link is not an error; it is a page that does not exist yet. */
export function unresolvedLinks(db: LedgerDb): UnresolvedLink[] {
  const rows = db.ensureDb()
    .prepare("SELECT from_path, to_title, line FROM memory_links WHERE to_path IS NULL ORDER BY from_path, line")
    .all();
  return runtimeRecordArray(rows, "memory unresolved link rows").map((row) => ({
    fromPath: requiredStringField(row, "from_path", "unresolved link"),
    target: requiredStringField(row, "to_title", "unresolved link"),
    line: requiredNumberField(row, "line", "unresolved link")
  }));
}

export interface IndexedPage {
  path: string;
  title: string;
  kind: string;
  date: string | null;
  tags: Record<string, string[]>;
}

export function listDocuments(db: LedgerDb, kind?: "note" | "wiki" | "durable"): IndexedPage[] {
  const raw = db.ensureDb();
  const rows = kind
    ? raw.prepare("SELECT path, title, kind, date FROM memory_documents WHERE kind = ? ORDER BY path").all(kind)
    : raw.prepare("SELECT path, title, kind, date FROM memory_documents ORDER BY path").all();
  const documents = runtimeRecordArray(rows, "memory document rows").map((row) => ({
    path: requiredStringField(row, "path", "memory document"),
    title: requiredStringField(row, "title", "memory document"),
    kind: requiredStringField(row, "kind", "memory document"),
    date: nullableStringField(row, "date", "memory document"),
    tags: {} as Record<string, string[]>
  }));
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const tagRows = raw.prepare("SELECT path, key, value FROM memory_tags ORDER BY path, key, value").all();
  for (const row of runtimeRecordArray(tagRows, "memory tag rows")) {
    const document = byPath.get(requiredStringField(row, "path", "memory tag"));
    if (!document) continue;
    const key = requiredStringField(row, "key", "memory tag");
    (document.tags[key] ??= []).push(requiredStringField(row, "value", "memory tag"));
  }
  return documents;
}
