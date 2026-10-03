import { describe, expect, it } from "vitest"
import {
  counterbalancedArmOrder,
  quantile,
  summarizeMatchedBenchmark,
  summarizeRoutingTrace,
} from "../scripts/routing-metrics.mjs"

function trace(overrides = {}) {
  return {
    id: "known-scope",
    rootSessionID: "root",
    executionStartedAt: 100,
    executionElapsedMs: 80,
    verifierElapsedMs: 10,
    harnessOverheadMs: 5,
    elapsedMs: 95,
    tools: [],
    contexts: [{ sessionID: "root", seq: 0 }],
    sessions: [{ sessionID: "root", tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 1.25, usage: [{ tokens: { input: 10 } }] }],
    ...overrides,
  }
}

describe("routing metrics", () => {
  it("keeps token categories and numeric Money.USD costs separate", () => {
    const result = summarizeRoutingTrace(trace({
      sessions: [
        {
          sessionID: "root",
          agent: "build",
          tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
          cost: 1.25,
          usage: [{ messageID: "request-root", model: { providerID: "openai", id: "gpt-root", variant: "medium" }, tokens: { input: 10 }, cost: 1.25 }],
        },
        {
          sessionID: "child",
          agent: "medium",
          tokens: { input: 20, output: 5, reasoning: 6, cache: { read: 7, write: 2 } },
          cost: 2,
          usage: [{ messageID: "request-child", model: { providerID: "openai", id: "gpt-child", variant: "max" }, tokens: { input: 20 }, cost: 2 }],
        },
      ],
    }))
    expect(result.usage.root.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 })
    expect(result.usage.tiers.medium.costUSD).toBe(2)
    expect(result.costUSD).toBe(3.25)
    expect(result.tokens).toEqual({ input: 30, output: 9, reasoning: 8, cacheRead: 10, cacheWrite: 3 })
    expect(result.modelCallCounts).toEqual({ root: 1, children: 1 })
    expect(result.usage.byModel["openai/gpt-root#medium"]).toMatchObject({
      model: { providerID: "openai", id: "gpt-root", variant: "medium" },
      calls: 1,
      costUSD: 1.25,
    })
    expect(result.usage.byRequest["request-child"]).toMatchObject({
      requestID: "request-child",
      model: { providerID: "openai", id: "gpt-child", variant: "max" },
    })
  })

  it("leaves missing token components and costs unknown rather than zero", () => {
    const result = summarizeRoutingTrace(trace({
      sessions: [{
        sessionID: "root",
        usage: [{ tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 1 } } }],
      }],
    }))
    expect(result.tokens).toEqual({ input: 3, output: 2, reasoning: 0, cacheRead: 1, cacheWrite: null })
    expect(result.costUSD).toBeNull()
  })

  it("keeps missing model/request identity in explicit unknown attribution buckets", () => {
    const result = summarizeRoutingTrace(trace({
      sessions: [{
        sessionID: "root",
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
        cost: 0,
        usage: [{ tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, cost: 0 }],
      }],
    }))
    expect(result.usage.byModel.unknown).toMatchObject({ model: null, calls: 1, costUSD: 0 })
    expect(result.usage.byRequest.unknown).toMatchObject({ requestID: null, model: null, calls: 1, costUSD: 0 })
  })

  it("uses captured execution models for fallback usage without fabricating request ids", () => {
    const result = summarizeRoutingTrace(trace({
      sessions: [
        {
          sessionID: "root",
          model: { providerID: "openai", id: "actual-root", variant: "fast" },
          infoModel: { providerID: "openai", id: "selected-but-unobserved" },
          tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
          cost: 0,
          outcome: "succeeded",
        },
        {
          sessionID: "failed-child",
          model: { providerID: "openai", id: "actual-child" },
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 2.5,
          outcome: "failed",
        },
      ],
    }))
    expect(result.usage.byModel["openai/actual-root#fast"]).toMatchObject({
      model: { providerID: "openai", id: "actual-root", variant: "fast" },
      modelProvenance: "execution-context",
      costUSD: 0,
    })
    expect(result.usage.byModel["openai/selected-but-unobserved"]).toBeUndefined()
    expect(result.usage.byRequest.unknown).toMatchObject({ requestID: null, calls: 2, costUSD: 2.5 })
    expect(result.usage.byRequest.unknown.model).toBeNull()
    expect(result.usage.byRequest.unknown.modelProvenance).toBe("execution-context")
  })

  it("measures ordered delegation timing and handoff proxy units", () => {
    const result = summarizeRoutingTrace(trace({
      tools: [
        { phase: "before", seq: 1, observedAt: 150, sessionID: "root", messageID: "m1", id: "t1", tool: "subagent", input: { agent: "fast", prompt: "find src/controller.js" } },
        { phase: "after", seq: 2, observedAt: 200, sessionID: "root", messageID: "m1", id: "t1", tool: "subagent", status: "completed", resultOutput: { sessionID: "fast-child", status: "completed", output: "Evidence: src/controller.js" } },
        { phase: "before", seq: 3, observedAt: 220, sessionID: "root", messageID: "m2", id: "t2", tool: "subagent", input: { agent: "medium", prompt: "use src/controller.js" } },
        { phase: "after", seq: 4, observedAt: 280, sessionID: "root", messageID: "m2", id: "t2", tool: "subagent", status: "completed", resultOutput: { sessionID: "medium-child", status: "completed", output: "done" } },
      ],
    }))
    expect(result.timeToFirstDelegationMs).toBe(50)
    expect(result.dispatchDurations.map((dispatch) => dispatch.durationMs)).toEqual([50, 60])
    expect(result.handoffs[0]).toMatchObject({ from: "fast", to: "medium", promptChars: 21, evidenceChars: 27, tokenizer: "o200k_base" })
    expect(result.handoffs[0].promptTokens).toBeGreaterThan(0)
  })

  it("uses linear quantiles and keeps small-n p95 explicit", () => {
    expect(quantile([1, 2, 3], 0.5)).toBe(2)
    expect(quantile([1, 2, 3], 0.95)).toBe(2.9)
    expect(quantile([7], 0.95)).toBe(7)
    expect(quantile([], 0.95)).toBeNull()
  })

  it("retains failed samples and gates ratios on both arms and a valid denominator", () => {
    const direct = trace({ elapsedMs: 10, executionElapsedMs: 10, sessions: [{ sessionID: "root", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] })
    const tiered = trace({ elapsedMs: 40, executionElapsedMs: 40, sessions: [{ sessionID: "root", cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] })
    const summary = summarizeMatchedBenchmark([
      { arm: "direct", repetition: 0, startupMs: 5, results: [direct], reports: [{ id: "known-scope", problems: [] }], errors: [] },
      { arm: "tiered", repetition: 0, startupMs: 7, results: [tiered], reports: [{ id: "known-scope", problems: [] }], errors: [] },
      { arm: "direct", repetition: 1, startupMs: 9, results: [trace({ elapsedMs: 30, executionElapsedMs: 30, sessions: [{ sessionID: "root", cost: 5, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] })], reports: [{ id: "known-scope", problems: ["failed objective"] }], errors: [] },
      { arm: "tiered", repetition: 2, startupMs: 8, results: [trace({ elapsedMs: 50, executionElapsedMs: 50, sessions: [{ sessionID: "root", cost: 2, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] })], reports: [{ id: "known-scope", problems: [] }], errors: [] },
    ], { scenarioIDs: ["known-scope"] })
    const matched = summary.scenarioSummaries[0]
    expect(matched.arms.direct).toMatchObject({ n: 2, successes: 1, failures: 1 })
    expect(matched.arms.tiered).toMatchObject({ n: 2, successes: 2, failures: 0 })
    expect(matched.arms.direct.quantiles.executionMs.p50).toBe(10)
    expect(matched.arms.direct.quantiles.startupMs.p50).toBe(5)
    expect(matched.arms.direct.usage.root.costUSD.total).toBe(5)
    expect(matched.arms.direct.usage.byModel.unknown.costUSD.total).toBe(5)
    expect(summary.comparisons[0].sampleCounts).toMatchObject({ direct: 2, tiered: 2, matchedAttempts: 1, matchedSuccessfulPairs: 1, matched: 1 })
    expect(summary.comparisons[0].ratios.costUSD.tieredOverDirectP50).toBeNull()
    expect(summary.comparisons[0].ratios.executionMs.tieredOverDirectP50).toBe(4)
  })

  it("counterbalances deterministically", () => {
    expect(counterbalancedArmOrder(0)).toEqual(["tiered", "direct"])
    expect(counterbalancedArmOrder(1)).toEqual(["direct", "tiered"])
    expect(counterbalancedArmOrder(2)).toEqual(["tiered", "direct"])
  })
})
