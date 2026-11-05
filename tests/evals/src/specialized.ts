// SPDX-License-Identifier: AGPL-3.0-or-later
// The specialized eval drivers — behaviors whose observable surface is not
// (only) the session event log: rate pacing is wall-clock, CVE correlation
// and disclosure packaging are security-skill handler contracts (asserted on
// their outputs + on-disk artifact hashes), and the ownership refusal is
// structural (pre-session — there IS no event log for a session that was
// refused creation). The rigs mirror packages/security's disclosure.test.ts.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import type {
  Engagement,
  PolicyEngine,
  SessionEvent,
  ToolContext,
} from "@nyx/protocol";
import { openSessionStore } from "@nyx/session";
import { ToolRegistryImpl } from "@nyx/tools";
import {
  FindingStore,
  registerSecurityTools,
  SecurityRateLimiter,
  buildEngagementTooling,
} from "@nyx/security";
import { assertEngagementOwnership, EngagementOwnershipError } from "@nyx/policy";
import { CVE_FIXTURES_BY_HOST } from "./fixtures.js";

const T0 = 1_700_000_000_000;

interface SecurityRig {
  store: FindingStore;
  tooling: ReturnType<typeof buildEngagementTooling>;
  ctx: ToolContext;
  auditRows: Array<{ actor: string; action: string; payload: unknown }>;
}

function makeSecurityRig(
  engagement: Engagement,
  opts: { fetchImpl?: (url: string) => unknown } = {},
): SecurityRig {
  const db = new Database(":memory:");
  openSessionStore(":memory:", { db });
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, engagement_json) VALUES (?, 'owner', 'default', 'test', ?, ?, ?)",
  ).run("sess-eval", T0, T0, JSON.stringify(engagement));

  const store = new FindingStore({ db, now: () => T0 });
  const auditRows: SecurityRig["auditRows"] = [];
  const registry = new ToolRegistryImpl();
  registerSecurityTools(registry, {
    store,
    executor: {
      run: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
    },
    limiter: new SecurityRateLimiter({ now: () => T0, sleep: async () => undefined }),
    now: () => T0,
    audit: (row: { actor: string; action: string; payload: unknown }) => auditRows.push(row),
    ...(opts.fetchImpl !== undefined
      ? {
          fetchImpl: (async (url: string) => {
            const parsed = new URL(url);
            return CVE_FIXTURES_BY_HOST(parsed.hostname, `${parsed.pathname}${parsed.search}`);
          }) as never,
        }
      : {}),
  } as never);

  const policy: PolicyEngine = {
    async evaluate(req: { tool: string; risk: string }) {
      return {
        decision: "allow",
        rule_id: "eval:allow",
        action_digest: "0".repeat(64),
        summary: `${req.tool} (eval)`,
      };
    },
  } as never;
  const approvals = {
    request: async () => "allow" as const,
    resolve: async () => undefined,
    get: async () => null,
    pending: async () => [],
    consume: async () => undefined,
  } as never;

  const tooling = buildEngagementTooling(
    {
      tools: registry,
      kernel: { services: { get: () => undefined }, hooks: { on() {}, emit: async () => [] } } as never,
      policy,
      approvals,
    },
    engagement,
  );

  const events: SessionEvent[] = [];
  const ctx: ToolContext = {
    session_id: "sess-eval",
    turn_id: "eval-turn",
    call_id: "eval-call",
    sandbox: {
      id: "eval-sbx",
      workdir: "/tmp/eval",
      async exec() {
        return { exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false };
      },
      readFile: async (_p: string) => Buffer.from(""),
      writeFile: async () => undefined,
      list: async () => [],
      destroy: async () => undefined,
    },
    signal: new AbortController().signal,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    emit: (e: SessionEvent) => events.push(e),
    engagement,
  } as never as ToolContext;

  return { store, tooling, ctx, auditRows };
}

// ---------------------------------------------------------------------------
// rate_limit
// ---------------------------------------------------------------------------

export interface RateLimitSetup {
  rate: { rps: number; calls: number; min_elapsed_ms: number };
  engagement: Engagement;
}

export interface RateLimitResult {
  elapsed_ms: number;
  call_count: number;
}

