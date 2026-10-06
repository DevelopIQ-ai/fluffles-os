"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronIcon,
  MicIcon,
  PanelIcon,
  PaperclipIcon,
  SearchIcon,
  SendIcon,
  SlidersIcon,
  SortIcon,
  SpinnerIcon,
  StarIcon
} from "@/components/console/icons";
import { Rail } from "@/components/console/rail";
import {
  RegistryPane,
  automationRows,
  connectionRows,
  hookRows,
  skillRows,
  type RegistryPaneProps
} from "@/components/console/registry-pane";
import { Sidebar, chatIdOf, type ConsoleView } from "@/components/console/sidebar";
import { SignIn } from "@/components/console/sign-in";
import { Transcript } from "@/components/console/transcript";
import {
  ApiError,
  chatEventsUrl,
  getChat,
  getModel,
  getSession,
  listAutomations,
  listChannels,
  listChats,
  listConnections,
  listHooks,
  listSkills,
  newChatId,
  sendMessage,
  signOut,
  stopChat,
  type Automation,
  type Channel,
  type ChatConversation,
  type ChatSummary,
  type Connection,
  type Hook,
  type ModelInfo,
  type SessionState,
  type Skill
} from "@/lib/console-api";

export default function ConsolePage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [view, setView] = useState<ConsoleView>("chats");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [draftChatId, setDraftChatId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [running, setRunning] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [draftText, setDraftText] = useState("");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const authenticated = session?.authenticated === true;

  const refreshSession = useCallback(async () => {
    setSession(await getSession());
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const startDraft = useCallback(async () => {
    const chatId = await newChatId();
    setDraftChatId(chatId);
    setActiveChatId(chatId);
    setConversation(null);
    setDraftText("");
    setView("chats");
    composerRef.current?.focus();
  }, []);

  const refreshChats = useCallback(async () => {
    const list = await listChats();
    setChats(list);
    return list;
  }, []);

  const refreshConversation = useCallback(async (chatId: string) => {
    const result = await getChat(chatId);
    setConversation(result.chat);
    setRunning(result.running || result.chat?.status === "running" || result.chat?.status === "queued");
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void (async () => {
      try {
        const [list, loadedAutomations, loadedConnections, loadedSkills, loadedHooks, loadedChannels, loadedModel] =
          await Promise.all([
            refreshChats(),
            listAutomations(),
            listConnections(),
            listSkills(),
            listHooks(),
            listChannels(),
            getModel()
          ]);
        setAutomations(loadedAutomations);
        setConnections(loadedConnections);
        setSkills(loadedSkills);
        setHooks(loadedHooks);
        setChannels(loadedChannels);
        setModel(loadedModel);
        const first = list[0];
        if (first) setActiveChatId(chatIdOf(first));
        else await startDraft();
      } catch (cause) {
        setError(messageFor(cause));
      }
    })();
  }, [authenticated, refreshChats, startDraft]);

  useEffect(() => {
    if (!authenticated || activeChatId === null) return;
    void refreshConversation(activeChatId).catch((cause: unknown) => setError(messageFor(cause)));
  }, [authenticated, activeChatId, refreshConversation]);

  useEffect(() => {
    if (!authenticated || activeChatId === null) return;
    const events = new EventSource(chatEventsUrl(activeChatId), { withCredentials: true });
    const reload = () => {
      void refreshConversation(activeChatId).catch(() => undefined);
      void refreshChats().catch(() => undefined);
    };
    events.addEventListener("message", reload);
    events.addEventListener("status", (event) => {
      const status = (JSON.parse((event as MessageEvent<string>).data) as { status: string }).status;
      setRunning(status === "running");
      reload();
    });
    events.addEventListener("error", (event) => {
      const data = (event as MessageEvent<string>).data;
      if (typeof data === "string" && data.length > 0) {
        setError((JSON.parse(data) as { error: string }).error);
        setRunning(false);
      }
    });
    return () => events.close();
  }, [authenticated, activeChatId, refreshConversation, refreshChats]);

  const messages = useMemo(() => conversation?.messages.filter((message) => message.direction !== "system") ?? [], [conversation]);
  const chatTitle = conversation?.title ?? (activeChatId !== null && activeChatId === draftChatId ? "New chat" : "Fluffles");
  const pane = view === "chats" ? null : paneFor(view, { automations, connections, skills, hooks });
  const title = pane?.title ?? chatTitle;
  const statusLabel = running ? "running" : conversation?.status ?? "idle";

  async function submit(): Promise<void> {
    const text = draftText.trim();
    if (!text || activeChatId === null) return;
    setDraftText("");
    setError(null);
    setRunning(true);
    try {
      await sendMessage(activeChatId, text);
      if (draftChatId === activeChatId) setDraftChatId(null);
      await refreshConversation(activeChatId);
      await refreshChats();
    } catch (cause) {
      setError(messageFor(cause));
      setDraftText(text);
      setRunning(false);
    }
  }

  if (session === null) return <div className="signin" />;
  if (!authenticated) return <SignIn passwordConfigured={session.passwordConfigured} onSignedIn={refreshSession} />;

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <Sidebar
        activeChatId={activeChatId}
        chats={chats}
        draftChatId={draftChatId}
        onNewChat={() => void startDraft()}
        onSelectChat={(chatId) => {
          setActiveChatId(chatId);
          setView("chats");
          setError(null);
        }}
        onSelectView={setView}
        onSignOut={() => void signOut().then(refreshSession)}
        signOutEnabled={session.reason === "authenticated"}
        view={view}
      />

      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button"
            type="button"
            aria-label="Toggle sidebar"
            aria-expanded={!sidebarHidden}
            onClick={() => setSidebarHidden((hidden) => !hidden)}
          >
            <PanelIcon />
          </button>
          <span className="divider" aria-hidden />
          <span className="topbar-title">{title}</span>
          <div className="topbar-actions">
            <span className={`status${running ? " running" : ""}`}>
              <SpinnerIcon className="spinner" />
              <span className="status-label">{statusLabel}</span>
            </span>
            <span className="divider" aria-hidden />
            <button
              className="icon-button"
              type="button"
              aria-label="Stop Fluffles"
              disabled={!running || activeChatId === null}
              onClick={() => {
                if (activeChatId !== null) void stopChat(activeChatId).catch((cause: unknown) => setError(messageFor(cause)));
              }}
            >
              <span className="stop-square" aria-hidden />
            </button>
          </div>
        </header>

        <main className="main" aria-label={pane === null ? "Chat workspace" : `${title} workspace`}>
          <div className="layout">
            {pane !== null ? (
              <RegistryPane {...pane} />
            ) : (
              <div className="content">
                <div className="content-head">
                  <h1 className="agent-title">{chatTitle}</h1>
                  <button className="icon-button" type="button" aria-label="Chat settings">
                    <SlidersIcon />
                  </button>
                </div>

                <Transcript messages={messages} running={running} />

                <section className="composer" aria-label="Message composer">
                  <textarea
                    className="composer-input"
                    ref={composerRef}
                    rows={2}
                    placeholder="How can I help? Press cmd+enter to send"
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-left">
                      <button className="chip-button icon-only" type="button" aria-label="Attach file" disabled>
                        <PaperclipIcon />
                      </button>
                      <span className="chip-button model-chip">
                        <StarIcon className="model-star" />
                        <span className="model-name">
                          <strong>{model?.model ?? "codex"}</strong>{" "}
                          <span className="model-tier">· {model?.reasoningEffort ?? "codex"}</span>
                        </span>
                        <ChevronIcon className="chevron" />
                      </span>
                    </div>
                    <div className="composer-right">
                      <button className="chip-button icon-only" type="button" aria-label="Voice input" disabled>
                        <MicIcon />
                      </button>
                      <button
                        className="send-button"
                        type="button"
                        aria-label="Send message"
                        disabled={draftText.trim().length === 0 || activeChatId === null}
                        onClick={() => void submit()}
                      >
                        <SendIcon />
                      </button>
                    </div>
                  </div>
                  {error !== null && <p className="composer-error">{error}</p>}
                </section>

                <section className="sessions" aria-labelledby="sessions-title">
                  <div className="sessions-head">
                    <h2 className="sessions-title" id="sessions-title">
                      Sessions
                    </h2>
                    <button className="icon-button small" type="button" aria-label="Sort sessions">
                      <SortIcon />
                    </button>
                    <button className="icon-button small" type="button" aria-label="Search sessions">
                      <SearchIcon />
                    </button>
                  </div>
                  <div className="session-list">
                    {(conversation?.runs ?? []).map((run) => (
                      <div className="session-item" key={run.id}>
                        <div className="session-row">
                          <span className={`session-dot ${runDotClass(run.status)}`} aria-hidden />
                          <span className="session-name">{run.error ?? run.status}</span>
                        </div>
                        <span className="session-time">{formatTime(run.finishedAt ?? run.startedAt)}</span>
                      </div>
                    ))}
                    {(conversation?.runs.length ?? 0) === 0 && <p className="session-empty">No runs yet</p>}
                  </div>
                </section>
              </div>
            )}

            <Rail channels={channels} model={model} />
          </div>
        </main>
      </div>
    </div>
  );
}

interface Registries {
  automations: Automation[];
  connections: Connection[];
  skills: Skill[];
  hooks: Hook[];
}

function paneFor(view: Exclude<ConsoleView, "chats">, registries: Registries): RegistryPaneProps {
  if (view === "automations") {
    return {
      title: "Automations",
      subtitle: "What starts Fluffles on its own, from the automation registry: schedules, webhooks, and events.",
      emptyTitle: "No automations yet",
      emptyText: "Automations live in automations/*/automation.json and carry the triggers that wake Fluffles.",
      rows: automationRows(registries.automations)
    };
  }
  if (view === "skills") {
    return {
      title: "Skills",
      subtitle: "Procedures Fluffles follows for specific tasks, one per installed SKILL.md.",
      emptyTitle: "No skills yet",
      emptyText: "Skills live in skills/*/SKILL.md and are pinned by skills/skills-lock.json.",
      rows: skillRows(registries.skills)
    };
  }
  if (view === "connections") {
    return {
      title: "Connections",
      subtitle: "The MCP servers Fluffles can call, and the tools each one exposes.",
      emptyTitle: "No connections yet",
      emptyText: "Connections come from the manifests in tools/mcp/manifests.",
      rows: connectionRows(registries.connections)
    };
  }
  return {
    title: "Hooks",
    subtitle: "Commands the harness runs around a Codex session, grouped by the event that fires them.",
    emptyTitle: "No hooks yet",
    emptyText: "Hooks come from hooks/*/hooks.json.",
    rows: hookRows(registries.hooks)
  };
}

function runDotClass(status: string): string {
  if (status === "failed") return "failed";
  if (status === "running") return "";
  return "done";
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
