import assert from "node:assert/strict";
import test from "node:test";
import { ProductionTokenCounter, utf8TokenUpperBound } from "../src/context-budget-counter";

test("conservative token counting safely covers English, code, JSON, Unicode, URLs, and mixed languages", () => {
  const counter = new ProductionTokenCounter();
  const samples = [
    "A short English sentence with punctuation.",
    "```ts\nconst payload = await fetch(url, { headers: { authorization: token } });\n```",
    JSON.stringify({ nested: { array: [true, false, null], value: "quoted value" } }, null, 2),
    "こんにちは世界 👩🏽‍💻 مرحبا नमस्ते",
    "https://example.com/a/very/long/path?utm_source=fluffles&redirect=https%3A%2F%2Fexample.org%2Fdeep%2Flink%3Fq%3Dvalue",
    "English 中文 العربية हिन्दी русский 日本語 with emoji 🚀"
  ];

  for (const sample of samples) {
    assert.equal(counter.count(sample), Buffer.byteLength(sample, "utf8"));
    assert.equal(counter.count(sample), utf8TokenUpperBound(sample));
    assert.ok(counter.count(sample) >= Math.ceil(sample.length / 4));
    const truncated = counter.truncate(sample, Math.max(1, Math.floor(counter.count(sample) / 2)));
    assert.ok(counter.count(truncated) <= Math.max(1, Math.floor(counter.count(sample) / 2)));
    assert.equal(truncated.includes("\uFFFD"), false, "truncation must preserve Unicode scalar boundaries");
  }
});

test("configured model tokenizers are authoritative when supplied", () => {
  let calls = 0;
  const counter = new ProductionTokenCounter({
    model: "test-model",
    tokenizer: {
      countTokens: (text) => {
        calls += 1;
        return text === "hello" ? 2 : text.length;
      }
    }
  });

  assert.equal(counter.strategy, "model");
  assert.equal(counter.count("hello"), 2);
  assert.equal(counter.truncate("abcdef", 3), "abc");
  assert.ok(calls > 1);
});

test("invalid tokenizer output fails before the runtime can submit a prompt", () => {
  const counter = new ProductionTokenCounter({ tokenizer: { countTokens: () => Number.NaN } });
  assert.throws(() => counter.count("unsafe"), /invalid token count/);
});
