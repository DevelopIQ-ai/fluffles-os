const fs = require("node:fs");

const defaultChannel = process.env.SLACK_SEND_DEFAULT_CHANNEL || "C0000000001";
const knownChannels = new Map([
  ["agent-feed", "C0000000001"],
  ["#agent-feed", "C0000000001"],
  ["agent-requests", "C0000000002"],
  ["#agent-requests", "C0000000002"],
  ["agent-doctor", "C0000000003"],
  ["#agent-doctor", "C0000000003"],
]);
const requestTimeoutMs = Number(process.env.SLACK_SEND_TIMEOUT_MS || 30000);

function usage(exitCode = 2): any {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write("Usage:\n");
  out.write("  slack-send [--channel CHANNEL] [--thread TS] [--json] <message>\n");
  out.write("  slack-send --health [--json]\n\n");
  out.write("Defaults to #agent-feed. CHANNEL may be a Slack ID or #name.\n");
  process.exit(exitCode);
}

function parseArgs(argv): any {
  const options = {
    channel: defaultChannel,
    thread: null,
    json: false,
    health: false,
    messageParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--health") {
      options.health = true;
      continue;
    }
    if (arg === "--channel" || arg === "-c") {
      const value = argv[++i];
      if (!value) usage();
      options.channel = value;
      continue;
    }
    if (arg.startsWith("--channel=")) {
      options.channel = arg.slice("--channel=".length);
      continue;
    }
    if (arg === "--thread" || arg === "-t") {
      const value = argv[++i];
      if (!value) usage();
      options.thread = value;
      continue;
    }
    if (arg.startsWith("--thread=")) {
      options.thread = arg.slice("--thread=".length);
      continue;
    }
    if (arg.startsWith("-")) usage();
    options.messageParts.push(arg);
  }

  return options;
}

function readStdinIfAvailable(): any {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch (_error) {
    return "";
  }
}

async function slackApi(method, params, token): Promise<any> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    body.set(key, String(value));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    if (method === "auth.test") {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
    } else {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
    }
  } finally {
    clearTimeout(timeout);
  }

  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    const error: any = new Error(`Slack ${method} failed: ${json.error || response.status}`);
    error.slack = json;
    error.status = response.status;
    throw error;
  }
  return json;
}

async function resolveChannel(channel, token): Promise<any> {
  if (!channel) return defaultChannel;
  const normalized = channel.trim();
  const known = knownChannels.get(normalized) || knownChannels.get(normalized.replace(/^#/, ""));
  if (known) return known;
  if (/^[CDG][A-Z0-9]+$/.test(normalized)) return normalized;

  const wanted = normalized.replace(/^#/, "");
  let cursor = "";
  do {
    const response = await slackApi("conversations.list", {
      limit: 200,
      cursor,
      exclude_archived: true,
      types: "public_channel,private_channel,mpim,im",
    }, token);
    const match = (response.channels || []).find((item) => item.name === wanted || item.name_normalized === wanted);
    if (match?.id) return match.id;
    cursor = response.response_metadata?.next_cursor || "";
  } while (cursor);

  throw new Error(`Could not resolve Slack channel: ${channel}`);
}

async function health(token, jsonOutput): Promise<any> {
  const auth = await slackApi("auth.test", {}, token);
  const channel = await resolveChannel(defaultChannel, token);
  const info = await slackApi("conversations.info", { channel }, token);
  const result = {
    ok: true,
    tool: "slack-send",
    team: auth.team,
    team_id: auth.team_id,
    bot_user_id: auth.user_id,
    channel,
    channel_name: info.channel?.name || null,
  };
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`ok slack-send team=${result.team} channel=${result.channel_name || result.channel}\n`);
  }
}

async function post(options, token): Promise<any> {
  let text = options.messageParts.join(" ").trim();
  if (!text) text = readStdinIfAvailable().trim();
  if (!text) usage();

  const channel = await resolveChannel(options.channel, token);
  const message = await slackApi("chat.postMessage", {
    channel,
    text,
    thread_ts: options.thread,
  }, token);

  let permalink = null;
  try {
    const link = await slackApi("chat.getPermalink", { channel, message_ts: message.ts }, token);
    permalink = link.permalink || null;
  } catch (_error) {
    permalink = null;
  }

  const result = {
    ok: true,
    channel,
    ts: message.ts,
    thread_ts: options.thread || null,
    permalink,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${permalink || `${channel}:${message.ts}`}\n`);
  }
}

async function main(): Promise<any> {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is required");

  if (options.health) {
    await health(token, options.json);
    return;
  }
  await post(options, token);
}

main().catch((error) => {
  const detail = error.slack?.error || error.message || String(error);
  process.stderr.write(`slack-send: ${detail}\n`);
  process.exit(1);
});

export {};
