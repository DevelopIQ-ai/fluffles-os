"use client";

import type { Automation, Connection, Hook, Skill } from "@/lib/console-api";
import { SearchIcon } from "./icons";

export interface RegistryPaneProps {
  title: string;
  subtitle: string;
  emptyTitle: string;
  emptyText: string;
  rows: RegistryRow[];
}

export interface RegistryRow {
  key: string;
  name: string;
  tag: string | null;
  tagOn?: boolean;
  meta: string | null;
  text: string;
}

export function RegistryPane({ title, subtitle, emptyTitle, emptyText, rows }: RegistryPaneProps) {
  return (
    <div className="content">
      <div className="content-head">
        <h1 className="agent-title">{title}</h1>
        <button className="icon-button" type="button" aria-label={`Search ${title.toLowerCase()}`}>
          <SearchIcon />
        </button>
      </div>
      <p className="pane-subtitle">{subtitle}</p>
      {rows.length === 0 ? (
        <div className="empty-box">
          <p className="empty-title">{emptyTitle}</p>
          <p className="empty-text">{emptyText}</p>
        </div>
      ) : (
        <div className="pane-list">
          {rows.map((row) => (
            <div className="rail-item pane-item" key={row.key}>
              <div className="rail-item-head">
                <span className="rail-item-name">{row.name}</span>
                {row.meta !== null && <span className="rail-item-meta">{row.meta}</span>}
                {row.tag !== null && <span className={`rail-tag${row.tagOn ? " on" : ""}`}>{row.tag}</span>}
              </div>
              <p className="rail-item-text pane-item-text">{row.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function automationRows(automations: Automation[]): RegistryRow[] {
  return automations.map((automation) => ({
    key: automation.id,
    name: automation.name,
    tag: automation.enabled ? "enabled" : "disabled",
    tagOn: automation.enabled,
    meta: `${automation.stepCount} ${automation.stepCount === 1 ? "step" : "steps"}`,
    text: [automation.description, automation.triggers.map(triggerLabel).join(", ")].filter(Boolean).join(" · ")
  }));
}

export function skillRows(skills: Skill[]): RegistryRow[] {
  return skills.map((skill) => ({
    key: skill.path,
    name: skill.name,
    tag: skill.sourceType,
    meta: skill.source,
    text: skill.description ?? skill.path
  }));
}

export function connectionRows(connections: Connection[]): RegistryRow[] {
  return connections.map((connection) => ({
    key: connection.name,
    name: connection.name,
    tag: connection.required ? "required" : null,
    meta: `${connection.toolNames.length} ${connection.toolNames.length === 1 ? "tool" : "tools"}`,
    text: connection.description
  }));
}

export function hookRows(hooks: Hook[]): RegistryRow[] {
  return hooks.map((hook, index) => ({
    key: `${hook.tool}:${hook.event}:${index}`,
    name: hook.statusMessage ?? hook.command,
    tag: hook.event,
    tagOn: true,
    meta: hook.timeoutSeconds === null ? hook.tool : `${hook.tool} · ${hook.timeoutSeconds}s`,
    text: hook.command
  }));
}

function triggerLabel(trigger: Automation["triggers"][number]): string {
  return trigger.detail === null ? trigger.kind : `${trigger.kind} ${trigger.detail}`;
}
