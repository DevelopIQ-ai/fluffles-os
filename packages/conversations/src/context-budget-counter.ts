/**
 * Model token accounting used by ConversationRuntime.
 *
 * A configured tokenizer is authoritative for its model. When no tokenizer is
 * available, UTF-8 byte length is a deliberately conservative upper bound for
 * byte-pair tokenizers: every UTF-8 byte could be represented by one token.
 * This trades context utilization for the hard guarantee that the runtime will
 * not knowingly submit a prompt larger than its configured window.
 */
export interface ModelTokenizer {
  countTokens(text: string): number;
}

export interface TokenCounter {
  readonly strategy: "model" | "utf8-conservative";
  count(text: string): number;
  truncate(text: string, maxTokens: number): string;
}

export interface TokenCounterOptions {
  /** The model name is retained for diagnostics and tokenizer registration. */
  model?: string;
  /**
   * Supply the tokenizer for the configured model when one is available in the
   * deployment. The shared runtime uses it for every budget calculation.
   */
  tokenizer?: ModelTokenizer;
}

/** A production-safe counter with a model tokenizer when configured. */
export class ProductionTokenCounter implements TokenCounter {
  readonly strategy: "model" | "utf8-conservative";
  readonly model: string | null;
  private readonly tokenizer: ModelTokenizer | null;

  constructor(options: TokenCounterOptions = {}) {
    this.model = options.model?.trim() || null;
    this.tokenizer = options.tokenizer ?? null;
    this.strategy = this.tokenizer ? "model" : "utf8-conservative";
  }

  count(text: string): number {
    const normalized = String(text ?? "");
    if (!this.tokenizer) return utf8TokenUpperBound(normalized);
    const tokenCount = this.tokenizer.countTokens(normalized);
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
      throw new Error(`Tokenizer${this.model ? ` for ${this.model}` : ""} returned an invalid token count`);
    }
    return tokenCount;
  }

  truncate(text: string, maxTokens: number): string {
    const normalized = String(text ?? "");
    const budget = requireTokenBudget(maxTokens);
    if (budget === 0 || !normalized) return "";
    if (this.count(normalized) <= budget) return normalized;

    const codePoints = Array.from(normalized);
    let lower = 0;
    let upper = codePoints.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (this.count(codePoints.slice(0, middle).join("")) <= budget) lower = middle;
      else upper = middle - 1;
    }
    return codePoints.slice(0, lower).join("");
  }
}

/**
 * Safe fallback for deployments without a model tokenizer. This is intentionally
 * exported for persistence-only retention limits, but prompt budgeting remains
 * owned by ConversationRuntime through ProductionTokenCounter.
 */
export function utf8TokenUpperBound(text: string): number {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function requireTokenBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Token budget must be a non-negative safe integer");
  }
  return value;
}
