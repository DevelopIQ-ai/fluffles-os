/** Stable Slack provider identity for one delivered message. */
export function slackProviderMessageIdentity(teamId: string, channel: string, timestamp: string): string {
  return `slack:${teamId}:${channel}:${timestamp}`;
}
