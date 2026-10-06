# chat console web

The browser interface for talking to Fluffles. Next.js, Tailwind 4, shadcn/ui,
and Vercel AI Elements for the Codex transcript.

It ships as a static export (`next build` writes `out/`), which the console
server in `../src/server.ts` serves beside its own API on port 3004. Everything
stateful lives behind that API: chats are `web:<chatId>` conversations in the
central task ledger, and replies come from the canonical Codex executor.

```bash
npm run build --prefix ..     # typecheck the server, install here, export out/
npm start --prefix ..         # serve the export and the API on :3004
```

The app calls its API same-origin, so iterate by rebuilding the export rather
than running `next dev` on another port.
