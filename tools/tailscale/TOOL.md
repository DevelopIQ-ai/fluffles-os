# tailscale

Tailscale is installed with the Homebrew formula at `/Users/ai/homebrew/opt/tailscale`.

The mac app cask requires an admin password, so this setup uses a rootless userspace daemon launched by:

`/Users/ai/Library/LaunchAgents/com.puffle.fluffles.tailscaled.userspace.plist`

Runtime state lives in `/Users/ai/state/tools/tailscale`.

Use `/Users/ai/bin/tailscale`; the wrapper points the cli at the userspace daemon socket:

`/Users/ai/state/tools/tailscale/tailscaled.socket`

Proxy listeners:

- SOCKS5: `127.0.0.1:1055`
- HTTP: `127.0.0.1:1056`

For system-wide vpn routing on macOS, install `tailscale-app` with admin approval and use the official app instead of this rootless userspace daemon.
