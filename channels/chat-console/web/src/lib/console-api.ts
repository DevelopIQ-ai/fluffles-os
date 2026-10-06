export type ConversationStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound" | "system";
  kind: string;
  authorId: string | null;
  text: string;
  receivedAt: string;
  runId: string | null;
}

export interface ChatRun {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ChatSummary {
  id: string;
  conversationKey: string;
  title: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface ChatConversation extends ChatSummary {
  messages: ChatMessage[];
  runs: ChatRun[];
}

export interface AutomationTrigger {
  kind: string;
  detail: string | null;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  stepCount: number;
  triggers: AutomationTrigger[];
}

export interface Hook {
  tool: string;
  event: string;
  command: string;
  timeoutSeconds: number | null;
  statusMessage: string | null;
}

export interface Connection {
  name: string;
  description: string;
  command: string;
  toolNames: string[];
  required: boolean;
  hasHealthProbe: boolean;
}

export interface Skill {
  name: string;
  description: string | null;
  path: string;
  source: string | null;
  sourceType: string | null;
}

export interface Channel {
  id: string;
  name: string;
  conversations: number;
}

export interface ModelInfo {
  executor: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
}

export interface SessionState {
  authenticated: boolean;
  reason: string;
  passwordConfigured: boolean;
}

/** The console server serves this app beside its API, so every call is same-origin. */
const apiBase = "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function chatEventsUrl(chatId: string): string {
  return `${apiBase}/api/chats/${chatId}/events`;
}

export async function getSession(): Promise<SessionState> {
  const body = await request<{ authenticated: boolean; reason: string; passwordConfigured: boolean }>("/api/session");
  return { authenticated: body.authenticated, reason: body.reason, passwordConfigured: body.passwordConfigured };
}

export async function signIn(password: string): Promise<void> {
  await request("/api/session", { method: "POST", body: JSON.stringify({ password }) });
}

export async function signOut(): Promise<void> {
  await request("/api/session", { method: "DELETE" });
}

export async function listChats(): Promise<ChatSummary[]> {
  const body = await request<{ chats: ChatSummary[] }>("/api/chats");
  return body.chats;
}

export async function newChatId(): Promise<string> {
  const body = await request<{ chatId: string }>("/api/chats/new");
  return body.chatId;
}

export async function getChat(chatId: string): Promise<{ chat: ChatConversation | null; running: boolean }> {
  const body = await request<{ chat: ChatConversation | null; running: boolean }>(`/api/chats/${chatId}`);
  return { chat: body.chat, running: body.running };
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  await request(`/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
}

export async function stopChat(chatId: string): Promise<void> {
  await request(`/api/chats/${chatId}/stop`, { method: "POST" });
}

export async function listAutomations(): Promise<Automation[]> {
  return (await request<{ automations: Automation[] }>("/api/automations")).automations;
}

export async function listHooks(): Promise<Hook[]> {
  return (await request<{ hooks: Hook[] }>("/api/hooks")).hooks;
}

export async function listConnections(): Promise<Connection[]> {
  return (await request<{ connections: Connection[] }>("/api/connections")).connections;
}

export async function listSkills(): Promise<Skill[]> {
  return (await request<{ skills: Skill[] }>("/api/skills")).skills;
}

export async function listChannels(): Promise<Channel[]> {
  return (await request<{ channels: Channel[] }>("/api/channels")).channels;
}

export async function getModel(): Promise<ModelInfo> {
  return (await request<{ model: ModelInfo }>("/api/model")).model;
}

async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(body.error ?? `request_failed_${response.status}`, response.status);
  return body;
}