/** GCRA buckets start EMPTY (strict rate, no burst): call 1 is immediate,
 *  calls 2..N each wait for the bucket — the wall-clock pacing IS the
 *  observable behavior (real clock, real sleeps). */
export async function runRateLimitEval(setup: RateLimitSetup): Promise<RateLimitResult> {
  const limiter = new SecurityRateLimiter();
  const started = Date.now();
  for (let i = 0; i < setup.rate.calls; i += 1) {
    await limiter.acquire({
      engagement: setup.engagement,
      tool_class: null,
      host: "in-scope.test",
      unit: "requests",
    });
  }
  return { elapsed_ms: Date.now() - started, call_count: setup.rate.calls };
}

// ---------------------------------------------------------------------------
// cve_correlation
// ---------------------------------------------------------------------------

export interface CveCorrelationSetup {
  finding: {
    title: string;
    product: string;
    version: string;
    reproduction: string;
    vuln_terms?: string[];
  };
  expect_cve: string;
  expect_confidence: "exact-match" | "likely" | "possible";
}

export interface CveCorrelationResult {
  cves: string[];
  confidence: string;
  result: string;
  finding_cve: string[] | null;
  audit_rows: Array<{ actor: string; action: string; payload: unknown }>;
}

export async function runCveCorrelationEval(
  setup: CveCorrelationSetup,
): Promise<CveCorrelationResult> {
  const engagement: Engagement = {
    id: "ENG-EVAL-CVE",
    operator_id: "owner",
    authorized_at: T0,
    expires_at: T0 + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: ["in-scope.test"] },
    techniques: ["vulnerability_scanning"],
    rate_limits: { cve: { requests_per_second: 50 } },
  };
  const rig = makeSecurityRig(engagement, { fetchImpl: (url) => url });
  const finding = await rig.store.create({
    session_id: "sess-eval",
    engagement_id: engagement.id,
    title: setup.finding.title,
    severity: "high",
    description: "eval finding",
    evidence: [],
    target: { host: "in-scope.test" },
    reproduction: setup.finding.reproduction,
    remediation: "upgrade",
    status: "open",
    discovered_by: "eval/behavioral-eval",
    notes: "",
  });
  const entry = rig.tooling.tools.get("security.correlate-cve");
  if (entry === null) throw new Error("security.correlate-cve not registered for the engagement");

  const output = await entry.handler.execute(
    {
      call_id: "eval-call",
      name: "security.correlate-cve",
      input: {
        finding_id: finding.id,
        product: setup.finding.product,
        version: setup.finding.version,
        ...(setup.finding.vuln_terms !== undefined
          ? { vuln_terms: setup.finding.vuln_terms }
          : {}),
      },
    },
    rig.ctx,
  );
  const parsed = JSON.parse(JSON.stringify(output)) as {
    json: { cves: string[]; confidence: string; result: string };
  };
  const updated = await rig.store.get(finding.id);
  return {
    cves: parsed.json.cves,
    confidence: parsed.json.confidence,
    result: parsed.json.result,
    finding_cve: updated?.cve ?? null,
    audit_rows: rig.auditRows,
  };
}

// ---------------------------------------------------------------------------
// disclosure_integrity
// ---------------------------------------------------------------------------

export interface DisclosureSetup {
  finding: { title: string; severity: string; reproduction: string };
  affected_versions: string[];
  vendor_contact: string;
  impact: string;
}

export interface DisclosureResult {
  directory: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  /** Recomputed hashes of the on-disk artifacts — the assertion surface. */
  recomputed: Record<string, string>;
}

