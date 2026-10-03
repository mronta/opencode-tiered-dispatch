/**
 * Native-delegation correlation shared by the evaluator and the generated
 * observer.  The implementation lives in one self-contained factory so the
 * observer can embed the exact same rules in its isolated plugin source.
 */
function createRoutingLinkageHelpers() {
  function validateNativeLinkage({
    dispatches = [],
    tools = [],
    sessions = [],
    contexts = [],
    rootSessionID,
    tierModels,
    afterByIdentity = new Map(tools
      .filter((event) => event?.phase === "after")
      .flatMap((event) => {
        const identity = toolIdentity(event)
        return identity === undefined ? [] : [[identity, event]]
      })),
    requireCompleted = false,
    validateTierModels = true,
  }) {
    const problems = []
    const completions = new Map()
    const sessionByID = new Map(sessions.filter((session) => typeof session?.sessionID === "string").map((session) => [session.sessionID, session]))
    const contextsByID = new Map()
    for (const context of contexts) {
      if (!contextsByID.has(context?.sessionID)) contextsByID.set(context?.sessionID, [])
      contextsByID.get(context?.sessionID).push(context)
    }

    const established = new Map()
    const linkedSessionIDs = new Set()
    let previousDelegation
    for (const dispatch of dispatches) {
      const identity = toolIdentity(dispatch)
      const completion = identity === undefined ? undefined : afterByIdentity.get(identity)
      if (identity !== undefined && completion !== undefined) completions.set(identity, completion)
      const agent = dispatch.input?.agent
      if (typeof agent !== "string") problems.push(`native delegation ${String(identity)} did not specify an agent`)
      if (validateTierModels && tierModels?.[agent] === undefined) problems.push(`native delegation ${String(identity)} used unknown tier ${String(agent)}`)

      const dispatchSequence = sequenceOf(dispatch)
      const previousSequence = previousDelegation === undefined
        ? undefined
        : sequenceOf(previousDelegation.completion ?? previousDelegation.dispatch)
      if (dispatchSequence !== undefined && previousSequence !== undefined && dispatchSequence < previousSequence) {
        problems.push("recovery or execution began before the previous execution returned")
      }

      if (completion === undefined) {
        problems.push(`native delegation ${String(agent)} did not complete`)
        continue
      }
      if (completion.status !== "completed") {
        if (requireCompleted) problems.push(`native delegation ${String(agent)} did not complete successfully`)
        continue
      }

      const rawStructured = completion.result?.output
      const recordedStructured = completion.resultOutput
      const structured = recordedStructured !== undefined ? recordedStructured : rawStructured
      if (recordedStructured !== undefined && rawStructured !== undefined && !sameJSON(recordedStructured, rawStructured)) {
        problems.push(`native delegation ${String(agent)} has inconsistent recorded result.output`)
      }
      const rawMetadata = completion.result?.metadata
      const recordedMetadata = completion.resultMetadata
      const metadata = recordedMetadata !== undefined ? recordedMetadata : rawMetadata
      if (recordedMetadata !== undefined && rawMetadata !== undefined && !sameJSON(recordedMetadata, rawMetadata)) {
        problems.push(`native delegation ${String(agent)} has inconsistent recorded result.metadata`)
      }
      if (!isRecord(structured) || typeof structured.sessionID !== "string" || structured.sessionID.length === 0 || !["completed", "running"].includes(structured.status) || typeof structured.output !== "string") {
        problems.push(`native delegation ${String(agent)} is missing structured result.output {sessionID,status,output}; resultText is not correlation evidence`)
        continue
      }
      if (structured.status === "running") {
        problems.push(`native delegation ${String(agent)} returned pending/background status running; foreground evidence is unverifiable`)
      }
      if (!isRecord(metadata)) {
        problems.push(`native delegation ${String(agent)} is missing structured result.metadata for child ${structured.sessionID}`)
      } else if (metadata.sessionID !== structured.sessionID || metadata.status !== structured.status) {
        problems.push(`native delegation ${String(agent)} has inconsistent result.metadata for child ${structured.sessionID}`)
      }

      const inputSessionID = dispatch.input?.sessionID
      const childID = structured.sessionID
      const existingOwner = established.get(childID)
      if (inputSessionID !== undefined) {
        if (typeof inputSessionID !== "string" || inputSessionID.length === 0) {
          problems.push(`native delegation ${String(agent)} supplied an invalid continuation sessionID`)
        } else if (!established.has(inputSessionID)) {
          problems.push(`native delegation ${String(agent)} resumed an unestablished child session ${inputSessionID}`)
        } else if (established.get(inputSessionID) !== agent) {
          problems.push(`native delegation ${String(agent)} resumed child ${inputSessionID} owned by tier ${String(established.get(inputSessionID))}`)
        } else if (inputSessionID !== childID) {
          problems.push(`native delegation ${String(agent)} returned child ${childID} for continuation ${inputSessionID}`)
        }
      } else if (existingOwner !== undefined) {
        problems.push(`native delegation ${String(agent)} reused child session ${childID} without explicit continuation linkage`)
      }

      const session = sessionByID.get(childID)
      if (session === undefined) {
        problems.push(`native delegation ${String(agent)} returned unobserved child session ${childID}`)
      } else {
        if (session.parentID !== rootSessionID) problems.push(`native delegation ${String(agent)} returned nested or non-root child ${childID}`)
        const childContexts = contextsByID.get(childID) ?? []
        const completionSequence = sequenceOf(completion)
        const relevantContexts = childContexts.filter((context) => {
          const contextSequence = sequenceOf(context)
          return dispatchSequence !== undefined
            && completionSequence !== undefined
            && contextSequence !== undefined
            && contextSequence > dispatchSequence
            && contextSequence < completionSequence
        })
        if (relevantContexts.length === 0) {
          problems.push(`native delegation ${String(agent)} returned child ${childID} without an execution context between dispatch ${String(dispatchSequence)} and completion ${String(completionSequence)}`)
        }
        for (const context of relevantContexts) {
          if (context.agent !== agent) problems.push(`native delegation ${String(agent)} correlated to child ${childID} with context agent ${String(context.agent)}`)
          if (validateTierModels && !matchesTierModel(context.model, tierModels?.[agent], context.variant)) {
            problems.push(`native delegation ${String(agent)} child session used an unexpected model or variant`)
          }
        }
        if (session.agent !== undefined && session.agent !== agent) problems.push(`native delegation ${String(agent)} correlated to child ${childID} with mismatched session agent`)
      }
      established.set(childID, agent)
      linkedSessionIDs.add(childID)
      previousDelegation = { dispatch, completion }
    }

    for (const session of sessions) {
      if (session?.sessionID !== rootSessionID && typeof session?.sessionID === "string" && !linkedSessionIDs.has(session.sessionID)) {
        problems.push(`observed non-root session ${session.sessionID} did not belong to a correlated native delegation`)
      }
    }
    for (const context of contexts) {
      if (context?.sessionID !== rootSessionID && typeof context?.sessionID === "string" && !linkedSessionIDs.has(context.sessionID)) {
        problems.push(`observed non-root context ${context.sessionID} did not belong to a correlated native delegation`)
      }
    }
    for (const event of [...tools]) {
      if (event.sessionID !== rootSessionID && !linkedSessionIDs.has(event.sessionID)) {
        problems.push(`observed non-root tool session ${event.sessionID} did not belong to a correlated native delegation`)
      }
    }

    return { problems, completions, linkedSessionIDs }
  }

  /**
   * Validate the root's native call lifecycle before a verifier is allowed to
   * execute.  The general evaluator validates every tool phase; this narrower
   * pure gate is intentionally limited to native delegation calls.
   */
  function validateNativeToolEvidence(tools, rootSessionID) {
    const problems = []
    const nativeEvents = tools.filter((event) => (event?.phase === "before" || event?.phase === "after") && event?.tool === "subagent")
    const before = nativeEvents.filter((event) => event.phase === "before")
    const after = nativeEvents.filter((event) => event.phase === "after")
    const beforeByIdentity = new Map()
    const afterByIdentity = new Map()
    const seenSequences = new Set()
    for (const event of nativeEvents) {
      if (event.sessionID !== rootSessionID) {
        problems.push(`nested or unattributed native delegation from session ${String(event.sessionID)}`)
      }
      const sequence = sequenceOf(event)
      if (sequence === undefined) problems.push("tool subagent is missing its synchronous sequence")
      else if (seenSequences.has(sequence)) problems.push(`duplicate native delegation sequence: ${sequence}`)
      else seenSequences.add(sequence)
      const missing = ["sessionID", "messageID", "id", "tool"].filter((field) => typeof event[field] !== "string" || event[field].length === 0)
      if (missing.length > 0) {
        problems.push(`tool subagent is missing identity fields: ${missing.join(", ")}`)
        continue
      }
      const target = event.phase === "before" ? beforeByIdentity : afterByIdentity
      const identity = toolIdentity(event)
      if (target.has(identity)) problems.push(`duplicate ${event.phase} native delegation identity: ${identity}`)
      else target.set(identity, event)
    }
    for (const event of after) {
      const identity = toolIdentity(event)
      const beforeEvent = beforeByIdentity.get(identity)
      const eventSequence = sequenceOf(event)
      const beforeSequence = sequenceOf(beforeEvent)
      if (beforeEvent === undefined) problems.push(`orphan tool completion: ${identity}`)
      else if (eventSequence !== undefined && beforeSequence !== undefined && eventSequence <= beforeSequence) problems.push(`tool completion preceded its call: ${identity}`)
      if (event.status !== "completed") problems.push(`failed tool completion: ${identity} (${String(event.status)})`)
    }
    for (const event of before) {
      if (!afterByIdentity.has(toolIdentity(event))) problems.push(`missing tool completion: ${toolIdentity(event)}`)
    }
    return problems
  }

  function toolIdentity(event) {
    const fields = [event?.sessionID, event?.messageID, event?.id, event?.tool]
    return fields.every((field) => typeof field === "string" && field.length > 0)
      ? fields.join("/")
      : undefined
  }

  function sequenceOf(event) {
    return Number.isInteger(event?.seq) ? event.seq : undefined
  }

  function matchesTierModel(observedModel, expectedConfig, observedVariant) {
    const actual = normalizeModel(observedModel, observedVariant)
    const expected = normalizeExpectedModel(expectedConfig)
    return actual !== undefined && expected !== undefined
      && actual.providerID === expected.providerID
      && actual.id === expected.id
      && actual.variant === expected.variant
  }

  function normalizeExpectedModel(value) {
    if (typeof value === "string") return normalizeModel(value)
    if (!isRecord(value)) return undefined
    if (typeof value.model === "string") return normalizeModel(value.model, value.variant)
    if (typeof value.providerID === "string" && typeof value.id === "string") return normalizeModel(value)
    return undefined
  }

  function normalizeModel(value, variant) {
    if (!isValidVariant(variant)) return undefined
    if (typeof value === "string") {
      const hash = value.indexOf("#")
      const reference = hash === -1 ? value : value.slice(0, hash)
      const embeddedVariant = hash === -1 ? undefined : value.slice(hash + 1)
      if (hash !== -1 && value.indexOf("#", hash + 1) !== -1) return undefined
      const separator = reference.indexOf("/")
      if (separator <= 0 || separator === reference.length - 1) return undefined
      const selectedVariant = variant === undefined ? embeddedVariant : variant
      if (!isValidVariant(selectedVariant)) return undefined
      return {
        providerID: reference.slice(0, separator),
        id: reference.slice(separator + 1),
        ...(selectedVariant === undefined ? {} : { variant: selectedVariant }),
      }
    }
    if (isRecord(value) && typeof value.providerID === "string" && value.providerID.length > 0 && typeof value.id === "string" && value.id.length > 0) {
      if (Object.prototype.hasOwnProperty.call(value, "variant") && !isValidVariant(value.variant)) return undefined
      const selectedVariant = variant === undefined ? value.variant : variant
      if (!isValidVariant(selectedVariant)) return undefined
      return {
        providerID: value.providerID,
        id: value.id,
        ...(selectedVariant === undefined ? {} : { variant: selectedVariant }),
      }
    }
    return undefined
  }

  function isValidVariant(value) {
    return value === undefined || (typeof value === "string" && value.length > 0)
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  function sameJSON(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }

  return {
    matchesTierModel,
    sequenceOf,
    toolIdentity,
    validateNativeLinkage,
    validateNativeToolEvidence,
  }
}

const routingLinkageHelpers = createRoutingLinkageHelpers()
export const matchesTierModel = routingLinkageHelpers.matchesTierModel
export const sequenceOf = routingLinkageHelpers.sequenceOf
export const toolIdentity = routingLinkageHelpers.toolIdentity
export const validateNativeLinkage = routingLinkageHelpers.validateNativeLinkage
export const validateNativeToolEvidence = routingLinkageHelpers.validateNativeToolEvidence

// The factory has no closure dependencies, so its source is safe to embed in
// the copied observer plugin without importing this repository-local module.
const ROUTING_LINKAGE_HELPER_SOURCE = [
  `const routingLinkageHelpers = (${createRoutingLinkageHelpers.toString()})()`,
  "const { matchesTierModel, sequenceOf, toolIdentity, validateNativeLinkage, validateNativeToolEvidence } = routingLinkageHelpers",
].join("\n")

export function routingLinkageHelperSource() {
  return ROUTING_LINKAGE_HELPER_SOURCE
}
