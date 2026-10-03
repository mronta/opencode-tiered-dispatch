import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { assertAgentsAvailable, assertModelsAvailable } from "./catalog.js"
import {
  createDispatcher,
  type AgentRecord,
  type DispatchRuntime,
  type SessionRecord,
} from "./dispatch.js"
import { ConfigurationError } from "./errors.js"
import { parseOptions } from "./options.js"
import { buildRoutingProtocol } from "./protocol.js"

const TOOL_NAME = "tiered_dispatch"

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["fast", "medium", "heavy"] },
    description: { type: "string", description: "A short label for the delegated task" },
    prompt: { type: "string", description: "The complete, narrowly scoped task for the delegated agent" },
  },
  required: ["tier", "description", "prompt"],
  additionalProperties: false,
} as const

const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["fast", "medium", "heavy"] },
    model: { type: "string" },
    sessionID: { type: "string" },
    text: { type: "string" },
  },
  required: ["tier", "model", "sessionID", "text"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "tiered-dispatch",

  async setup(ctx) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return

    const [modelCatalog, agentCatalog] = await Promise.all([
      ctx.model.list(),
      ctx.agent.list(),
    ])
    const models = modelCatalog.data.map((model) => ({
      providerID: model.providerID,
      id: model.id,
      enabled: model.enabled,
      capabilities: { tools: model.capabilities.tools },
      variants: model.variants.map((variant) => ({ id: variant.id })),
    }))
    const agents = agentCatalog.data.map((agent) => ({
      id: agent.id,
      mode: agent.mode,
      permissions: agent.permissions,
    }))

    assertModelsAvailable(options, models)
    const subagentIDs = assertAgentsAvailable(agents)
    const runtime = createRuntime(ctx)
    const dispatcher = createDispatcher(runtime, options, subagentIDs)

    let toolRegistration: { dispose(): Promise<void> } | undefined
    let contextRegistration: { dispose(): Promise<void> } | undefined

    try {
      const currentTools = await ctx.tool.list()
      if (currentTools.some((tool) => tool.id === TOOL_NAME)) {
        throw new ConfigurationError(`Cannot register ${TOOL_NAME}: another tool already owns that name`)
      }

      toolRegistration = await ctx.tool.transform((editor) => {
        editor.add({
          name: TOOL_NAME,
          description: "Delegate a narrowly scoped task to the configured fast, medium, or heavy model tier",
          input: TOOL_INPUT_SCHEMA,
          output: TOOL_OUTPUT_SCHEMA,
          execute: async (input, toolContext) => {
            const result = await dispatcher.execute(input, {
              sessionID: toolContext.sessionID,
              agent: toolContext.agent,
              signal: toolContext.signal,
              progress: (update) => toolContext.progress(update),
            })
            return {
              content: result.content,
              output: result.output,
              metadata: result.metadata,
            }
          },
        })
      })

      contextRegistration = await ctx.session.hook("context", (event) => {
        if (subagentIDs.has(event.agent)) {
          delete event.tools[TOOL_NAME]
          return
        }
        event.system.push({ type: "text", text: buildRoutingProtocol(options) })
      })
    } catch (error) {
      await Promise.allSettled([
        contextRegistration?.dispose(),
        toolRegistration?.dispose(),
        dispatcher.cleanup(),
      ])
      throw error
    }

    return async () => {
      await Promise.allSettled([
        contextRegistration?.dispose(),
        toolRegistration?.dispose(),
        dispatcher.cleanup(),
      ])
    }
  },
})

function createRuntime(ctx: Context): DispatchRuntime {
  return {
    async listModels() {
      const result = await ctx.model.list()
      return result.data.map((model) => ({
        providerID: model.providerID,
        id: model.id,
        enabled: model.enabled,
        capabilities: { tools: model.capabilities.tools },
        variants: model.variants.map((variant) => ({ id: variant.id })),
      }))
    },

    async getSession(sessionID) {
      return toSessionRecord(await ctx.session.get({ sessionID }))
    },

    async getAgent(agentID) {
      const result = await ctx.agent.get({ agentID })
      return toAgentRecord(result.data)
    },

    async createSession(input) {
      const session = await ctx.session.create({
        title: input.title,
        agent: input.agent,
        model: input.model,
        location: input.location,
        metadata: input.metadata,
        permissions: input.permissions,
      })
      return toSessionRecord(session)
    },

    async prompt(sessionID, text) {
      await ctx.session.prompt({ sessionID, text, resume: true })
    },

    async wait(sessionID, signal) {
      await ctx.session.wait({ sessionID }, { signal })
    },

    async context(sessionID) {
      return ctx.session.context({ sessionID })
    },

    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID, resume: false })
    },
  }
}

function toSessionRecord(
  session: Awaited<ReturnType<Context["session"]["get"]>>,
): SessionRecord {
  return {
    id: session.id,
    location: { directory: session.location.directory },
    ...(session.subpath === undefined ? {} : { subpath: session.subpath }),
    ...(session.permissions === undefined ? {} : { permissions: session.permissions }),
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  }
}

function toAgentRecord(
  agent: Awaited<ReturnType<Context["agent"]["get"]>>["data"],
): AgentRecord {
  return {
    id: agent.id,
    permissions: agent.permissions,
  }
}
