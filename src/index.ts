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
    const models = modelCatalog.data.map(toModelCatalogEntry)
    const agents = agentCatalog.data.map((agent) => ({
      id: agent.id,
      mode: agent.mode,
      permissions: agent.permissions,
    }))

    assertModelsAvailable(options, models)
    const subagentIDs = assertAgentsAvailable(agents)
    const routingProtocol = buildRoutingProtocol(options)
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
            try {
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
            } catch (error) {
              if (toolContext.signal.aborted) throwCancellation(toolContext.signal)
              throw error
            }
          },
        })
      })

      contextRegistration = await ctx.session.hook("context", async (event) => {
        if (subagentIDs.has(event.agent)) {
          delete event.tools[TOOL_NAME]
          return
        }
        try {
          if (await dispatcher.isOwnedSession(event.sessionID)) {
            delete event.tools[TOOL_NAME]
            return
          }
        } catch (error) {
          // Fail closed if ownership cannot be established. Injecting the
          // protocol into an owned child is more dangerous than temporarily
          // omitting it from an otherwise eligible root request.
          delete event.tools[TOOL_NAME]
          if (options.logging) console.error("[tiered-dispatch] could not inspect session ownership", error)
          return
        }
        event.system.push({ type: "text", text: routingProtocol })
      })
    } catch (error) {
      try {
        await disposeAll([
          contextRegistration?.dispose(),
          toolRegistration?.dispose(),
          dispatcher.cleanup(),
        ])
      } catch (cleanupError) {
        if (options.logging) console.error("[tiered-dispatch] setup cleanup failed", cleanupError)
      }
      throw error
    }

    return async () => {
      await disposeAll([
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
      return result.data.map(toModelCatalogEntry)
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

    async prompt(sessionID, text, signal) {
      // The V2 Promise adapter does not reliably turn request-option
      // cancellation into a rejected session operation. Cancellation is
      // propagated through the explicit interrupt path in the dispatcher.
      void signal
      await ctx.session.prompt({ sessionID, text, resume: true })
    },

    async wait(sessionID, signal) {
      void signal
      await ctx.session.wait({ sessionID })
    },

    async context(sessionID) {
      return ctx.session.context({ sessionID })
    },

    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID, resume: false })
    },
  }
}

type ModelInfo = Awaited<ReturnType<Context["model"]["list"]>>["data"][number]

function toModelCatalogEntry(model: ModelInfo) {
  return {
    providerID: model.providerID,
    id: model.id,
    enabled: model.enabled,
    capabilities: { tools: model.capabilities.tools },
    variants: model.variants.map((variant) => ({ id: variant.id })),
  }
}

function toSessionRecord(
  session: Awaited<ReturnType<Context["session"]["get"]>>,
): SessionRecord {
  return {
    id: session.id,
    location: { directory: session.location.directory },
    ...(session.subpath === undefined ? {} : { subpath: session.subpath }),
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
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

function throwCancellation(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException("Delegation was cancelled", "AbortError")
}

async function disposeAll(operations: readonly (Promise<unknown> | void | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, "Tiered Dispatch could not dispose every registration")
  }
}
