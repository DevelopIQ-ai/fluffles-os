import fs from "node:fs";
import path from "node:path";
import { parseAutomationSpec, type SpecIssue } from "./spec";
import { expandPlaceholders } from "./template";
import type { AutomationSpec } from "./types";

export const SPEC_FILENAME = "automation.json";

export type LoadedAutomation = {
  spec: AutomationSpec;
  dir: string;
  specPath: string;
};

export type RegistryLoad = {
  automations: readonly LoadedAutomation[];
  failures: readonly { id: string; specPath: string; issues: readonly SpecIssue[] }[];
};

export type RegistryPaths = {
  /** Directory holding one subdirectory per automation. */
  root: string;
  /** Directory for runtime state, logs, and the database. */
  stateDir: string;
};

export function automationStateDir(paths: RegistryPaths, id: string): string {
  return path.join(paths.stateDir, "automations", id);
}

function placeholders(paths: RegistryPaths, id: string, dir: string): Record<string, string> {
  return {
    ROOT: path.dirname(paths.root),
    REGISTRY_DIR: paths.root,
    AUTOMATION_DIR: dir,
    STATE_DIR: paths.stateDir,
    AUTOMATION_STATE_DIR: automationStateDir(paths, id)
  };
}

/** Reads and validates every spec under the registry root. */
export function loadRegistry(paths: RegistryPaths): RegistryLoad {
  const automations: LoadedAutomation[] = [];
  const failures: { id: string; specPath: string; issues: readonly SpecIssue[] }[] = [];
  if (!fs.existsSync(paths.root)) return { automations, failures };

  const entries = fs.readdirSync(paths.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(paths.root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, SPEC_FILENAME)))
    .sort();

  for (const dir of entries) {
    const specPath = path.join(dir, SPEC_FILENAME);
    const fallbackId = path.basename(dir);
    const expanded = expandPlaceholders(fs.readFileSync(specPath, "utf8"), placeholders(paths, fallbackId, dir));
    let document: unknown;
    try {
      document = JSON.parse(expanded);
    } catch (error) {
      failures.push({
        id: fallbackId,
        specPath,
        issues: [{ path: "", message: error instanceof Error ? error.message : String(error) }]
      });
      continue;
    }
    const parsed = parseAutomationSpec(document, fallbackId);
    if (!parsed.ok) {
      failures.push({ id: parsed.id, specPath, issues: parsed.issues });
      continue;
    }
    if (parsed.spec.id !== fallbackId) {
      failures.push({
        id: parsed.spec.id,
        specPath,
        issues: [{ path: "id", message: `id "${parsed.spec.id}" must match directory name "${fallbackId}"` }]
      });
      continue;
    }
    automations.push({ spec: parsed.spec, dir, specPath });
  }
  return { automations, failures };
}
