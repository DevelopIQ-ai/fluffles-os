"use client";

import type { ChatSummary } from "@/lib/console-api";
import {
  BoltIcon,
  BookIcon,
  HomeIcon,
  HookIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon
} from "./icons";

export type ConsoleView = "chats" | "automations" | "skills" | "connections" | "hooks";

export interface SidebarProps {
  view: ConsoleView;
  chats: ChatSummary[];
  activeChatId: string | null;
  draftChatId: string | null;
  onSelectView: (view: ConsoleView) => void;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onSignOut: () => void;
  signOutEnabled: boolean;
}

const panes: { view: ConsoleView; label: string; Icon: typeof HomeIcon }[] = [
  { view: "chats", label: "Chats", Icon: HomeIcon },
  { view: "automations", label: "Automations", Icon: BoltIcon },
  { view: "skills", label: "Skills", Icon: BookIcon },
  { view: "connections", label: "Connections", Icon: PlugIcon },
  { view: "hooks", label: "Hooks", Icon: HookIcon }
];

export function Sidebar({
  view,
  chats,
  activeChatId,
  draftChatId,
  onSelectView,
  onSelectChat,
  onNewChat,
  onSignOut,
  signOutEnabled
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar-head">
        <button className="icon-button" type="button" aria-label="Search">
          <SearchIcon />
        </button>
      </div>

      <div className="sidebar-top">
        <nav className="nav-main" aria-label="primary">
          {panes.map(({ view: pane, label, Icon }) => (
            <button
              className={`nav-item${view === pane ? " active" : ""}`}
              key={pane}
              type="button"
              aria-current={view === pane}
              onClick={() => onSelectView(pane)}
            >
              <Icon className="nav-icon" />
              <span className="nav-label">{label}</span>
            </button>
          ))}
          <button className="nav-item" type="button" onClick={onNewChat}>
            <PlusIcon className="nav-icon" />
            <span className="nav-label">New Chat</span>
          </button>
        </nav>

        <section className="nav-group" aria-labelledby="chats-heading">
          <h2 className="nav-group-title" id="chats-heading">
            Your Chats
          </h2>
          <div className="nav-list" role="list">
            {draftChatId !== null && (
              <button
                className={`agent-item${view === "chats" && activeChatId === draftChatId ? " active" : ""}`}
                type="button"
                role="listitem"
                onClick={() => onSelectChat(draftChatId)}
              >
                <span className="agent-label">New chat</span>
              </button>
            )}
            {chats.map((chat) => (
              <button
                className={`agent-item${view === "chats" && activeChatId === chatIdOf(chat) ? " active" : ""}`}
                key={chat.conversationKey}
                type="button"
                role="listitem"
                onClick={() => onSelectChat(chatIdOf(chat))}
              >
                <span className="agent-label">{chat.title ?? "Untitled chat"}</span>
              </button>
            ))}
            {chats.length === 0 && draftChatId === null && <p className="session-empty">No chats yet</p>}
          </div>
        </section>
      </div>

      <footer className="sidebar-footer">
        <div className="user-row">
          <UserIcon className="nav-icon" />
          <span className="user-name">Fluffles console</span>
        </div>
        <div className="footer-row">
          <button className="nav-item settings" type="button" disabled={!signOutEnabled} onClick={onSignOut}>
            <SettingsIcon className="nav-icon" />
            <span className="nav-label">{signOutEnabled ? "Sign out" : "Local access"}</span>
          </button>
          <span className="version">web</span>
        </div>
      </footer>
    </aside>
  );
}

export function chatIdOf(chat: ChatSummary): string {
  return chat.conversationKey.replace(/^web:/, "");
}
