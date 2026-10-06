import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Smoke is the deploy gate, and its liveness check cannot tell a service from a
// crash loop: a KeepAlive job that dies on startup is running again a
// ThrottleInterval later, so `state = running` is true of both. The chat console
// crash-looped on an unprovisioned Infisical path through a deploy that reported
// smoke passed. The stability check is what closes that.
const root = path.resolve(__dirname, "..");
const smokeSource = fs.readFileSync(path.join(root, "tools", "smoke", "bin", "smoke.ts"), "utf8");

// A job launchd is restarting, as `launchctl print` reports it.
const LAUNCHCTL_PRINT = `com.puffle.fluffles.channel.chat-console = {
	active count = 1
	path = /Users/ai/Library/LaunchAgents/com.puffle.fluffles.channel.chat-console.plist
	state = running
	program = /Users/ai/bin/breadcrumb-service
	pid = 74214
	immediate reason = speculative
	forks = 0
	execs = 1
	initialized = 1
	last exit code = 1
}
`;

test("smoke reads the pid launchctl reports, which is how a restart is visible", () => {
  const expression = smokeSource.match(/function launchdPid[\s\S]*?text\.match\((\/[^\n]+\/)\)/);
  assert.ok(expression, "smoke must read a pid out of launchctl print output");
  const pattern = new RegExp(expression[1].slice(1, expression[1].lastIndexOf("/")));
  const match = LAUNCHCTL_PRINT.match(pattern);
  assert.ok(match, "the pattern smoke uses must match real launchctl print output");
  assert.equal(match[1].trim(), "74214");
});

test("the deploy gate compares two samples a window apart, not one liveness answer", () => {
  const start = smokeSource.indexOf("async function checkServiceStability(");
  assert.ok(start >= 0, "smoke must define the stability check");
  const body = smokeSource.slice(start, smokeSource.indexOf("\n}", start));
  assert.match(body, /const before = await sample\(\)/);
  assert.match(body, /setTimeout\(resolve, windowMs\)/);
  assert.match(body, /const after = await sample\(\)/);
  // A restart window has to outlast a throttled relaunch, or a loop looks still.
  const windowMs = Number(body.match(/SMOKE_STABILITY_WINDOW_MS \|\| (\d+)/)?.[1]);
  assert.ok(windowMs >= 11000, `a ${windowMs}ms window is shorter than launchd's 10s restart throttle`);
});

test("both smoke modes run the stability check, so a deploy cannot pass around it", () => {
  const registrations = [...smokeSource.matchAll(/runCheck\(checks, "service-stability"/g)];
  assert.equal(registrations.length, 2, "the check belongs in the deploy mode and the full run");
  const deployMode = smokeSource.indexOf('runCheck(checks, "deploy-main-poller"');
  assert.ok(registrations.some((entry) => entry.index! < deployMode), "the deploy mode must run it");
});
