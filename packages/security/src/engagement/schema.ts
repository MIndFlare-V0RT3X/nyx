// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.2 — the engagement FILE schema (engagements/<id>.yaml).
//
// The file is the operator's signed authorization: what may be tested, in
// which window, under which rate limits, and with which attack classes. The
// loader maps it onto the frozen protocol `Engagement` (the shape that
// crosses process boundaries); everything here is load-time validation — a
// file that fails this schema never becomes a session's scope.

import { z } from "zod";
import type {
  Engagement,
  EngagementRateLimits,
  EngagementTechnique,
} from "@nyx/protocol";

/** ISO-8601 timestamps with a mandatory zone (Z or ±hh:mm). */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Rate-limit class keys: "default" or a tool class like "ffuf", "nmap". */
const RATE_CLASS_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ENGAGEMENT_SCHEMA_VERSION = 1;

/**
 * One rate-limit bucket. Exactly one unit must be declared: HTTP-class tools
 * consume `requests_per_second`; packet-class tools (nmap) consume
 * `packets_per_second`. Mixing units in one entry is refused — the limiter
 * must know what it is counting.
 */
const rateLimitEntrySchema = z
  .object({
    requests_per_second: z.number().int().min(1).max(100_000).optional(),
    packets_per_second: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict()
  .refine(
    (entry) =>
      (entry.requests_per_second !== undefined) !== (entry.packets_per_second !== undefined),
    "a rate limit must declare exactly one of requests_per_second or packets_per_second",
  );

export const SecurityEngagementFileSchema = z
  .object({
    schema: z.literal(ENGAGEMENT_SCHEMA_VERSION),
    id: z.string().min(1).max(128),
    client: z.string().min(1).max(200),
    operator_id: z.string().min(1).max(200),
    signed_at: z.string().regex(ISO_TIMESTAMP, "ISO-8601 timestamp with zone"),
    authorized_by: z.string().min(1).max(200),
    emergency_contact: z.string().min(3).max(200),
    window: z
      .object({
        start: z.string().regex(ISO_TIMESTAMP, "ISO-8601 timestamp with zone"),
        end: z.string().regex(ISO_TIMESTAMP, "ISO-8601 timestamp with zone"),
      })
      .strict(),
    targets: z
      .object({
        domains: z.array(z.string().min(1)).max(1_000).default([]),
        cidrs: z.array(z.string().min(1)).max(1_000).default([]),
        urls: z.array(z.string().min(1)).max(1_000).default([]),
      })
      .strict(),
    exclusions: z
      .object({
        domains: z.array(z.string().min(1)).max(1_000).default([]),
        cidrs: z.array(z.string().min(1)).max(1_000).default([]),
      })
      .strict()
      .default({}),
    rate_limits: z.record(rateLimitEntrySchema).default({}),
    allowed_techniques: z
      .array(
        z.enum([
          "reconnaissance",
          "port_scanning",
          "web_enumeration",
          "vulnerability_scanning",
          "exploitation",
          "social_engineering",
        ]),
      )
      .max(32)
      .default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const start = Date.parse(file.window.start);
    const end = Date.parse(file.window.end);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window", "end"],
        message: "window.end must be strictly after window.start",
      });
    }
    const targetCount =
      file.targets.domains.length + file.targets.cidrs.length + file.targets.urls.length;
    if (targetCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "an engagement must declare at least one target (domains, cidrs, or urls)",
      });
    }
    for (const key of Object.keys(file.rate_limits)) {
      if (!RATE_CLASS_KEY.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rate_limits", key],
          message: `rate limit class "${key}" must match ${RATE_CLASS_KEY.source}`,
        });
      }
    }
  });

export type SecurityEngagementFile = z.infer<typeof SecurityEngagementFileSchema>;

/**
 * Map a validated engagement file onto the frozen protocol `Engagement`.
 * `exclusions` fold into `targets.exclude`; `window` becomes
 * `starts_at`/`expires_at` (Unix ms); the file's `client` becomes the
 * engagement `title` (the operator-facing name) and is preserved verbatim in
 * `client` for reports.
 */
export function fileToEngagement(file: SecurityEngagementFile): Engagement {
  const rateLimits: EngagementRateLimits = {};
  for (const [key, entry] of Object.entries(file.rate_limits)) {
    rateLimits[key] = entry;
  }
  const techniques: EngagementTechnique[] = [...file.allowed_techniques];
  return {
    id: file.id,
    title: file.client,
    operator_id: file.operator_id,
    authorized_at: Date.parse(file.signed_at),
    starts_at: Date.parse(file.window.start),
    expires_at: Date.parse(file.window.end),
    targets: {
      domains: [...file.targets.domains],
      cidrs: [...file.targets.cidrs],
      urls: [...file.targets.urls],
      exclude: {
        domains: [...file.exclusions.domains],
        cidrs: [...file.exclusions.cidrs],
      },
    },
    techniques,
    ...(Object.keys(rateLimits).length > 0 ? { rate_limits: rateLimits } : {}),
    client: file.client,
    authorized_by: file.authorized_by,
    emergency_contact: file.emergency_contact,
  };
}
