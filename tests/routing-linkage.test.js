import { describe, expect, it } from "vitest"
import {
  matchesTierModel,
  routingLinkageHelperSource,
  sequenceOf,
  toolIdentity,
} from "../scripts/routing-linkage.mjs"

describe("routing linkage helpers", () => {
  it("uses a complete tool identity tuple and fails closed for missing fields", () => {
    expect(toolIdentity({ sessionID: "session", messageID: "message", id: "call", tool: "subagent" }))
      .toBe("session/message/call/subagent")

    for (const field of ["sessionID", "messageID", "id", "tool"]) {
      const event = { sessionID: "session", messageID: "message", id: "call", tool: "subagent" }
      delete event[field]
      expect(toolIdentity(event)).toBeUndefined()
    }
    expect(toolIdentity({ sessionID: "session", messageID: "message", id: "", tool: "subagent" })).toBeUndefined()
    expect(toolIdentity(undefined)).toBeUndefined()
  })

  it("accepts only integer synchronous sequences without coercion", () => {
    expect(sequenceOf({ seq: 0 })).toBe(0)
    expect(sequenceOf({ seq: 17 })).toBe(17)
    expect(sequenceOf({ seq: "17" })).toBeUndefined()
    expect(sequenceOf({ seq: 1.5 })).toBeUndefined()
    expect(sequenceOf({ seq: undefined })).toBeUndefined()
  })

  it("matches exact provider, model, and variant aliases while rejecting malformed values", () => {
    expect(matchesTierModel("provider/model#fast", { model: "provider/model", variant: "fast" })).toBe(true)
    expect(matchesTierModel({ providerID: "provider", id: "model", variant: "fast" }, "provider/model#fast")).toBe(true)
    expect(matchesTierModel({ providerID: "provider", id: "model" }, { providerID: "provider", id: "model" })).toBe(true)

    expect(matchesTierModel("provider/model#fast", { model: "provider/model", variant: "slow" })).toBe(false)
    expect(matchesTierModel("provider/model", { model: "provider/model", variant: "fast" })).toBe(false)
    expect(matchesTierModel("provider/model#fast#extra", "provider/model#fast")).toBe(false)
    expect(matchesTierModel({ providerID: "", id: "model" }, "provider/model")).toBe(false)
    expect(matchesTierModel({ providerID: "provider", id: "model", variant: 1 }, "provider/model")).toBe(false)
    expect(matchesTierModel("provider/model", { model: "provider/model", variant: null })).toBe(false)
  })

  it("emits a self-contained source block for copied observer plugins", () => {
    const source = routingLinkageHelperSource()
    expect(source).toContain("function createRoutingLinkageHelpers()")
    expect(source).toContain("const { matchesTierModel, sequenceOf, toolIdentity, validateNativeLinkage, validateNativeToolEvidence }")
    expect(source).not.toContain("from \"./routing-linkage.mjs\"")
  })
})
