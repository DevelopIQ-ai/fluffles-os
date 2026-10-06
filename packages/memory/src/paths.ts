import os from "node:os";
import path from "node:path";

export interface MemoryPaths {
  /** Directory holding MEMORY.md, people.md, daily notes, wiki/, quarantine/. */
  root: string;
  /** Directory holding the derived index database. */
  stateDir: string;
  memoryFile: string;
  peopleFile: string;
  promotionsFile: string;
  wikiDir: string;
  wikiIndexFile: string;
  quarantineDir: string;
  indexFile: string;
}

export interface ResolvePathsOptions {
  root?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

export function resolveMemoryPaths(options: ResolvePathsOptions = {}): MemoryPaths {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? os.homedir)();
  const root = options.root ?? env.MEMORY_ROOT ?? path.join(home, "memory");
  const stateDir = options.stateDir ?? env.MEMORY_STATE_DIR ?? path.join(home, "state", "memory");
  return {
    root,
    stateDir,
    memoryFile: path.join(root, "MEMORY.md"),
    peopleFile: path.join(root, "people.md"),
    promotionsFile: path.join(root, "PROMOTIONS.md"),
    wikiDir: path.join(root, "wiki"),
    wikiIndexFile: path.join(root, "wiki", "index.md"),
    quarantineDir: path.join(root, "quarantine"),
    indexFile: path.join(stateDir, "index.sqlite")
  };
}

const dailyNotePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;

export function isDailyNoteName(name: string): boolean {
  return dailyNotePattern.test(name);
}

export function dailyNoteDate(name: string): string | null {
  const match = dailyNotePattern.exec(name);
  return match?.[1] ?? null;
}

export function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
