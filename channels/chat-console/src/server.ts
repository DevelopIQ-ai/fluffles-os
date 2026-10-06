import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  SingleFlightTask,
  booleanEnv,
  channelErrorMessage,
  channelErrorStatusCode,
  channelHttpError,
  channelRequestPathname,
  createChannelRouter,
  defineChannel,
  numberEnv,
  parseChannelJsonBody,
  readChannelRequestBody,
  sendChannelJson,
  type ChannelRouteHandler
} from "@fluffles/tasks";
import { ConsoleAuth } from "./auth";
import { ledgerPath, stateRoot } from "./config";
import { LedgerChatStore, type ChatChannel, type ConversationFilters, type ConversationStatus } from "./ledger-store";
import { loadAutomations, loadConnections, loadHooks, loadSkills, modelInfo } from "./registries";
import { WebChannel, type WebChatEvent } from "./web-channel";

const host = process.env.HOST || "127.0.0.1";
const port = numberEnv(process.env.PORT, 3004, 1, 65535);
const maxBodyBytes = numberEnv(process.env.CHAT_CONSOLE_MAX_BODY_BYTES, 256 * 1024, 1024, 4 * 1024 * 1024);
const recoveryIntervalMs = numberEnv(process.env.CHAT_CONSOLE_RECOVERY_INTERVAL_MS, 30_000, 1000, 60 * 60 * 1000);
const processIntervalMs = numberEnv(process.env.CHAT_CONSOLE_PROCESS_INTERVAL_MS, 15_000, 1000, 60 * 60 * 1000);
const processLimit = numberEnv(process.env.CHAT_CONSOLE_PROCESS_LIMIT, 5, 1, 25);
/** The built Next.js export, with the legacy static console as the fallback. */
const webRoot = firstExistingDir([
  path.resolve(__dirname, "..", "web", "out"),
  path.resolve(__dirname, "..", "..", "web", "out"),
  path.resolve(__dirname, "..", "public"),
  path.resolve(__dirname, "..", "..", "public")
]);
const store = new LedgerChatStore({ ledgerPath });
const auth = new ConsoleAuth(process.env.CHAT_CONSOLE_PASSWORD, booleanEnv(process.env.CHAT_CONSOLE_TRUST_LOOPBACK, false));
const webChannel = new WebChannel();
const processTask = new SingleFlightTask();

async function processTick(): Promise<unknown> {
  return processTask.run<unknown>(async () => {
    try {
      return { ok: true, result: await webChannel.processQueued(processLimit) };
    } catch (error) {
      console.error(channelErrorMessage(error));
      return { ok: false, error: channelErrorMessage(error) };
    }
  }, () => ({ ok: true, skipped: "process_already_running" }));
}

/**
 * The console is a channel too, so its process lifecycle is the shared one:
 * boot order, hosted HTTP, repeated lease recovery, one-shot CLI flags, and
 * graceful shutdown come from defineChannel. Only the console's own surface
 * lives here, because it serves a UI and browser APIs rather than a signed
 * provider webhook.
 */
const channel = defineChannel({
  service: "fluffles-chat-console",
  signals: "always",
  http: {
    host,
    port,
    handle: (request, response) => {
      void Promise.resolve(route(request, response)).catch((error) => {
        sendJson(response, channelErrorStatusCode(error), { ok: false, error: channelErrorMessage(error) });
      });
    },
    onListen: () => {
      console.log(JSON.stringify({ ok: true, service: "fluffles-chat-console", listening: `http://${host}:${port}`, ...status() }));
    }
  },
  // A browser run whose lease outlives a crash is reclaimed on the next sweep,
  // not stranded until this process happens to restart again.
  recovery: {
    intervalMs: recoveryIntervalMs,
    recover: (options) => webChannel.recover(options),
    onError: (error) => {
      console.error(channelErrorMessage(error));
    }
  },
  boot: async () => {
    await mkdir(path.join(stateRoot, "logs"), { recursive: true });
  },
  afterStart: () => {
    void processTick();
    // The listening socket owns process lifetime; the tick must not keep a
    // closed console alive on its own.
    setInterval(() => { void processTick(); }, processIntervalMs).unref();
  },
  shutdown: () => {
    store.close();
    webChannel.close();
  },
  commands: [
    {
      flag: "--status",
      run: async () => {
        console.log(JSON.stringify(status(), null, 2));
        store.close();
        webChannel.close();
      }
    }
  ]
});

function status(): Record<string, unknown> {
  return {
    ledgerPath,
    ledgerExists: existsSync(ledgerPath),
    webRoot,
    passwordConfigured: auth.configured,
    chats: store.snapshot().byChannel.web.total,
    queuedChats: webChannel.queuedChats
  };
}

