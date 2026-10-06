export class MemorySafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySafetyError";
  }
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]{20,}/gi,
  /xapp-[A-Za-z0-9-]{20,}/gi,
  /gh[opsu]_[A-Za-z0-9_]{30,}/gi,
  /github_pat_[A-Za-z0-9_]{80,}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gi,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?!\[redacted\]@)[^\s@/]+@/gi
];

const CREDENTIAL_KEY = String.raw`(?:authorization|proxy[-_]?authorization|x[-_]?api[-_]?key|api[-_]?key|api[-_]?token|oauth(?:[-_ ]?(?:access|refresh))?[-_ ]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|auth(?:entication|orization)?|tokens?|cookies?|set[-_]?cookie|session[-_ ]?(?:token|cookie|secret)|passwords?|passwd|credentials?|secrets?|recovery(?:[-_ ]?(?:code|material))?)`;
const CREDENTIAL_VALUE = String.raw`(?:\\?"(?:\\.|[^"\\\r\n])*\\?"|\\?'(?:\\.|[^'\\\r\n])*\\?'|[^\r\n,}]*)`;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`\b(${CREDENTIAL_KEY})(\\?["'])?(\s*[:=]\s*)(${CREDENTIAL_VALUE})`,
  "gi"
);
const CREDENTIAL_SCHEME = /\b(?:basic|bearer|token|api[-_]?key)\s+[A-Za-z0-9._~+\/=:-]+/gi;
const SENSITIVE_KEY_PARTS = new Set([
  "access", "api", "apikey", "auth", "authentication", "authorization", "bearer", "client", "cookie", "cookies", "credential", "credentials", "key", "oauth", "password", "passwords", "passwd", "private", "recovery", "refresh", "secret", "secrets", "token", "tokens"
]);
const HIGH_ENTROPY_TOKEN = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;
const BASE64_CANDIDATE = /\b[A-Za-z0-9+/]{8,}={0,2}\b/g;

function patternMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function decodedBase64(value: string): string | null {
  if (value.length % 4 === 1) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (!/^[\x20-\x7E]+$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function decodedBase64ContainsSensitiveMaterial(value: string): boolean {
  const decoded = decodedBase64(value);
  if (decoded == null) return false;
  if (/^[^:\s]{1,128}:[^\s]{0,256}$/.test(decoded)) return true;
  if (containsUnredactedCredentialLine(decoded) || patternMatches(CREDENTIAL_SCHEME, decoded)) return true;
  if (SECRET_VALUE_PATTERNS.some((pattern) => patternMatches(pattern, decoded))) return true;
  HIGH_ENTROPY_TOKEN.lastIndex = 0;
  return HIGH_ENTROPY_TOKEN.test(decoded);
}

function containsSensitiveBase64(text: string): boolean {
  BASE64_CANDIDATE.lastIndex = 0;
  return [...text.matchAll(BASE64_CANDIDATE)].some((match) => decodedBase64ContainsSensitiveMaterial(match[0]));
}

function containsUnredactedCredentialLine(text: string): boolean {
  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    if (credentialValue(match[4]).value !== "[redacted]") return true;
  }
  return false;
}

function credentialValue(raw: string): { opening: string; closing: string; trailingWhitespace: string; value: string } {
  const trimmed = raw.trimEnd();
  const trailingWhitespace = raw.slice(trimmed.length);
  for (const quote of ['\\"', "\\'", '"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote) && trimmed.length >= quote.length * 2) {
      return {
        opening: quote,
        closing: quote,
        trailingWhitespace,
        value: trimmed.slice(quote.length, -quote.length).trim()
      };
    }
  }
  return { opening: "", closing: "", trailingWhitespace, value: trimmed.trim() };
}

export function containsSensitiveMaterial(value: unknown): boolean {
  const text = String(value ?? "");
  const matchedPattern = [CREDENTIAL_SCHEME, ...SECRET_VALUE_PATTERNS].some((pattern) => patternMatches(pattern, text));
  HIGH_ENTROPY_TOKEN.lastIndex = 0;
  return containsUnredactedCredentialLine(text) || matchedPattern || HIGH_ENTROPY_TOKEN.test(text) || containsSensitiveBase64(text);
}

export function assertSafeMemoryText(value: unknown, label: string): void {
  if (containsSensitiveMaterial(value)) {
    throw new MemorySafetyError(`${label} contains sensitive material`);
  }
}

export function redactSensitiveText(value: string, redactHighEntropy = false): string {
  let text = value.replace(CREDENTIAL_ASSIGNMENT, (_match, key: string, keyQuote: string | undefined, separator: string, rawValue: string) => {
    const { opening, closing, trailingWhitespace } = credentialValue(rawValue);
    return `${key}${keyQuote || ""}${separator}${opening}[redacted]${closing}${trailingWhitespace}`;
  })
    .replace(CREDENTIAL_SCHEME, (match) => `${match.split(/\s+/, 1)[0]} [redacted]`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (_match, capture: unknown) => typeof capture === "string" ? `${capture}[redacted]@` : "[redacted]");
  }
  text = text.replace(BASE64_CANDIDATE, (match) => decodedBase64ContainsSensitiveMaterial(match) ? "[redacted]" : match);
  if (redactHighEntropy) text = text.replace(HIGH_ENTROPY_TOKEN, "[redacted]");
  return text;
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => SENSITIVE_KEY_PARTS.has(part));
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value, true);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redactSensitiveValue(child)
    ]));
  }
  return value;
}
