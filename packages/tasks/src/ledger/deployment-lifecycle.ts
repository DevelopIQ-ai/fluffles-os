import { DatabaseSync } from "node:sqlite";

import { DeploymentLifecycleRow, deploymentLifecycleStates, requiredEnumField, requiredStringField, requireRuntimeRecord } from "./rows";
import { DeploymentLifecycle } from "./types";

/** Reads the deployment admission gate; also used by the bridge before starting runs. */
export function deploymentLifecycleInDb(db: DatabaseSync): DeploymentLifecycle {
  const raw = requireRuntimeRecord(
    db.prepare("SELECT state, updated_at AS updatedAt FROM deployment_lifecycle WHERE id = 1").get(),
    "deployment lifecycle row"
  );
  const row: DeploymentLifecycleRow = {
    state: requiredEnumField(raw, "state", deploymentLifecycleStates, "deployment lifecycle row"),
    updatedAt: requiredStringField(raw, "updatedAt", "deployment lifecycle row")
  };
  return { ...row };
}