/**
 * The probe and the sign-in routes, which have to answer before a caller has a
 * session. Everything else falls through the auth gate.
 */
const route = createChannelRouter({
  routes: [
    // `/healthz` is the probe every channel answers; `/api/healthz` is the same
    // payload under the prefix the browser app uses for everything else.
    { method: "GET", path: "/healthz", handle: sendHealth },
    { method: "GET", path: "/api/healthz", handle: sendHealth },
    {
      method: "GET",
      path: "/api/session",
      handle: (request, response) => {
        const decision = auth.authorize(request);
        sendJson(response, 200, { ok: true, authenticated: decision.ok, reason: decision.reason, passwordConfigured: auth.configured });
      }
    },
    {
      method: "POST",
      path: "/api/session",
      handle: async (request, response) => {
        const body = await readJsonBody(request);
        const token = auth.signIn(request, stringField(body, "password"));
        if (!token) {
          sendJson(response, 401, { ok: false, error: "invalid_password" });
          return;
        }
        response.setHeader("set-cookie", auth.sessionCookie(token, isHttps(request)));
        sendJson(response, 200, { ok: true, authenticated: true });
      }
    },
    {
      method: "DELETE",
      path: "/api/session",
      handle: (request, response) => {
        auth.signOut(request);
        response.setHeader("set-cookie", auth.clearedCookie());
        sendJson(response, 200, { ok: true, authenticated: false });
      }
    }
  ],
  notFound: (request, response) => authorized(request, response)
});

/**
 * A browser without a session still gets the app shell, because that is where
 * the sign-in form lives; only the API refuses outright.
 */
const authorized: ChannelRouteHandler = async (request, response) => {
  const decision = auth.authorize(request);
  if (decision.ok) return consoleRoute(request, response);
  const pathname = channelRequestPathname(request);
  if (pathname.startsWith("/api/")) {
    sendJson(response, 401, { ok: false, error: "sign_in_required", reason: decision.reason });
    return;
  }
  serveStatic(pathname, response);
};

/** The console's own surface, reached only with a session. */
const consoleRoute = createChannelRouter({
  routes: [
    {
      method: "GET",
      path: "/api/snapshot",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, snapshot: store.snapshot() }); }
    },
    {
      method: "GET",
      path: "/api/conversations",
      handle: (request, response) => {
        sendJson(response, 200, { ok: true, conversations: store.listConversations(filtersFromQuery(requestUrl(request).searchParams)) });
      }
    },
    {
      method: "GET",
      path: "/api/conversation",
      handle: (request, response) => {
        const params = requestUrl(request).searchParams;
        const channel = channelFromQuery(params.get("channel"));
        const key = params.get("key") || "";
        if (!channel || !key) {
          sendJson(response, 400, { ok: false, error: "channel_and_key_required" });
          return;
        }
        const conversation = store.getConversation(channel, key);
        if (!conversation) {
          sendJson(response, 404, { ok: false, error: "conversation_not_found" });
          return;
        }
        sendJson(response, 200, { ok: true, conversation });
      }
    },
    {
      method: "GET",
      path: "/api/automations",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, automations: loadAutomations() }); }
    },
    {
      method: "GET",
      path: "/api/hooks",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, hooks: loadHooks() }); }
    },
    {
      method: "GET",
      path: "/api/connections",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, connections: loadConnections() }); }
    },
    {
      method: "GET",
      path: "/api/skills",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, skills: loadSkills() }); }
    },
    {
      method: "GET",
      path: "/api/model",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, model: modelInfo() }); }
    },
    {
      method: "GET",
      path: "/api/channels",
      handle: (_request, response) => {
        const snapshot = store.snapshot();
        sendJson(response, 200, {
          ok: true,
          channels: [
            { id: "web", name: "Chat console", conversations: snapshot.byChannel.web.total },
            { id: "slack", name: "Slack", conversations: snapshot.byChannel.slack.total },
            { id: "email", name: "Email", conversations: snapshot.byChannel.email.total },
            { id: "phone", name: "Phone", conversations: snapshot.byChannel.phone.total }
          ]
        });
      }
    },
    {
      method: "GET",
      path: "/api/chats",
      handle: (request, response) => {
        sendJson(response, 200, { ok: true, chats: store.listConversations({ channels: ["web"], limit: chatLimit(requestUrl(request)) }) });
      }
    },
    {
      method: "GET",
      path: "/api/chats/new",
      handle: (_request, response) => { sendJson(response, 200, { ok: true, chatId: webChannel.newChatId() }); }
    }
  ],
  // Per-chat paths carry an id, so they are matched here rather than in the
  // table; an unmatched GET is a UI path served from the static export.
  notFound: async (request, response) => {
    const pathname = channelRequestPathname(request);
    const method = request.method || "GET";

    if (method === "GET") {
      const chatId = chatIdFromPath(pathname, "");
      if (chatId) {
        const chat = store.getConversation("web", `web:${chatId}`);
        sendJson(response, 200, { ok: true, chatId, chat, running: webChannel.isRunning(chatId) });
        return;
      }
      const eventsChatId = chatIdFromPath(pathname, "/events");
      if (eventsChatId) {
        streamChatEvents(eventsChatId, request, response);
        return;
      }
      // An unknown API path is an error; an unknown UI path is client routing.
      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }
      serveStatic(pathname, response);
      return;
    }

    if (method === "POST") {
      const messagesChatId = chatIdFromPath(pathname, "/messages");
      if (messagesChatId) {
        const body = await readJsonBody(request);
        const result = await webChannel.send(messagesChatId, stringField(body, "text"), "console-user");
        sendJson(response, 202, { ok: true, ...result });
        return;
      }
      const stopChatId = chatIdFromPath(pathname, "/stop");
      if (stopChatId) {
        sendJson(response, 200, { ok: true, stopped: await webChannel.stop(stopChatId) });
        return;
      }
    }

    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }
});

