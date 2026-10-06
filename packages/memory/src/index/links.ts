/** `[[double bracket]]` links. Targets resolve through the alias table, case-insensitively. */
const LINK_PATTERN = /\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]*)?\]\]/g;

export interface ExtractedLink {
  target: string;
  line: number;
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

export function slugForTitle(title: string): string {
  const slug = normalizeTitle(title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function extractLinks(text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    LINK_PATTERN.lastIndex = 0;
    for (let match = LINK_PATTERN.exec(line); match; match = LINK_PATTERN.exec(line)) {
      const target = match[1]?.trim();
      if (target) links.push({ target, line: i + 1 });
    }
  }
  return links;
}
