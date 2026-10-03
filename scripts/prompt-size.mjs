import { getEncoding } from "js-tiktoken"
import { TIER_AGENT_DEFINITIONS } from "../dist/agents.js"
import { parseOptions } from "../dist/options.js"
import { buildRoutingProtocol } from "../dist/protocol.js"

const encoding = getEncoding("o200k_base")
const prompts = {
  primary: buildRoutingProtocol(parseOptions({})),
  ...Object.fromEntries(Object.entries(TIER_AGENT_DEFINITIONS).map(([tier, definition]) => [tier, definition.system])),
}
console.log("Plugin-added prompt tokens (o200k_base proxy; not the full host prompt or provider billing):")
for (const [name, text] of Object.entries(prompts)) {
  console.log(`${name}: ${encoding.encode(text).length} tokens, ${text.length} characters`)
}
