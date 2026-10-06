"use strict";

const channelLabels = { slack: "Slack", email: "Email", phone: "Phone" };
const caretIcon = `<svg class="agent-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9.5 12 15.5 18 9.5"></polyline></svg>`;
const spinnerIcon = `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="2 4"></circle></svg>`;

const sampleAgents = [
  {
    id: "sample",
    name: "Server Location Finder",
    busy: true,
    sessions: [
      { id: "sample-session", name: "Finding Server Location", status: "running", updatedAt: minutesAgo(5) }
    ]
  }
];

const state = {
  agents: sampleAgents,
  selectedId: sampleAgents[0].id,
  collapsedIds: new Set()
};

const elements = {
  app: document.querySelector("#app"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  agentList: document.querySelector("#agent-list"),
  sessionList: document.querySelector("#session-list"),
  topbarTitle: document.querySelector("#topbar-title"),
  topbarStatus: document.querySelector("#topbar-status"),
  agentTitle: document.querySelector("#agent-title"),
  composerInput: document.querySelector("#composer-input"),
  sendButton: document.querySelector("#send-button")
};

function selectedAgent() {
  return state.agents.find((agent) => agent.id === state.selectedId) || state.agents[0] || null;
}

function render() {
  renderAgentList();
  renderSessions();
  renderTitles();
}

function renderAgentList() {
  if (!elements.agentList) return;
  elements.agentList.replaceChildren();
  for (const agent of state.agents) {
    const group = document.createElement("div");

    const button = document.createElement("button");
    button.type = "button";
    const collapsed = state.collapsedIds.has(agent.id);
    button.className = `agent-item${agent.id === state.selectedId ? " active" : ""}${collapsed ? " collapsed" : ""}`;
    button.innerHTML = `
      ${caretIcon}
      <span class="agent-label">${escapeHtml(agent.name)}</span>
      ${agent.busy ? spinnerIcon : ""}
    `;
    button.addEventListener("click", (event) => {
      if (event.target.closest(".agent-caret")) {
        if (collapsed) state.collapsedIds.delete(agent.id);
        else state.collapsedIds.add(agent.id);
      } else {
        state.selectedId = agent.id;
      }
      render();
    });
    group.append(button);

    if (agent.sessions.length > 0 && !collapsed) {
      const children = document.createElement("div");
      children.className = "agent-children";
      for (const session of agent.sessions.slice(0, 4)) {
        const child = document.createElement("button");
        child.type = "button";
        child.className = "agent-child";
        child.innerHTML = `
          <span class="agent-child-label">${escapeHtml(session.name)}</span>
          ${session.status === "running" || session.status === "queued" ? `<span class="nav-dot"></span>` : ""}
        `;
        children.append(child);
      }
      group.append(children);
    }

    elements.agentList.append(group);
  }
}

function renderSessions() {
  if (!elements.sessionList) return;
  const agent = selectedAgent();
  const sessions = agent ? agent.sessions : [];
  elements.sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "No sessions yet";
    elements.sessionList.append(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item";
    item.innerHTML = `
      <span class="session-row">
        <span class="session-dot ${escapeHtml(dotClass(session.status))}"></span>
        <span class="session-name">${escapeHtml(session.name)}</span>
      </span>
      <span class="session-time">${escapeHtml(relativeTime(session.updatedAt))}</span>
    `;
    elements.sessionList.append(item);
  }
}

function renderTitles() {
  const agent = selectedAgent();
  const name = agent ? agent.name : "Untitled";
  if (elements.topbarTitle) elements.topbarTitle.textContent = name;
  if (elements.agentTitle) elements.agentTitle.textContent = name;
}

function dotClass(status) {
  if (status === "failed") return "failed";
  if (status === "running" || status === "queued") return "";
  return "done";
}

function setStatus(status) {
  if (!elements.topbarStatus) return;
  elements.topbarStatus.className = `status ${status}`;
  const label = elements.topbarStatus.querySelector(".status-label");
  if (label) label.textContent = status;
}

function showReadOnlyNotice() {
  const value = elements.composerInput ? elements.composerInput.value.trim() : "";
  if (!value) return;
  alert("This console is read-only. Interact with Fluffles through Slack, email, or phone.");
  elements.composerInput.value = "";
}

if (elements.sendButton) {
  elements.sendButton.addEventListener("click", showReadOnlyNotice);
}

if (elements.sidebarToggle && elements.app) {
  elements.sidebarToggle.addEventListener("click", () => {
    const hidden = elements.app.classList.toggle("sidebar-hidden");
    elements.sidebarToggle.setAttribute("aria-expanded", hidden ? "false" : "true");
  });
}

if (elements.composerInput) {
  elements.composerInput.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      showReadOnlyNotice();
    }
  });
}

async function loadLedger() {
  try {
    const [snapshot, conversations] = await Promise.all([
      fetchJson("/api/snapshot"),
      fetchJson("/api/conversations?limit=100")
    ]);
    const agents = agentsFromConversations(conversations.conversations || []);
    if (agents.length > 0) {
      state.agents = agents;
      if (!agents.some((agent) => agent.id === state.selectedId)) state.selectedId = agents[0].id;
      render();
    }
    const byStatus = snapshot.snapshot.byStatus;
    setStatus(byStatus.running > 0 || byStatus.queued > 0 ? "running" : "idle");
  } catch {
    setStatus("idle");
  }
}

function agentsFromConversations(conversations) {
  const byChannel = new Map();
  for (const conversation of conversations) {
    const channel = conversation.channel;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push({
      id: conversation.id,
      name: conversation.title || conversation.conversationKey,
      status: conversation.status,
      updatedAt: conversation.lastMessageAt || conversation.updatedAt
    });
  }
  return [...byChannel.entries()].map(([channel, sessions]) => ({
    id: channel,
    name: channelLabels[channel] || channel,
    busy: sessions.some((session) => session.status === "running" || session.status === "queued"),
    sessions
  }));
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `request failed: ${response.status}`);
  return data;
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
    return map[char] || char;
  });
}

render();
void loadLedger();
