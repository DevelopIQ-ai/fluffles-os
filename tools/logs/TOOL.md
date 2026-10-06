# logs

Log inventory and safe log access for the harness on the Mac Mini.

- command: `/Users/ai/bin/logs`
- registry: `/Users/ai/tools/logs`
- source: `/Users/ai/tools/logs/bin/logs.ts`
- state inspected: `/Users/ai/state`, `/Users/ai/Library/LaunchAgents`, selected `/var/log` files, selected Amalgm runtime logs

## commands

```sh
/Users/ai/bin/logs health
/Users/ai/bin/logs inventory
/Users/ai/bin/logs launchd
/Users/ai/bin/logs tail slack-stderr
/Users/ai/bin/logs tail webhooks
```

## access model

This tool reads harness-owned logs and launchd state. It does not read raw auth secrets or token files.

macOS unified logs require the process running the harness to have Full Disk Access. If `/usr/bin/log show` returns `Operation not permitted`, the harness can still read its own log files, but it does not have full Mac Mini unified-log visibility.
