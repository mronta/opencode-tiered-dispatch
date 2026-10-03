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
})
