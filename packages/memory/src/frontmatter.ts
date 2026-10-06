/**
 * Minimal front matter: a leading `---` block of `key: scalar` and
 * `key: [a, b]` lines. Anything else in the block is preserved verbatim on
 * serialize but ignored for filtering.
 */
export interface FrontMatter {
  fields: Record<string, string | string[]>;
  /** Line count consumed from the top of the file, including both fences. */
  lineCount: number;
}

export function parseFrontMatter(text: string): FrontMatter {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, lineCount: 0 };
  const fields: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") return { fields, lineCount: i + 1 };
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = (match[2] ?? "").trim();
    if (!key) continue;
    fields[key] = parseScalarOrList(raw);
  }
  // No closing fence: not front matter.
  return { fields: {}, lineCount: 0 };
}

function parseScalarOrList(raw: string): string | string[] {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item.length > 0);
  }
  return stripQuotes(raw);
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function serializeFrontMatter(fields: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function frontMatterList(fields: Record<string, string | string[]>, key: string): string[] {
  const value = fields[key];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
