import type { ChannelSlot } from "./channel";

/** Email: Gmail via Google Workspace, treated as sensitive. */
export const emailChannel: ChannelSlot = {
  channel: "email",
  server: "channels/email/src/server.ts",
  service: "email",
  secretsPath: "/services/email-channel"
};
