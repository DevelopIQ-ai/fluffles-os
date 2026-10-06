import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { emailChannel } from "../agent/channels/email";
import { phoneChannel } from "../agent/channels/phone";
import { slackChannel } from "../agent/channels/slack";
import type { ChannelSlot } from "../agent/channels/channel";
import { CodexProcessRunner, codexExecutor } from "../agent/executors/codex";
import { serviceNamed, services } from "./support/host";

const root = path.resolve(__dirname, "..");
const channelSlots: ChannelSlot[] = [slackChannel, emailChannel, phoneChannel];

for (const slot of channelSlots) {
  test(`agent channel slot ${slot.channel} matches its server and its service definition`, () => {
    assert.ok(fs.existsSync(path.join(root, slot.server)), `${slot.server} must exist`);
    const service = serviceNamed("prod", slot.service);
    assert.ok(service.program.includes(`/Users/ai/${slot.server}`), `${service.label} does not run ${slot.server}`);
    assert.ok(service.program.includes(slot.secretsPath), `${service.label} does not inject ${slot.secretsPath}`);
  });
}

test("agent channel slots cover exactly the channel services production runs", () => {
  const deployed = services("prod")
    .filter((service) => service.label.includes(".channel."))
    .map((service) => service.name)
    .sort();
  assert.deepEqual(channelSlots.map((slot) => slot.service).sort(), deployed);
});

test("agent executor slot exposes the codex process runner and its knobs", () => {
  assert.equal(typeof CodexProcessRunner, "function");
  assert.equal(codexExecutor.command, "codex");
  for (const channel of ["slack", "email", "phone"]) {
    const srcDir = path.join(root, "channels", channel, "src");
    const source = fs.readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => fs.readFileSync(path.join(srcDir, file), "utf8"))
      .join("\n");
    assert.match(source, /agent\/executors\/codex/, `${channel} must compose codex knobs from agent/executors/codex`);
    assert.match(source, /codexExecutor\.modelEnv/, `${channel} must read the model env through the executor slot`);
  }
});

test("a due reminder is admitted by the channels themselves, with no second scheduler", () => {
  for (const channel of ["slack", "email", "phone", "chat-console"]) {
    const srcDir = path.join(root, "channels", channel, "src");
    const source = fs.readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => fs.readFileSync(path.join(srcDir, file), "utf8"))
      .join("\n");
    assert.match(source, /admitDueReminders/, `${channel} must admit its own due reminders`);
    assert.doesNotMatch(source, /--run-reminder/, `${channel} must not keep a reminder execution path`);
  }
  assert.equal(fs.existsSync(path.join(root, "agent", "schedules")), false);
});

