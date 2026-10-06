import type { ChannelSlot } from "./channel";

/** Phone: SMS through the agentphone capability, treated as sensitive. */
export const phoneChannel: ChannelSlot = {
  channel: "phone",
  server: "channels/phone/src/server.ts",
  service: "phone",
  secretsPath: "/services/phone"
};
