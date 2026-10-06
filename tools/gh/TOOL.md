# gh

GitHub CLI for the Fluffles GitHub account.

- command: `/Users/ai/bin/gh`
- account: `fluffles-puffle-ai`
- email: `fluffles@puffle.ai`
- registry: `/Users/ai/tools/gh`
- auth: Infisical path `/services/github-gh` injects only `GITHUB_TOKEN`; deployment SSH uses `/services/github` and receives only its active private key
- non-secret state: `/Users/ai/state/tools/gh/config`
- installed by: Homebrew under `/Users/ai/homebrew`
- git SSH: `/Users/ai/bin/github-ssh` loads only the active approved deploy key into a private `ssh-agent` for a single GitHub-only SSH invocation, so the key is never written to disk

Use this for GitHub authentication, repositories, issues, pull requests, releases, and API calls. `gh` receives only `GITHUB_TOKEN`; the SSH child receives only its temporary key. Do not print raw auth tokens or credential files.
