# Non-secret Executor MCP endpoint for the phone channel, derived from the
# host declaration in deploy/hosts so the value exists in exactly one place.
PHONE_EXECUTOR_MCP_URL="$("${home}/homebrew/bin/node" --input-type=module -e '
import { resolveHost, hostServices } from "'"${home}"'/deploy/lib/host.mjs";
const host = resolveHost({ home: "'"${home}"'" });
const phone = hostServices(host).find((service) => service.name === "phone");
if (!phone?.env.PHONE_EXECUTOR_MCP_URL) {
  console.error("executor-mcp-url: this host does not declare a phone Executor MCP url");
  process.exit(78);
}
process.stdout.write(phone.env.PHONE_EXECUTOR_MCP_URL);
')"
