# chat console

The browser channel. Talk to Fluffles from a browser, and read every other
channel's conversations from the same central ledger.

## paths

- code: `/Users/ai/channels/chat-console`
- browser app: `/Users/ai/channels/chat-console/web` (Next.js, static export in `web/out`)
- central task ledger: `/Users/ai/state/tasks/tasks.sqlite`
- default port: `3004`
- secrets: Infisical `/services/chat-console`

## run

```sh
cd /Users/ai/channels/chat-console
npm test
npm run check     # typecheck the server and build web/out
npm start
npm start -- --status   # print ledger, web root, and chat counts, then exit
```

Process plumbing is the shared channel scaffolding described in
`channels/README.md`: `loadChannelEnv("chat-console")` for env file precedence
(Infisical injection always wins, and a local file may never set
`CHAT_CONSOLE_PASSWORD`), and `defineChannel` for hosted HTTP, startup and
periodic lease recovery of interrupted browser runs, `--status`, and graceful
shutdown. There is no provider to poll and no webhook to verify, so the console
composes that layer directly instead of `defineChannelService`.

The server serves `web/out` when it exists and falls back to the legacy
`public/` console when it does not, so a host that has not built the export
still gets a working read-only console.

## api

```text
GET    /healthz               GET /api/healthz
GET    /api/session          POST /api/session      DELETE /api/session
GET    /api/snapshot
GET    /api/conversations?channel=all&status=all&search=&limit=200
GET    /api/conversation?channel=phone&key=...
GET    /api/automations       GET /api/hooks
GET    /api/connections       GET /api/skills
GET    /api/model             GET /api/channels
GET    /api/chats             GET /api/chats/new
GET    /api/chats/<id>        GET /api/chats/<id>/events   (SSE)
POST   /api/chats/<id>/messages
POST   /api/chats/<id>/stop
```

A browser chat is the conversation key `web:<chatId>`, so intake, run state,
outbound deliveries, and the durable Codex session all live in the central
ledger exactly as they do for Slack, email, and phone. The registry routes read
`automations/`, `hooks/`, `tools/mcp/manifests/`, and `skills/` from the
deployed source, so the panes show what this host actually has installed.

## access

The console listens on `0.0.0.0:3004`. Every client signs in with the shared
password in `CHAT_CONSOLE_PASSWORD` (Infisical `/services/chat-console`),
exchanged for an httpOnly session cookie, and with no password configured the
console refuses every request rather than serving openly.

The peer address earns no trust, because Tailscale on macOS forwards tailnet
connections through userspace networking: a browser on another device reaches
the console as `127.0.0.1`, so a loopback exemption would hand the console to
every machine on the tailnet. `CHAT_CONSOLE_TRUST_LOOPBACK=1` opts back into
address trust and is only safe on a host with no such forwarder.

The launchd job injects that secret through `infisical-run`, so the deployed
console has the password. The Infisical folder must exist before the service
starts: `infisical run` exits non-zero on a missing folder, so a declared
`secretsPath` with nothing behind it in the vault is a launchd crash loop, not a
console that serves without a password.

Remote access is a tailnet: the mini and your own devices join the same
Tailscale network, and the console is reachable at the mini's tailnet address
without exposing anything to the public internet.

```sh
# once, on the mini, as an admin who can approve the machine
brew install --cask tailscale
tailscale up --hostname fluffles-mini

# from any device on the same tailnet
open http://fluffles-mini:3004
```

Nothing about the service changes for a tailnet: the tailnet address is just
another non-loopback client, which is why the password is required there.
