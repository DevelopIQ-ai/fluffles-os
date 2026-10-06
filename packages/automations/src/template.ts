import type { TemplateValue } from "./types";

const REFERENCE = /\{\{([^{}]+)\}\}/g;
const WHOLE_REFERENCE = /^\{\{([^{}]+)\}\}$/;

function readPath(context: unknown, expression: string): unknown {
  let current: unknown = context;
  for (const segment of expression.trim().split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** `a.b|c.d` reads the first path that resolves to something defined. */
function resolveExpression(context: unknown, expression: string): unknown {
  for (const candidate of expression.split("|")) {
    const value = readPath(context, candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Resolves `{{path}}` references against a context. A string that is exactly
 * one reference keeps the referenced value's type; references embedded in a
 * larger string are stringified.
 */
export function renderTemplate(value: TemplateValue, context: unknown): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_REFERENCE.exec(value);
    if (whole) return resolveExpression(context, whole[1] as string) ?? null;
    return value.replace(REFERENCE, (_match, expression: string) => {
      const resolved = resolveExpression(context, expression);
      if (resolved === undefined || resolved === null) return "";
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => renderTemplate(entry, context));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = renderTemplate(entry, context);
    return result;
  }
  return value;
}

/** Expands registry path placeholders in a spec document before it is parsed. */
export function expandPlaceholders(text: string, replacements: Readonly<Record<string, string>>): string {
  let expanded = text;
  for (const [key, replacement] of Object.entries(replacements)) {
    expanded = expanded.split(`{{${key}}}`).join(replacement);
  }
  return expanded;
}
