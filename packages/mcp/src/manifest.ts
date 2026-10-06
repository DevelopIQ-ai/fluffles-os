import fs from "node:fs";
import os from "node:os";

// A tool manifest turns one local CLI into an MCP server. The manifest is
// data, not code: the generic server in server.ts reads it and exposes each
// declared operation as an MCP tool. Argument values are substituted into
// the command template by name; nothing is ever passed through a shell.

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ManifestTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  // Command template. Each entry is either a literal string, "{param}" for a
  // required substitution, or "{param?}" for an entry dropped when the
  // parameter is absent. A trailing "{param...}" splits a string parameter
  // on whitespace into multiple arguments.
  command: string[];
  // Argument prefixes that are refused outright, checked against the rendered
  // arguments (everything after the binary). Guards credentialed CLIs against
  // calls that print the injected credential back out, e.g. [["auth"]].
  deny?: string[][];
  timeoutMs?: number;
};

export type ServerManifest = {
  name: string;
  description?: string;
  tools: ManifestTool[];
  // Health probe command; exit 0 means healthy. When absent, the registry
  // falls back to checking that the wrapper exists and is executable.
  health?: string[];
  // A required tool must be healthy for a deployment to be admitted.
  required?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  // The Infisical path whose secrets the tool's commands run with. The
  // manifest declares the path; injection happens in exactly one place,
  // packages/auth/bin/with-tool-secrets, which reads it from here.
  secrets?: { path: string };
};

const SECRET_PATH = /^\/[a-z0-9][a-z0-9/_-]*$/;

const IDENTIFIER = /^[a-z][a-z0-9_.-]*$/;

export function validateManifest(value: unknown): ServerManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== "string" || !IDENTIFIER.test(manifest.name)) {
    throw new Error("manifest.name must be a lowercase identifier");
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    throw new Error("manifest.tools must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const entry of manifest.tools) {
    validateTool(entry);
    const tool = entry as ManifestTool;
    if (seen.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  if (manifest.health !== undefined) {
    if (!Array.isArray(manifest.health) || manifest.health.length === 0 || manifest.health.some((item) => typeof item !== "string")) {
      throw new Error("manifest.health must be a non-empty array of strings");
    }
  }
  if (manifest.required !== undefined && typeof manifest.required !== "boolean") {
    throw new Error("manifest.required must be a boolean");
  }
  if (manifest.env !== undefined) {
    const env = manifest.env as Record<string, unknown>;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new Error("manifest.env must be an object of strings");
    }
    for (const [key, val] of Object.entries(env)) {
      if (typeof val !== "string") {
        throw new Error(`manifest.env.${key} must be a string`);
      }
    }
  }
  if (manifest.cwd !== undefined && typeof manifest.cwd !== "string") {
    throw new Error("manifest.cwd must be a string");
  }
  if (manifest.secrets !== undefined) {
    const secrets = manifest.secrets as Record<string, unknown>;
    if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
      throw new Error("manifest.secrets must be an object");
    }
    if (typeof secrets.path !== "string" || !SECRET_PATH.test(secrets.path)) {
      throw new Error("manifest.secrets.path must be an absolute lowercase Infisical path");
    }
    const extra = Object.keys(secrets).filter((key) => key !== "path");
    if (extra.length > 0) {
      throw new Error(`manifest.secrets has unknown keys: ${extra.join(", ")}`);
    }
  }
  return manifest as unknown as ServerManifest;
}

function validateTool(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new Error("tool must be an object");
  }
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || !IDENTIFIER.test(tool.name)) {
    throw new Error("tool.name must be a lowercase identifier");
  }
  if (typeof tool.description !== "string" || tool.description.length === 0) {
    throw new Error(`tool ${tool.name}: description is required`);
  }
  const schema = tool.inputSchema as JsonSchema | undefined;
  if (typeof schema !== "object" || schema === null || schema.type !== "object") {
    throw new Error(`tool ${tool.name}: inputSchema must be an object schema`);
  }
  if (typeof schema.properties !== "object" || schema.properties === null) {
    throw new Error(`tool ${tool.name}: inputSchema.properties is required`);
  }
  if (!Array.isArray(tool.command) || tool.command.length === 0 || tool.command.some((item) => typeof item !== "string")) {
    throw new Error(`tool ${tool.name}: command must be a non-empty array of strings`);
  }
  const params = new Set(Object.keys(schema.properties));
  for (const segment of tool.command as string[]) {
    for (const token of segment.split(" ")) {
      const reference = parseReference(token);
      if (reference !== null && !params.has(reference.name)) {
        throw new Error(`tool ${tool.name}: command references unknown parameter {${reference.name}}`);
      }
    }
  }
  if (tool.deny !== undefined) {
    const deny = tool.deny;
    const valid =
      Array.isArray(deny) &&
      deny.length > 0 &&
      deny.every((prefix) => Array.isArray(prefix) && prefix.length > 0 && prefix.every((item) => typeof item === "string"));
    if (!valid) {
      throw new Error(`tool ${tool.name}: deny must be a non-empty array of non-empty string arrays`);
    }
  }
  if (tool.timeoutMs !== undefined && (typeof tool.timeoutMs !== "number" || tool.timeoutMs <= 0)) {
    throw new Error(`tool ${tool.name}: timeoutMs must be a positive number`);
  }
}

export type Reference = { name: string; optional: boolean; variadic: boolean };

export function parseReference(segment: string): Reference | null {
  const match = /^\{([a-zA-Z][a-zA-Z0-9_]*)(\?|\.\.\.)?\}$/.exec(segment);
  if (match?.[1] === undefined) {
    return null;
  }
  return {
    name: match[1],
    optional: match[2] === "?",
    variadic: match[2] === "..."
  };
}

// A segment containing spaces is a group: it renders to one token per part,
// and the whole group is dropped when any optional reference in it has no
// value. That is how "--limit {limit?}" omits the flag with its value.
export function deniedPrefix(tool: ManifestTool, rendered: readonly string[]): string[] | null {
  const commandArgs = rendered.slice(1);
  for (const prefix of tool.deny ?? []) {
    if (prefix.length <= commandArgs.length && prefix.every((item, index) => item === commandArgs[index])) {
      return prefix;
    }
  }
  return null;
}

export function renderCommand(tool: ManifestTool, args: Record<string, unknown>): string[] {
  const rendered: string[] = [];
  for (const segment of tool.command) {
    const parts = segment.split(" ");
    const group: string[] = [];
    let dropGroup = false;
    for (const part of parts) {
      const reference = parseReference(part);
      if (reference === null) {
        group.push(part);
        continue;
      }
      const value = args[reference.name];
      if (value === undefined || value === null) {
        if (reference.optional) {
          dropGroup = true;
          break;
        }
        throw new Error(`missing required argument: ${reference.name}`);
      }
      if (reference.variadic && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
            throw new Error(`argument ${reference.name} must be an array of scalars`);
          }
          group.push(String(item));
        }
        continue;
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`argument ${reference.name} must be a scalar`);
      }
      const text = String(value);
      if (reference.variadic) {
        for (const piece of text.split(/\s+/).filter((item) => item.length > 0)) {
          group.push(piece);
        }
        continue;
      }
      group.push(text);
    }
    if (!dropGroup) {
      rendered.push(...group);
    }
  }
  return rendered;
}

// Manifests may reference the harness home as {{HOME}}, so one file serves
// every installed harness.
export function loadManifest(filePath: string, home = process.env.HOME ?? os.homedir()): ServerManifest {
  const text = fs.readFileSync(filePath, "utf8").replaceAll("{{HOME}}", home);
  return validateManifest(JSON.parse(text));
}
