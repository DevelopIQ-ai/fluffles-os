# Fluffles Config

`context-limits.json` is the editable source-of-truth shape for channel context packs.

On the live Mac mini, edit:

```text
/Users/ai/config/context-limits.json
```

The source mirror keeps the default copy at:

```text
/Users/ai/projects/source-code/config/context-limits.json
```

Environment variables still override the JSON values when present:

```text
SLACK_CONTEXT_LIMIT
SLACK_CONTEXT_MAX_CHARS
EMAIL_CONTEXT_LIMIT
EMAIL_CONTEXT_MAX_CHARS
PHONE_CONTEXT_LIMIT
PHONE_CONTEXT_MAX_CHARS
*_SUMMARY_MAX_CHARS
*_OPEN_LOOPS_MAX_CHARS
FLUFFLES_CONTEXT_LIMITS_PATH
```
