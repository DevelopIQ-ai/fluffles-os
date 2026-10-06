import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest } from "../../mcp/src/manifest";

// The callable-tool inventory is derived from the MCP manifests in
// tools/mcp/manifests: one registry entry per manifest, nothing hand-kept
// here. The only other classification input is the harness charter
// (tools/capabilities/harness.json), the closed list of executable surfaces
// that are deliberately not callable tools.

export type ToolStatus = "healthy" | "for_repair" | "disabled";

export interface ToolDefinition {
  /** The manifest name; also the health-store and repair-task key. */
  name: string;
  description: string;
  manifestPath: string;
  /** The shared executable wrapper behind the manifest's tools. */
  command: string;
  /** The MCP tool names the manifest declares. */
  toolNames: string[];
  /**
   * Canonical health probe argv. When null the registry falls back to
   * checking that the wrapper exists and is executable.
   */
  health: string[] | null;
  /** A required tool must be healthy for a deployment to be admitted. */
  required: boolean;
  /** Content hash of the raw manifest text; any manifest edit changes it. */
  manifestHash: string;
}

export interface ToolState extends ToolDefinition {
  status: ToolStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  repairTaskId: string | null;
}

export interface HarnessCharter {
  version: 1;
  /** tools/ directories owned by the harness rather than the tool layer. */
  tools: string[];
  /**
   * Executable surfaces (repo-relative) owned by the harness or plumbing.
   * Includes the entries derived from commandRoots.
   */
  commands: string[];
  /**
   * Directories (repo-relative) whose directly contained executables are all
   * harness plumbing; their entries are derived, never retyped.
   */
  commandRoots: string[];
}

export interface ToolRegistry {
  tools: ToolDefinition[];
  harness: HarnessCharter;
}

export interface LoadToolRegistryOptions {
  manifestsDir: string;
  harnessPath: string;
  home?: string;
}

export function loadToolRegistry(options: LoadToolRegistryOptions): ToolRegistry {
  const home = options.home ?? process.env.HOME ?? os.homedir();
  const names = fs.readdirSync(options.manifestsDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  if (names.length === 0) throw new Error(`no MCP manifests found in ${options.manifestsDir}`);
  const tools = names.map((entry) => {
    const manifestPath = path.join(options.manifestsDir, entry);
    const manifest = loadManifest(manifestPath, home);
    const manifestHash = crypto.createHash("sha256").update(fs.readFileSync(manifestPath, "utf8")).digest("hex");
    if (`${manifest.name}.json` !== entry) {
      throw new Error(`${manifestPath}: manifest name ${manifest.name} does not match its file name`);
    }
    const command = manifest.tools[0]?.command[0];
    if (command === undefined) throw new Error(`${manifestPath}: manifest declares no tool command`);
    return {
      name: manifest.name,
      description: manifest.description ?? manifest.name,
      manifestPath,
      command,
      toolNames: manifest.tools.map((tool) => tool.name),
      health: manifest.health ?? null,
      required: manifest.required ?? false,
      manifestHash
    };
  });
  return { tools, harness: loadHarnessCharter(options.harnessPath) };
}

export function loadHarnessCharter(filePath: string): HarnessCharter {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (value.version !== 1) throw new Error(`${filePath} version must be 1`);
  const root = path.resolve(path.dirname(filePath), "..", "..");
  const declared = stringList(value.commands, `${filePath}.commands`);
  const commandRoots = value.commandRoots === undefined ? [] : stringList(value.commandRoots, `${filePath}.commandRoots`);
  const derived = commandRoots.flatMap((relative) => {
    // A root may be absent on a deployed home (the classification tests run
    // against the source tree, where every root exists); like the explicit
    // commands above, absent surfaces simply derive nothing.
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (fs.statSync(path.join(directory, entry.name)).mode & 0o111) !== 0)
      .map((entry) => `${relative}/${entry.name}`)
      .sort();
  });
  return {
    version: 1,
    tools: stringList(value.tools, `${filePath}.tools`),
    commands: [...declared, ...derived],
    commandRoots
  };
}

/** Returns source-owned tool directories that are neither manifests nor harness organs. */
export function unclassifiedTools(registry: ToolRegistry, toolNames: readonly string[]): string[] {
  const classified = new Set([
    ...registry.tools.map((tool) => tool.name),
    ...registry.harness.tools
  ]);
  return [...new Set(toolNames)].filter((tool) => !classified.has(tool)).sort();
}

/** Returns executable commands that are neither manifest wrappers nor charted harness surfaces. */
export function unclassifiedCommands(registry: ToolRegistry, commandNames: readonly string[]): string[] {
  const classified = new Set([
    ...registry.tools.map((tool) => basename(tool.command)),
    ...registry.harness.commands.map(basename)
  ]);
  return [...new Set(commandNames)].filter((command) => !classified.has(command)).sort();
}

/** A stable content hash of one tool definition; any manifest change invalidates cached health. */
export function toolDefinitionFingerprint(tool: ToolDefinition): string {
  // The manifest path varies by home, so the fingerprint hashes the
  // definition content, not where it was read from.
  const { manifestPath: _manifestPath, ...definition } = tool;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

function basename(value: string): string {
  return value.split("/").pop() ?? value;
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${context}[${index}] must be a non-empty string`);
    if (seen.has(item)) throw new Error(`${context} has duplicate entry ${item}`);
    seen.add(item);
    return item;
  });
}
