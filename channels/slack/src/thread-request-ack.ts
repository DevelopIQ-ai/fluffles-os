import type { IntakeDisposition } from "./thread-request-store";

export type SlackAckReactionName = "eyes";

export type ThreadRequestAckPolicy =
  | { kind: "reaction"; reactionName: SlackAckReactionName }
  | { kind: "none" };

const requestAckReaction: ThreadRequestAckPolicy = { kind: "reaction", reactionName: "eyes" };

export function threadRequestAckPolicy(disposition: IntakeDisposition): ThreadRequestAckPolicy {
  switch (disposition) {
    case "new_request":
    case "running_update":
    case "queued_update":
    case "thread_update":
      return requestAckReaction;
    case "filtered":
    case "duplicate":
      return { kind: "none" };
  }
}


export function isThreadRequestAckAlreadyPresent(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("slack" in error)) return false;
  const slack = (error as { slack?: unknown }).slack;
  if (!slack || typeof slack !== "object" || !("error" in slack)) return false;
  return (slack as { error?: unknown }).error === "already_reacted";
}
