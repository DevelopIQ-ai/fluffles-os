import { ExecutorAgentPhoneClient, type PhoneAgentPhoneClient } from "./agentphone-client";

/** Public, secret-free result emitted by the AgentPhone Executor health command. */
export interface AgentPhoneHealthResult {
  ok: boolean;
  tool: "agentphone";
  component: "executor";
  critical: true;
  detail: string;
}

/** Performs the smallest read-only Executor call that proves the scoped AgentPhone surface works. */
export async function checkAgentPhoneHealth(client: Pick<PhoneAgentPhoneClient, "listMessages">): Promise<AgentPhoneHealthResult> {
  try {
    await client.listMessages({ limit: 1 });
    return { ok: true, tool: "agentphone", component: "executor", critical: true, detail: "Executor AgentPhone read probe succeeded" };
  } catch (error) {
    return { ok: false, tool: "agentphone", component: "executor", critical: true, detail: errorMessage(error) };
  }
}

async function main(): Promise<void> {
  const result = await checkAgentPhoneHealth(new ExecutorAgentPhoneClient());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message.slice(0, 1000);
  return String(error).slice(0, 1000);
}

if (require.main === module) {
  void main();
}
