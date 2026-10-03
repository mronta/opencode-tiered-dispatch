import { describe, expect, it } from "vitest"
import { buildDelegatedPermissions } from "../src/permissions.js"

describe("buildDelegatedPermissions", () => {
  it("preserves caller restrictions and blocks nested delegation", () => {
    const rules = buildDelegatedPermissions(
      "medium",
      [{ action: "*", resource: "*", effect: "allow" }],
      [{ action: "edit", resource: "*", effect: "deny" }],
    )
    expect(rules.findLast((rule) => rule.action === "edit")?.effect).toBe("deny")
    expect(rules.findLast((rule) => rule.action === "subagent")?.effect).toBe("deny")
  })

  it("makes fast read-only after caller allow rules", () => {
    const rules = buildDelegatedPermissions("fast", [{ action: "*", resource: "*", effect: "allow" }], [])
    expect(rules.findLast((rule) => rule.action === "*")?.effect).toBe("deny")
    expect(rules.findLast((rule) => rule.action === "read")?.effect).toBe("allow")
    expect(rules.findLast((rule) => rule.action === "edit")?.effect).toBeUndefined()
  })

  it("keeps caller read restrictions stronger than the fast baseline", () => {
    const rules = buildDelegatedPermissions(
      "fast",
      [{ action: "read", resource: "secrets/*", effect: "deny" }],
      [{ action: "read", resource: "docs/*", effect: "ask" }],
    )
    expect(rules.findLast((rule) => rule.resource === "secrets/*")?.effect).toBe("deny")
    expect(rules.findLast((rule) => rule.resource === "docs/*")?.effect).toBe("ask")
  })

  it("does not let a caller mutation prompt weaken fast denial", () => {
    const rules = buildDelegatedPermissions(
      "fast",
      [{ action: "edit", resource: "*", effect: "ask" }],
      [{ action: "shell", resource: "*", effect: "ask" }],
    )
    const wildcardDeny = rules.findLastIndex((rule) => rule.action === "*")
    expect(rules.findLastIndex((rule) => rule.action === "edit")).toBeLessThan(wildcardDeny)
    expect(rules.findLastIndex((rule) => rule.action === "shell")).toBeLessThan(wildcardDeny)
    expect(rules[wildcardDeny]?.effect).toBe("deny")
  })
})
