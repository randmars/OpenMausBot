import { describe, expect, it } from "vitest";

import { canDispatchHive, coordinationNativeToolStatus, isCoordinationOnlyRole, organizationRoutingOverlay } from "./org-policy.ts";

describe("organization runtime policy", () => {
  it("classifies coordination roles and allows hive dispatch only for them", () => {
    expect(isCoordinationOnlyRole("leader")).toBe(true);
    expect(isCoordinationOnlyRole("worker")).toBe(false);
    expect(canDispatchHive("domain-lead")).toBe(true);
    expect(canDispatchHive("worker")).toBe(false);
  });

  it("reports native restriction support explicitly", () => {
    expect(coordinationNativeToolStatus("leader", { sessionModelSwitch: "unsupported", coordinationOnlyNativeTools: true })).toBe("supported");
    expect(coordinationNativeToolStatus("leader", { sessionModelSwitch: "unsupported", coordinationOnlyNativeTools: false })).toBe("unsupported");
    expect(coordinationNativeToolStatus("worker", { sessionModelSwitch: "unsupported" })).toBe("not-required");
    expect(coordinationNativeToolStatus(undefined, undefined)).toBe("not-required");
  });

  it("adds current routing context only to coordination profiles", () => {
    const overlay = organizationRoutingOverlay("domain-lead", "Domain Leads");
    expect(overlay).toContain("Organization routing overlay (DEV-3388, current)");
    expect(overlay).toContain("legacy builder or dispatcher routing text");
    expect(overlay).toContain("native driver restrictions and backend capability checks enforce permissions");
    expect(organizationRoutingOverlay("worker", "Projects")).toBe("");
  });
});
