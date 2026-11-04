// SPDX-License-Identifier: AGPL-3.0-or-later
// Acceptance tests for the engagement operator ↔ session-owner binding
// (Phase 1 hardening 2.3): a mismatched pair is a hard error naming both ids;
// a matched pair passes.
import { describe, expect, it } from "vitest";
import type { Engagement } from "@nyx/protocol";
import { EngagementOwnershipError, assertEngagementOwnership } from "./ownership.js";

const now = Date.now();

function engagementFor(operatorId: string): Engagement {
  return {
    id: "ENG-42",
    operator_id: operatorId,
    authorized_at: now - 1000,
    expires_at: now + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
  };
}

describe("engagement ownership binding", () => {
  it("a mismatched pair throws EngagementOwnershipError naming both ids", () => {
    expect(() => assertEngagementOwnership(engagementFor("alice"), "bob")).toThrow(
      EngagementOwnershipError,
    );
    expect(() => assertEngagementOwnership(engagementFor("alice"), "bob")).toThrow(
      /engagement ENG-42 is authorized for operator "alice" but the session owner is "bob"/,
    );
    const err = (() => {
      try {
        assertEngagementOwnership(engagementFor("alice"), "bob");
      } catch (e) {
        return e;
      }
    })() as EngagementOwnershipError;
    expect(err.code).toBe("engagement_ownership");
    expect(err.name).toBe("EngagementOwnershipError");
    expect(err.message).toContain("alice");
    expect(err.message).toContain("bob");
    expect(err.message).toContain("ENG-42");
  });

  it("a matched pair passes (both directions of the check agree)", () => {
    expect(() => assertEngagementOwnership(engagementFor("owner"), "owner")).not.toThrow();
    expect(() => assertEngagementOwnership(engagementFor("telegram:123456"), "telegram:123456"))
      .not.toThrow();
  });
});
