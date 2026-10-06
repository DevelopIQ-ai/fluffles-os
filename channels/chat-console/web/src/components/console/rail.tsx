"use client";

import type { Channel, ModelInfo } from "@/lib/console-api";
import { ChevronIcon, StarIcon } from "./icons";

export interface RailProps {
  channels: Channel[];
  model: ModelInfo | null;
}

export function Rail({ channels, model }: RailProps) {
  return (
    <aside className="rail" aria-label="Agent configuration">
      <Panel title="Channels">
        <div className="rail-list">
          {channels.map((channel) => (
            <div className="rail-item" key={channel.id}>
              <div className="rail-item-head">
                <span className="rail-item-name">{channel.name}</span>
                <span className={`rail-tag${channel.id === "web" ? " on" : ""}`}>
                  {channel.id === "web" ? "this channel" : channel.id}
                </span>
              </div>
              <p className="rail-item-text">
                {channel.conversations} {channel.conversations === 1 ? "conversation" : "conversations"}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <details className="panel" open>
        <summary className="panel-title">
          <span>Model</span>
          <ChevronIcon className="chevron" />
        </summary>
        <div className="panel-body">
          <div className="rail-item">
            <div className="rail-item-head">
              <StarIcon className="model-star" />
              <span className="rail-item-name">{model?.model ?? "codex"}</span>
              <span className="rail-tag on">{model?.executor ?? "codex"}</span>
            </div>
            <p className="rail-item-text">
              reasoning {model?.reasoningEffort ?? "unknown"} · service tier {model?.serviceTier ?? "unknown"}
            </p>
          </div>
        </div>
      </details>
    </aside>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="panel" open>
      <summary className="panel-title">
        <span>{title}</span>
        <ChevronIcon className="chevron" />
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}

