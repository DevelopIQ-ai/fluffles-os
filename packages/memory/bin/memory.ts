#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { resolveMemoryPaths, isDailyNoteName } from "../src/paths";
import { MemoryStore } from "../src/tools";
import type { SearchFilters } from "../src/index/search";

const USAGE = `usage: memory <command> [args]

  context                         print the always-loaded context block
  note <text>                     append to today's daily note
  write <MEMORY.md|people.md>     rewrite a durable file from stdin
  search <query> [--tag k=v ...] [--kind note|wiki|durable] [--from DATE] [--to DATE] [--limit N]
                                  --tag matches top-level front matter keys,
                                  e.g. --tag kind=person for "kind: person"
  get <path-or-title> [start] [end]
  index                           reindex changed files, regenerate wiki/index.md
  promote                         run the nightly sweep for unswept past dates
  migrate <summaries-dir>         copy legacy daily summaries into daily notes
  doctor                          index health, durability, unresolved links
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 64);
  }
  const store = new MemoryStore();
  try {
    switch (command) {
      case "context": {
        process.stdout.write(store.context());
        return;
      }
      case "note": {
        const text = args.join(" ").trim() || fs.readFileSync(0, "utf8");
        const notePath = store.write("note", text);
        emit({ ok: true, path: notePath });
        return;
      }
      case "write": {
        const target = args[0];
        if (target !== "MEMORY.md" && target !== "people.md") fail("write target must be MEMORY.md or people.md");
        const written = store.write(target, fs.readFileSync(0, "utf8"));
        emit({ ok: true, path: written });
        return;
      }
      case "search": {
        const { query, filters, limit } = parseSearchArgs(args);
        await store.index();
        const started = process.hrtime.bigint();
        const hits = store.search(query, filters, limit);
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        emit({ ok: true, durationMs: Math.round(durationMs * 100) / 100, hits });
        return;
      }
      case "get": {
        const target = args[0] ?? fail("get needs a path or title");
        const lineStart = args[1] ? Number(args[1]) : undefined;
        const lineEnd = args[2] ? Number(args[2]) : undefined;
        await store.index();
        const document = store.get(target, lineStart, lineEnd);
        if (!document) fail(`not found: ${target}`);
        emit({ ok: true, ...document });
        return;
      }
      case "index": {
        const result = await store.index();
        emit({ ok: true, indexed: result.indexed, removed: result.removed, unchanged: result.unchanged, documents: result.documents });
        return;
      }
      case "promote": {
        const result = await store.promote();
        emit({ ok: true, sweptDates: result.sweptDates, actions: result.actions });
        return;
      }
      case "migrate": {
        const source = args[0] ?? fail("migrate needs the legacy summaries directory");
        emit({ ok: true, ...migrateSummaries(source) });
        return;
      }
      case "doctor": {
        store.assertDurability();
        const result = await store.index();
        const unresolved = store.unresolvedLinks();
        emit({
          ok: true,
          documents: result.documents,
          index: store.paths.indexFile,
          unresolvedLinks: unresolved
        });
        return;
      }
      default:
        fail(USAGE.trim());
    }
  } finally {
    store.close();
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseSearchArgs(args: string[]): { query: string; filters: SearchFilters; limit: number } {
  const filters: SearchFilters = {};
  const tags: Record<string, string> = {};
  const queryParts: string[] = [];
  let limit = 10;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--tag") {
      const pair = args[++i] ?? fail("--tag needs key=value");
      const eq = pair.indexOf("=");
      if (eq < 1) fail("--tag needs key=value");
      tags[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--kind") {
      const kind = args[++i];
      if (kind !== "note" && kind !== "wiki" && kind !== "durable") fail("--kind must be note, wiki, or durable");
      filters.kind = kind;
    } else if (arg === "--from") {
      filters.dateFrom = args[++i] ?? fail("--from needs a date");
    } else if (arg === "--to") {
      filters.dateTo = args[++i] ?? fail("--to needs a date");
    } else if (arg === "--limit") {
      limit = Number(args[++i] ?? fail("--limit needs a number"));
      if (!Number.isFinite(limit) || limit < 1) fail("--limit needs a positive number");
    } else {
      queryParts.push(arg);
    }
  }
  if (Object.keys(tags).length) filters.tags = tags;
  const query = queryParts.join(" ").trim();
  if (!query) fail("search needs a query");
  return { query, filters, limit };
}

/** Copy legacy `memory/summaries/daily/*.md` into `memory/YYYY-MM-DD.md` without overwriting. */
function migrateSummaries(sourceDir: string): { copied: string[]; skipped: string[] } {
  const paths = resolveMemoryPaths();
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(sourceDir)) return { copied, skipped };
  fs.mkdirSync(paths.root, { recursive: true });
  for (const name of fs.readdirSync(sourceDir).sort()) {
    if (!isDailyNoteName(name)) continue;
    const target = path.join(paths.root, name);
    if (fs.existsSync(target)) {
      skipped.push(name);
      continue;
    }
    fs.copyFileSync(path.join(sourceDir, name), target);
    copied.push(name);
  }
  return { copied, skipped };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
