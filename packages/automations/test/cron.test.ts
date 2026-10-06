import assert from "node:assert/strict";
import test from "node:test";
import { isValidCron, nextCronRun, parseCron, zonedParts } from "../src/cron";

test("parses the field grammar", () => {
  const fields = parseCron("*/15 1-3 1,15 * 1-5");
  assert.ok(fields);
  assert.deepEqual([...fields.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...fields.hours], [1, 2, 3]);
  assert.deepEqual([...fields.daysOfMonth], [1, 15]);
  assert.equal(fields.months.size, 12);
  assert.deepEqual([...fields.daysOfWeek], [1, 2, 3, 4, 5]);
  assert.equal(fields.dayUnion, true);
});

test("rejects malformed expressions", () => {
  for (const expression of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "a * * * *"]) {
    assert.equal(isValidCron(expression), false, `${expression} should be invalid`);
  }
});

test("treats day-of-month and day-of-week as a union when both are restricted", () => {
  // 2026-08-03 is a Monday; the 15th is a Saturday.
  const fromMonday = nextCronRun("0 0 15 * 1", "UTC", new Date("2026-08-02T12:00:00Z"));
  assert.equal(fromMonday?.toISOString(), "2026-08-03T00:00:00.000Z");
});

test("next run advances strictly forward", () => {
  const exact = nextCronRun("*/5 * * * *", "UTC", new Date("2026-08-02T10:05:00.000Z"));
  assert.equal(exact?.toISOString(), "2026-08-02T10:10:00.000Z");
});

test("evaluates wall-clock time in the target zone", () => {
  const next = nextCronRun("42 5 * * *", "America/Los_Angeles", new Date("2026-08-02T00:00:00Z"));
  assert.ok(next);
  const parts = zonedParts(next, "America/Los_Angeles");
  assert.equal(parts.hour, 5);
  assert.equal(parts.minute, 42);
  // 05:42 PDT is 12:42 UTC.
  assert.equal(next.toISOString(), "2026-08-02T12:42:00.000Z");
});

test("a wall-clock time skipped by spring forward does not fire that day", () => {
  // 2026-03-08 02:30 America/Los_Angeles does not exist.
  const next = nextCronRun("30 2 * * *", "America/Los_Angeles", new Date("2026-03-08T00:00:00Z"));
  assert.equal(next?.toISOString(), "2026-03-09T09:30:00.000Z");
});

test("a wall-clock time repeated by fall back fires in both passes", () => {
  const first = nextCronRun("30 1 * * *", "America/Los_Angeles", new Date("2026-11-01T07:00:00Z"));
  assert.equal(first?.toISOString(), "2026-11-01T08:30:00.000Z");
  const second = nextCronRun("30 1 * * *", "America/Los_Angeles", first as Date);
  assert.equal(second?.toISOString(), "2026-11-01T09:30:00.000Z");
});

test("sunday is accepted as both 0 and 7", () => {
  assert.ok(isValidCron("0 9 * * 7"));
  const asSeven = nextCronRun("0 9 * * 7", "UTC", new Date("2026-08-02T00:00:00Z"));
  const asZero = nextCronRun("0 9 * * 0", "UTC", new Date("2026-08-02T00:00:00Z"));
  assert.equal(asSeven?.toISOString(), "2026-08-02T09:00:00.000Z");
  assert.equal(asSeven?.toISOString(), asZero?.toISOString());
});

test("a well-formed expression that can never come due gives up quickly", () => {
  const started = Date.now();
  assert.equal(nextCronRun("0 0 30 2 *", "UTC", new Date("2026-08-02T00:00:00Z")), null);
  // The property is that the search is bounded at all; an unbounded one runs
  // for years, so the budget only has to survive a loaded machine.
  assert.ok(Date.now() - started < 10_000, "an unsatisfiable schedule must not block the daemon");
});

test("a leap day is still found even though the search skips whole days", () => {
  const next = nextCronRun("0 0 29 2 *", "UTC", new Date("2026-08-02T00:00:00Z"));
  assert.equal(next?.toISOString(), "2028-02-29T00:00:00.000Z");
});
