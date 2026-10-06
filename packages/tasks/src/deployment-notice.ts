import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEPLOY_RECEIPT_PATH = path.join(
  process.env.HOME ?? os.homedir(),
  "state",
  "deploy-main",
  "last-run.json"
);

/**
 * Build the update notice injected into the first turn of a run resumed after
 * a deployment checkpoint. Returns null when no successful deployment finished
 * after the run was checkpointed, so ordinary interruptions carry no notice.
 */
export function deploymentUpdateNotice(
  checkpointedAt: string | null,
  receiptPath: string = DEPLOY_RECEIPT_PATH
): string | null {
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (receipt === null || typeof receipt !== "object") return null;
  if (receipt.ok !== true) return null;
  const deployedSha = receipt.deployedSha;
  const ranAt = receipt.ranAt;
  if (typeof deployedSha !== "string" || typeof ranAt !== "string") return null;
  const deployedAtMs = Date.parse(ranAt);
  if (Number.isNaN(deployedAtMs)) return null;
  if (checkpointedAt) {
    const checkpointedAtMs = Date.parse(checkpointedAt);
    if (!Number.isNaN(checkpointedAtMs) && deployedAtMs < checkpointedAtMs) return null;
  }
  const count = (key: string): number => (Array.isArray(receipt[key]) ? (receipt[key] as unknown[]).length : 0);
  return [
    "Deployment notice: this conversation was checkpointed while the harness source was updated from main.",
    `The runtime now runs commit ${deployedSha} (deployed ${ranAt}; ${count("addedManagedPaths")} added, ${count("modifiedManagedPaths")} modified, ${count("deletedManagedPaths")} deleted managed files).`,
    "Continue the task from where it left off, and re-read any harness files whose behavior the current step depends on."
  ].join("\n");
}