function sendHealth(_request: IncomingMessage, response: ServerResponse): void {
  sendJson(response, 200, { ok: true, service: "fluffles-chat-console", ...status() });
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
}

/** `/api/chats/<chatId><suffix>`, or null when the path is a different route. */
function chatIdFromPath(pathname: string, suffix: string): string | null {
  const match = new RegExp(`^/api/chats/([A-Za-z0-9_-]{1,64})${suffix.replace("/", "/")}$`).exec(pathname);
  const chatId = match?.[1];
  if (!chatId || chatId === "new") return null;
  return chatId;
}

function streamChatEvents(chatId: string, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  response.write(`: connected ${chatId}\n\n`);
  const unsubscribe = webChannel.subscribe((event: WebChatEvent) => {
    if (event.chatId !== chatId) return;
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on("close", close);
  response.on("close", close);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = parseChannelJsonBody(await readChannelRequestBody(request, maxBodyBytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw channelHttpError("request_body_must_be_a_json_object", 400);
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw channelHttpError(`${key}_required`, 400);
  return value;
}

function chatLimit(url: URL): number {
  return numberFromQuery(url.searchParams.get("limit")) ?? 100;
}

function filtersFromQuery(params: URLSearchParams): ConversationFilters {
  const filters: ConversationFilters = {};
  const channels = channelsFromQuery(params.get("channel"));
  const status = statusFromQuery(params.get("status"));
  const search = params.get("search")?.trim();
  const limit = numberFromQuery(params.get("limit"));
  const offset = numberFromQuery(params.get("offset"));
  if (channels) filters.channels = channels;
  if (status) filters.status = status;
  if (search) filters.search = search;
  if (limit != null) filters.limit = limit;
  if (offset != null) filters.offset = offset;
  return filters;
}

function serveStatic(requestPath: string, response: ServerResponse): void {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(webRoot, relative);
  if (resolved !== webRoot && !resolved.startsWith(`${webRoot}${path.sep}`)) {
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return;
  }
  // A static export serves `/foo` from `foo.html` or `foo/index.html`, and any
  // unknown path falls back to the app shell so client routing still works.
  const filePath = [resolved, `${resolved}.html`, path.join(resolved, "index.html"), path.join(webRoot, "index.html")]
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!filePath) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(filePath),
    "cache-control": filePath.endsWith(".html") ? "no-store" : "public, max-age=60"
  });
  createReadStream(filePath).pipe(response);
}

/** Console responses reflect live ledger state, so none of them are cacheable. */
function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.setHeader("cache-control", "no-store");
  sendChannelJson(response, statusCode, body);
}

function isHttps(request: IncomingMessage): boolean {
  return String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim() === "https";
}

function firstExistingDir(candidates: string[]): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1] ?? process.cwd();
}

function channelsFromQuery(value: string | null): ChatChannel[] | undefined {
  if (!value || value === "all") return undefined;
  const channels = value.split(",").map((item) => channelFromQuery(item.trim())).filter((item): item is ChatChannel => Boolean(item));
  return channels.length > 0 ? channels : undefined;
}

function channelFromQuery(value: string | null): ChatChannel | null {
  if (value === "slack" || value === "email" || value === "phone" || value === "web") return value;
  return null;
}

function statusFromQuery(value: string | null): ConversationStatus | "all" | undefined {
  if (!value || value === "all") return "all";
  if (value === "queued" || value === "running" || value === "done" || value === "failed" || value === "stopped") return value;
  return "all";
}

function numberFromQuery(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

channel.start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  store.close();
  webChannel.close();
  process.exit(1);
});
