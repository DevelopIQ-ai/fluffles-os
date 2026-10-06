import assert from "node:assert/strict";
import test from "node:test";
import { decideAmbientIntake } from "../src/ambient-intake";

test("low-intent ambient pings get a lightweight ack instead of work", () => {
  for (const text of ["yo", "lol", "hey", "ping", "are you alive?", "working on what"]) {
    const decision = decideAmbientIntake({ text });

    assert.equal(decision.action, "ack");
    assert.equal(decision.reason, "low_intent_ambient_ping");
    assert.match(decision.replyText || "", /send the actual task/);
  }
});

test("real ambient requests still enter the work queue", () => {
  for (const text of ["fix github auth", "stress test slack", "rename fluffles-source to source-code"]) {
    const decision = decideAmbientIntake({ text });

    assert.equal(decision.action, "work");
    assert.equal(decision.reason, null);
  }
});

test("files still enter the work queue even without text", () => {
  const decision = decideAmbientIntake({ text: "", hasFiles: true });

  assert.equal(decision.action, "work");
});

test("empty ambient messages are ignored", () => {
  const decision = decideAmbientIntake({ text: "   " });

  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "empty_ambient_message");
});

test("an explicit Slack bot mention is work even when its visible remainder is punctuation", () => {
  const addressedPings = [
    "<@UFLUFFLES>?",
    "<@UFLUFFLES>   ?",
    "<@UFLUFFLES> 🤔",
    "<@UFLUFFLES> what is connected?",
    "<@UFLUFFLES> deploy the Slack runtime"
  ];

  for (const text of addressedPings) {
    const decision = decideAmbientIntake({ text, addressed: true });
    assert.equal(decision.action, "work", text);
    assert.equal(decision.reason, null, text);
  }
});

test("mention markup is never normalized into a low-intent punctuation ping", () => {
  const decision = decideAmbientIntake({ text: "<@UOTHER>?" });

  assert.equal(decision.action, "work");
  assert.equal(decision.reason, null);
});
