# communications

Communications awareness tool.

- command: `/Users/ai/bin/communications`
- source: `/Users/ai/communications`
- state: `/Users/ai/state/communications`
- snapshot: `/Users/ai/state/communications/current.json`

Use this to answer which communication surfaces are active in the harness right now.

Common commands:

```sh
/Users/ai/bin/communications current
/Users/ai/bin/communications current --json
/Users/ai/bin/communications sessions
/Users/ai/bin/communications surfaces
```

Current coverage:

- live Codex sessions from open session file handles under `/Users/ai/.codex/sessions`
- Slack adapter status and Slack thread sessions from `/Users/ai/state/channels/slack`
- Email adapter status from `/Users/ai/state/channels/email`
- Phone adapter status from `/Users/ai/state/channels/phone`

iMessage is represented as explicit-use only.
