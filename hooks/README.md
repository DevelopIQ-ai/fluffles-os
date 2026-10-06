# hooks

Canonical hook registry for the harness.

Hooks are event handlers owned by the local harness. Tool-specific locations such as `/Users/ai/.codex/hooks.json` may still exist when a host tool requires them, but the source of truth should live here.

```text
/Users/ai/hooks
└── codex/
    ├── README.md
    ├── hooks.json
    └── bin/
        ├── breadcrumb-hook
        ├── memory-context
        ├── session-time
        └── smoke-test
```

Rules:

- Keep stable hook entrypoints in this tree.
- Let wrappers here call tool payloads under `/Users/ai/tools`.
- Do not put raw secrets in hook manifests or scripts.
- If a host tool requires a dotfile entrypoint, make that path point here and document it in the relevant hook README.
