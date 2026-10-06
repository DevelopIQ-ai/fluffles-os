# browser

Browser operating context for the harness, under `state/` with the rest of
the runtime data. Browser state is still special: it carries cookies, web
login state, downloads, screenshots, profiles, and automation config, so it
is never synced into git beyond this structural skeleton.

```text
/Users/ai/state/browser
├── profiles/
│   └── fluffles/
├── downloads/
├── screenshots/
├── scratch/
└── tools/
    └── agent-browser/
        ├── config/
        └── home/
```

Rules:

- Browser profiles and web login state live here.
- Durable credentials belong in Infisical. Disposable browser sessions and provider-managed OAuth state may remain local only as tracked in `packages/auth/INFISICAL.md`.
- Tool metadata for browser automation still lives under `/Users/ai/tools`.
- agent-browser runs with scoped `HOME=/Users/ai/state/browser/tools/agent-browser/home`, so its upstream-native `.agent-browser` state stays inside the browser tree.
