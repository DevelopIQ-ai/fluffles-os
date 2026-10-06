import assert from "node:assert/strict";
import test from "node:test";
import { parseBooleanEnv, parseCsvSet, parseNumberEnv, parseNullableStringEnv, parseStringEnv } from "../src/runtime-config";

test("runtime config parses strict booleans", () => {
  assert.equal(parseBooleanEnv("FLAG", undefined, true), true);
  assert.equal(parseBooleanEnv("FLAG", "false", true), false);
  assert.equal(parseBooleanEnv("FLAG", "YES", false), true);
  assert.throws(() => parseBooleanEnv("FLAG", "sometimes", false), /Invalid boolean env/);
});

test("runtime config rejects invalid numbers", () => {
  assert.equal(parseNumberEnv("PORT", undefined, 3000, { integer: true, min: 1 }), 3000);
  assert.equal(parseNumberEnv("PORT", "3001", 3000, { integer: true, min: 1 }), 3001);
  assert.throws(() => parseNumberEnv("PORT", "3.14", 3000, { integer: true }), /Invalid integer env/);
  assert.throws(() => parseNumberEnv("PORT", "0", 3000, { min: 1 }), /must be >=/);
  assert.throws(() => parseNumberEnv("PORT", "nope", 3000), /Invalid number env/);
});

test("runtime config normalizes strings and csv sets", () => {
  assert.equal(parseStringEnv("  value  ", "fallback"), "value");
  assert.equal(parseStringEnv("  ", "fallback"), "fallback");
  assert.equal(parseNullableStringEnv("  "), null);
  assert.deepEqual([...parseCsvSet("A, B,,C")], ["A", "B", "C"]);
});
