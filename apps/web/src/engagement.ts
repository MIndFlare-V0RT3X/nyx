// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers for the "new session" form: parsing the optional engagement
// fields into the wire Engagement shape (and reporting problems client-side;
// the server remains the authority via the 400 error envelope).

import type { Engagement } from "./types.js";

export interface EngagementFormInput {
  id: string;
  /** Comma-separated CIDR blocks. */
  cidrs: string;
  /** Comma-separated domain suffixes. */
  domains: string;
  /** Whole hours until expiry, e.g. "12". */
  expiryHours: string;
  title?: string;
  /** Who authorized the engagement; defaults to the owner actor. */
  operatorId?: string;
}

export interface EngagementFormResult {
  engagement?: Engagement;
  problems: string[];
}

const HOUR_MS = 3_600_000;

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const DEFAULT_OPERATOR_ID = "owner";

/**
 * Parses the engagement form. `now` (Unix ms) anchors authorized_at and the
 * expiry; passing it in keeps this pure and testable.
 */
export function parseEngagementForm(input: EngagementFormInput, now: number): EngagementFormResult {
  const problems: string[] = [];
  const id = input.id.trim();
  const cidrs = splitList(input.cidrs);
  const domains = splitList(input.domains);
  const hours = input.expiryHours.trim();

  if (id.length === 0) problems.push("engagement id is required");
  const expiryHours = Number(hours);
  if (hours.length === 0 || !Number.isFinite(expiryHours) || expiryHours <= 0) {
    problems.push("expiry hours must be a positive number");
  }
  if (problems.length > 0) return { problems };

  const engagement: Engagement = {
    id,
    operator_id: (input.operatorId ?? DEFAULT_OPERATOR_ID).trim() || DEFAULT_OPERATOR_ID,
    authorized_at: now,
    expires_at: now + Math.round(expiryHours * HOUR_MS),
    targets: { cidrs, domains },
    ...(input.title !== undefined && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
  };
  return { engagement, problems: [] };
}
