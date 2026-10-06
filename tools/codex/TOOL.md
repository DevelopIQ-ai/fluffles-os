# codex

Codex CLI, installed and upgraded through Homebrew (`brew install --cask codex`).

- command: `/Users/ai/bin/codex`
- registry: `/Users/ai/tools/codex`
- binary: `/Users/ai/homebrew/bin/codex`
- auth: Infisical path `/services/codex` injects `CODEX_AUTH_JSON`
- local state: `/Users/ai/.codex` for disposable sessions, hooks, and host-owned runtime state

Use this for Codex sessions and local agent state. The wrapper builds a mode-`700` temporary `CODEX_HOME` containing the native non-secret configuration, hooks, plugins, skills, and required runtime metadata, plus an Infisical-backed `auth.json`. It removes the temporary home only after the provider process tree exits, and validates any successful auth refresh before writeback.
