// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.0.4 acceptance: creating a domain-only engagement writes an
// engagement.created audit row that includes the initial DNS resolution;
// CIDR-constrained engagements write a row noting the constraint; resolution
// failures are recorded, never thrown.

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { appendAudit, verifyAuditChain } from "./audit.js";
import {
  auditEngagementCreated,
  isDomainOnlyEngagement,
} from "./engagement-audit.js";
import type { DnsResolver, EngagementAuditDeps, ResolvedAddress } from "./engagement-audit.js";
import type { Engagement, Logger } from "@nyx/protocol";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nyx-eng-audit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function engagement(
  partial: Partial<Engagement["targets"]>,
  id = "ENG-1",
): Engagement {
  // The frozen protocol requires both arrays; "absent" is an empty array.
  return {
    id,
    operator_id: "owner",
    authorized_at: 1,
    expires_at: 9_999_999_999_999,
    targets: { cidrs: [], domains: [], ...partial },
  };
}

interface CapturedEntry {
  actor: string;
  action: string;
  payload: unknown;
}

function makeDeps(
  resolve?: DnsResolver,
): { deps: EngagementAuditDeps; entries: CapturedEntry[]; warnings: Array<[string, Record<string, unknown>]> } {
  const entries: CapturedEntry[] = [];
  const warnings: Array<[string, Record<string, unknown>]> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, ctx) => warnings.push([msg, ctx ?? {}]),
    error: () => undefined,
    child: () => logger,
  };
  return {
    deps: {
      audit: (entry) => entries.push(entry),
      logger,
      ...(resolve !== undefined ? { resolve } : {}),
      now: () => 1_234,
    },
    entries,
    warnings,
  };
}

const okResolver =
  (table: Record<string, string[]>): DnsResolver =>
  async (host): Promise<ResolvedAddress[]> =>
    (table[host] ?? []).map((address, i) => ({ address, family: i === 0 ? 4 : 6 }));

describe("isDomainOnlyEngagement", () => {
  it("domains without cidrs is domain-only; cidrs (with or without domains) is not", () => {
    expect(isDomainOnlyEngagement(engagement({ domains: ["example.com"] }))).toBe(true);
    expect(isDomainOnlyEngagement(engagement({ domains: ["example.com"], cidrs: ["10.0.0.0/8"] }))).toBe(false);
    expect(isDomainOnlyEngagement(engagement({ cidrs: ["10.0.0.0/8"] }))).toBe(false);
    expect(isDomainOnlyEngagement(engagement({}))).toBe(false);
  });
});

describe("auditEngagementCreated", () => {
  it("domain-only engagement: audit row carries the initial resolution + warning", async () => {
    const { deps, entries, warnings } = makeDeps(
      okResolver({ "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }),
    );
    await auditEngagementCreated(deps, {
      session_id: "sess-1",
      engagement: engagement({ domains: ["example.com"] }),
      owner_id: "owner",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "owner", action: "engagement.created" });
    const payload = entries[0]!.payload as {
      session_id: string;
      domain_only: boolean;
      domains: Array<{ domain: string; resolved_ips: string[] }>;
      warning: string;
    };
    expect(payload.session_id).toBe("sess-1");
    expect(payload.domain_only).toBe(true);
    expect(payload.domains).toEqual([
      {
        domain: "example.com",
        resolved_ips: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      },
    ]);
    expect(typeof payload.warning).toBe("string");
    expect(warnings.map(([msg]) => msg)).toContain("engagement.domain_only");
  });

  it("CIDR-constrained engagement: audit row notes the constraint, no resolution", async () => {
    const { deps, entries, warnings } = makeDeps(
      okResolver({ "example.com": ["93.184.216.34"] }),
    );
    await auditEngagementCreated(deps, {
      session_id: "sess-2",
      engagement: engagement({ domains: ["example.com"], cidrs: ["93.184.0.0/16"] }),
      owner_id: "owner",
    });
    expect(entries).toHaveLength(1);
    const payload = entries[0]!.payload as {
      domain_only: boolean;
      cidrs: string[];
      domains: string[];
      note: string;
    };
    expect(payload.domain_only).toBe(false);
    expect(payload.cidrs).toEqual(["93.184.0.0/16"]);
    expect(payload.domains).toEqual(["example.com"]); // plain list, not resolutions
    expect(typeof payload.note).toBe("string");
    expect(warnings).toHaveLength(0); // no warning for constrained engagements
  });

  it("resolution failure is recorded in the row, never thrown", async () => {
    const { deps, entries } = makeDeps(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(
      auditEngagementCreated(deps, {
        session_id: "sess-3",
        engagement: engagement({ domains: ["gone.example"] }),
        owner_id: "owner",
      }),
    ).resolves.toBeUndefined();
    const payload = entries[0]!.payload as {
      domains: Array<{ domain: string; resolved_ips: string[]; error: string }>;
    };
    expect(payload.domains[0]!.resolved_ips).toEqual([]);
    expect(payload.domains[0]!.error).toContain("ENOTFOUND");
  });

  it("empty resolution (timeout shape) is recorded as an error note", async () => {
    const { deps, entries } = makeDeps(async () => []);
    await auditEngagementCreated(deps, {
      session_id: "sess-4",
      engagement: engagement({ domains: ["slow.example"] }),
      owner_id: "owner",
    });
    const payload = entries[0]!.payload as {
      domains: Array<{ domain: string; resolved_ips: string[]; error?: string }>;
    };
    expect(payload.domains[0]!.resolved_ips).toEqual([]);
    expect(payload.domains[0]!.error).toMatch(/no addresses/);
  });

  it("the row lands on a real hash chain and verifies", async () => {
    const db = new Database(join(dir, "chain.db"));
    const deps: EngagementAuditDeps = {
      audit: (entry) =>
        appendAudit(db, {
          actor: entry.actor,
          action: entry.action,
          payload: entry.payload,
        }),
      resolve: okResolver({ "example.com": ["93.184.216.34"] }),
      now: () => 1,
    };
    await auditEngagementCreated(deps, {
      session_id: "sess-5",
      engagement: engagement({ domains: ["example.com"] }),
      owner_id: "owner",
    });
    expect(verifyAuditChain(db).ok).toBe(true);
    const row = db
      .prepare("SELECT action FROM audit ORDER BY id DESC LIMIT 1")
      .get() as { action: string };
    expect(row.action).toBe("engagement.created");
    db.close();
  });
});
