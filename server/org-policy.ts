import type { ProviderAdapter } from "./contracts.ts";

/** Persisted role labels are intentionally strings for backwards-compatible
 * imports. These are the roles with coordination authority in the cutover. */
export const COORDINATION_ONLY_ROLES = new Set([
  "leader",
  "coordination",
  "domain-lead",
  "project-owner",
  "harness-steward",
]);

export type CoordinationNativeToolStatus = "not-required" | "supported" | "unsupported";

export function isCoordinationOnlyRole(orgRole?: string): boolean {
  return typeof orgRole === "string" && COORDINATION_ONLY_ROLES.has(orgRole.trim().toLowerCase());
}

export function coordinationNativeToolStatus(
  orgRole: string | undefined,
  capabilities?: ProviderAdapter["capabilities"],
): CoordinationNativeToolStatus {
  if (!isCoordinationOnlyRole(orgRole)) return "not-required";
  return capabilities?.coordinationOnlyNativeTools === true ? "supported" : "unsupported";
}

export function canDispatchHive(orgRole?: string): boolean {
  return isCoordinationOnlyRole(orgRole);
}

/** Canonical routing context for coordination profiles. This is appended to
 * the preserved bot instructions at prompt-build time; it never replaces a
 * soul, transcript, description, or provider-native permission boundary. */
export function organizationRoutingOverlay(orgRole?: string, section?: string): string {
  if (!isCoordinationOnlyRole(orgRole)) return "";
  const role = orgRole!.trim();
  const group = typeof section === "string" && section.trim() ? section.trim() : "unassigned";
  return [
    "\n\nOrganization routing overlay (DEV-3388, current):",
    ` Your persisted organization role is ${role} in ${group}.`,
    " Coordinate, review, and dispatch bounded assignments through the authenticated hive tools; do not implement assigned work yourself.",
    " Linear is the product-development system of record. Preserve source identity, ownership, acceptance evidence, and existing conversation history when routing work.",
    " Any legacy builder or dispatcher routing text in preserved profile instructions is historical and superseded by this current organization routing.",
    " This overlay supplies routing context only; native driver restrictions and backend capability checks enforce permissions.",
  ].join("");
}
