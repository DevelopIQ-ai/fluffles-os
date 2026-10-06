import type { ChannelSlot } from "./channel";

/** Slack: the team channel and default communication surface. */
export const slackChannel: ChannelSlot = {
  channel: "slack",
  server: "channels/slack/src/server.ts",
  service: "slack",
  secretsPath: "/services/slack"
};
