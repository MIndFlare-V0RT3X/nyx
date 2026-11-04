// SPDX-License-Identifier: AGPL-3.0-or-later
// Engagement ownership binding: an engagement authorizes work for exactly one
// operator. The check lives here — not in a channel adapter or a route — so
// every entry point that binds an engagement to a session (CLI session
// creation, server session creation, future channels) gets the same hard
// error: an engagement uploaded by one operator cannot authorize actions in
// another operator's session.

import { CodedError } from "./errors.js";
import type { Engagement } from "@nyx/protocol";

/** Thrown when an engagement's operator does not match the session owner. */
export class EngagementOwnershipError extends CodedError {
  constructor(engagementId: string, engagementOperator: string, sessionOwner: string) {
    super(
      "engagement_ownership",
      `engagement ${engagementId} is authorized for operator "${engagementOperator}" ` +
        `but the session owner is "${sessionOwner}"; an engagement can only authorize ` +
        "its own operator's sessions",
    );
    this.name = "EngagementOwnershipError";
  }
}

/**
 * Verify `engagement.operator_id === owner_id` for the session being created.
 * Mismatch is a hard error (EngagementOwnershipError naming both ids); a
 * match returns normally.
 */
export function assertEngagementOwnership(engagement: Engagement, owner_id: string): void {
  if (engagement.operator_id !== owner_id) {
    throw new EngagementOwnershipError(engagement.id, engagement.operator_id, owner_id);
  }
}
