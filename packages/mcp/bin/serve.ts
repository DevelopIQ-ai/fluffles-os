#!/usr/bin/env node
import { loadManifest } from "../src/manifest";
import { serve } from "../src/server";

// Usage: serve.ts <manifest.json>
// Fronts one local CLI as an MCP server over stdio, per its manifest.

const manifestPath = process.argv[2];
if (!manifestPath) {
  process.stderr.write("usage: serve.ts <manifest.json>\n");
  process.exit(64);
}

serve(loadManifest(manifestPath));