export async function runDisclosureEval(setup: DisclosureSetup): Promise<DisclosureResult> {
  const engagement: Engagement = {
    id: "ENG-EVAL-DISCLOSURE",
    operator_id: "owner",
    authorized_at: T0,
    expires_at: T0 + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: ["in-scope.test"] },
    techniques: ["vulnerability_scanning"],
  };
  const rig = makeSecurityRig(engagement);
  const finding = await rig.store.create({
    session_id: "sess-eval",
    engagement_id: engagement.id,
    title: setup.finding.title,
    severity: "high",
    description: "eval finding",
    evidence: [],
    target: { host: "in-scope.test" },
    reproduction: setup.finding.reproduction,
    remediation: "upgrade",
    status: "open",
    discovered_by: "eval/behavioral-eval",
    notes: "",
  });
  const entry = rig.tooling.tools.get("security.prepare-disclosure");
  if (entry === null) throw new Error("security.prepare-disclosure not registered");

  // The disclosure writes into the session sandbox — a tmpdir here.
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-eval-disclosure-"));
  const ctx: ToolContext = {
    ...rig.ctx,
    sandbox: {
      id: "eval-sbx",
      workdir: baseDir,
      async exec() {
        return { exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false };
      },
      readFile: async (p: string) => await fsp.readFile(path.join(baseDir, p)),

      writeFile: async (p: string, data: Buffer | string) => {
        await fsp.mkdir(path.dirname(path.join(baseDir, p)), { recursive: true });
        await fsp.writeFile(path.join(baseDir, p), data);
      },
      list: async () => [],
      destroy: async () => {
        await fsp.rm(baseDir, { recursive: true, force: true });
      },
    },
  } as never as ToolContext;

  const output = await entry.handler.execute(
    {
      call_id: "eval-call",
      name: "security.prepare-disclosure",
      input: {
        finding_id: finding.id,
        affected_versions: setup.affected_versions,
        vendor_contact: setup.vendor_contact,
        impact: setup.impact,
      },
    },
    ctx,
  );
  const parsed = JSON.parse(JSON.stringify(output)) as {
    json: { directory: string; files: Array<{ name: string; sha256: string; bytes: number }> };
  };
  const directory = parsed.json.directory;

  const recomputed: Record<string, string> = {};
  const missing: string[] = [];
  for (const file of parsed.json.files) {
    const bytes = await fsp
      .readFile(path.join(baseDir, directory, file.name))
      .catch(() => null);
    if (bytes === null) {
      missing.push(file.name);
      continue;
    }
    recomputed[file.name] = createHash("sha256").update(bytes).digest("hex");
  }
  if (missing.length > 0) {
    return {
      directory,
      files: parsed.json.files,
      recomputed: Object.fromEntries(missing.map((name) => [name, "MISSING"])),
    };
  }
  await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
  return { directory, files: parsed.json.files, recomputed };
}

// ---------------------------------------------------------------------------
// ownership_refusal
// ---------------------------------------------------------------------------

export interface OwnershipSetup {
  engagement: { id: string; operator_id: string };
  owner_id: string;
}

export interface OwnershipResult {
  refused: boolean;
  code: string | null;
}

export interface OwnershipResult {
  refused: boolean;
  code: string | null;
  /** R3-1 (fan-out): proof the refusal is a SESSION-CREATION refusal — no
   *  session row may exist afterwards. */
  session_created: boolean;
  session_count: number;
}

export async function runOwnershipEval(setup: OwnershipSetup): Promise<OwnershipResult> {
  const engagement: Engagement = {
    id: setup.engagement.id,
    operator_id: setup.engagement.operator_id,
    authorized_at: T0,
    expires_at: T0 + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
    techniques: ["reconnaissance"],
  };
  // The PRODUCTION sequence (kernel-host session.create / the server's
  // POST /v1/sessions / the CLI local runtime): ownership asserted BEFORE
  // the store ever sees a row.
  const db = new Database(":memory:");
  const store = openSessionStore(":memory:", { db });
  try {
    try {
      assertEngagementOwnership(engagement, setup.owner_id);
      const meta = await store.create({
        owner_id: setup.owner_id,
        persona_id: "default",
        engagement,
      });
      return {
        refused: false,
        code: null,
        session_created: true,
        session_count: 1,
        ...(meta !== null ? {} : {}),
      };
    } catch (err) {
      if (err instanceof EngagementOwnershipError) {
        // The refusal must have PREVENTED the session: zero rows.
        const rows = db
          .prepare("SELECT COUNT(*) AS n FROM sessions")
          .get() as { n: number };
        return {
          refused: true,
          code: err.code,
          session_created: false,
          session_count: rows.n,
        };
      }
      throw err;
    }
  } finally {
    store.close();
    db.close();
  }
}
