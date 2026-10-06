import type { TaskChannel } from "../../packages/tasks/src/task-ledger";

/**
 * A channel slot: which transport exists, where its server lives, and how
 * launchd keeps it running. The server owns its own runtime internals; this
 * descriptor is the composition-level identity of the channel.
 */
export interface ChannelSlot {
  readonly channel: TaskChannel;
  /** Repo-relative path to the long-running channel server entrypoint. */
  readonly server: string;
  /**
   * Name of the service in deploy/services.json whose supervisor definition
   * keeps the server alive. The label and paths are per host, so the channel
   * names the service rather than a manifest file or a production label.
   */
  readonly service: string;
  /** Infisical secrets path injected by infisical-run at service start. */
  readonly secretsPath: string;
}
