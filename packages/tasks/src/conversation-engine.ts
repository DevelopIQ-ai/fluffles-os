import { ConversationEngine as PackageConversationEngine } from "@fluffles/conversations";
import type { DeploymentLifecycle, TaskLedger } from "./ledger/types";

export type {
  ConversationAction,
  ConversationAdmission,
  ConversationEngineIngestInput,
  ConversationEngineIngestResult,
  ConversationEngineOptions,
  IntakeMode
} from "@fluffles/conversations";

/**
 * The fluffles conversation engine: the package engine over the composite
 * TaskLedger. Reminders reach it as ordinary admitted messages.
 */
export class ConversationEngine extends PackageConversationEngine<TaskLedger> {
  override async deploymentLifecycle(): Promise<DeploymentLifecycle> {
    return this.ledger.deploymentLifecycle();
  }

}
