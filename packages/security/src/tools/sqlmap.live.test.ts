// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.2 hard rule 6 — the REAL sqlmap binary against a REAL vulnerable
// endpoint, driven through the actual wrapper (host executor: sqlmap on
// PATH). Skips when sqlmap is absent so CI stays hermetic; the fixtures in
// fixtures/ were captured by the same flow this test runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as sqlite3 from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { openSessionStore } from "@nyx/session";
import { ToolRegistryImpl } from "@nyx/tools";
import type { ToolRuntime } from "@nyx/tools";
import type { Engagement, Sandbox, SessionEvent, ToolContext } from "@nyx/protocol";
import {
  FindingStore,
  SecurityRateLimiter,
  buildEngagementTooling,
  registerSecurityTools,
  clearSecurityToolMeta,
} from "../index.js";

const execFileP = promisify(execFile);
const sqlmapAvailable = await execFileP("sqlmap", ["--version"])
  .then(() => true)
  .catch(() => false);

const dIt = (name: string, fn: () => Promise<void>, timeout = 300_000): void => {
  if (sqlmapAvailable) it(name, fn, timeout);
  else it.skip(name, fn, timeout);
};

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

function engagement(): Engagement {
  return {
    id: "live-sqlmap-test",
    operator_id: "owner",
    authorized_at: T0 - 60_000,
    expires_at: Date.now() + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
    techniques: ["vulnerability_scanning", "exploitation"],
    rate_limits: { default: { requests_per_second: 100 } },
  };
}

/** The deliberately vulnerable endpoint (the fixture-capture server, TS). */
function vulnerableServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("q") ?? "";
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, secret TEXT);" +
          "INSERT INTO users VALUES (1,'alice','s3cr3t-a'),(2,'bob','s3cr3t-b'),(3,'carol','s3cr3t-c');",
      );
      // THE VULNERABILITY: the parameter is interpolated raw into SQL text.
      const literal = db
        .prepare("SELECT id, name, secret FROM users WHERE name = '" + q + "'")
        .all() as Array<{ id: number; name: string; secret: string }>;
      const body =
        "found " + literal.length + " users\n" + literal.map((r) => `${r.name}:${r.secret}`).join("\n");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`db error: ${(err as Error).message}\n`);
    } finally {
      db.close();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr !== null ? addr.port : 0 });
    });
  });
}

describe("sqlmap LIVE — the real binary end-to-end (hard rule 6)", () => {
  let target: { server: Server; port: number };
  let db: Database.Database;
  let runtime: ToolRuntime;
  let store: FindingStore;
  let ctx: ToolContext;
  const files = new Map<string, string>();

  beforeAll(async () => {
    if (!sqlmapAvailable) return;
    target = await vulnerableServer();
    db = new Database(":memory:");
    openSessionStore(":memory:", { db });
    store = new FindingStore({ db, now: () => T0 });
    const registry = new ToolRegistryImpl();
    registerSecurityTools(registry, {
      store,
      limiter: new SecurityRateLimiter(),
      // No executor → resolved per call as the HOST executor: sqlmap on PATH.
    });
    const fakeKernel = {
      version: "0-test",
      hooks: { on: () => () => {}, emit: async () => [] },
      tools: registry,
      services: new Map<string, unknown>(),
      use: async () => {},
      unuse: async () => {},
    } as never;
    const tooling = buildEngagementTooling(
      {
        tools: registry,
        kernel: fakeKernel,
        policy: {
          async evaluate(req: { tool: string }) {
            return {
              decision: "allow",
              rule_id: "test:allow",
              action_digest: "0".repeat(64),
              summary: `${req.tool} (live)`,
            };
          },
        } as never,
        approvals: {
          request: async () => "allow",
          resolve: async () => undefined,
          get: async () => null,
          pending: async () => [],
          consume: async () => undefined,
        } as never,
      } as never,
      engagement(),
    );
    runtime = tooling.kernel.services.get<ToolRuntime>("tools.runtime")!;
    const noopLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => noopLogger,
    };
    const sandbox: Sandbox = {
      id: "live-sbx",
      workdir: "/workspace",
      exec: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
      readFile: async (p) => Buffer.from(files.get(p) ?? "", "utf8"),
      writeFile: async (p, data) => {
        files.set(p, typeof data === "string" ? data : data.toString("utf8"));
      },
      list: async () => [],
      destroy: async () => {},
    };
    ctx = {
      session_id: "sess-live",
      turn_id: "turn-live",
      call_id: "call-live",
      sandbox,
      signal: new AbortController().signal,
      logger: noopLogger,
      emit: (_e: SessionEvent) => {},
      engagement: engagement(),
    } as never;
  });

  afterAll(() => {
    clearSecurityToolMeta();
    if (target !== undefined) target.server.close();
    if (db !== undefined) db.close();
  });

  dIt("sqlmap-scan detects the real injection and records a finding", async () => {
    const out = await runtime.execute(
      {
        call_id: "c1",
        name: "security.sqlmap-scan",
        input: { url: `http://127.0.0.1:${target.port}/?q=test` },
      },
      ctx as never,
    );
    const json = (out as { json: { injectable: boolean; dbms: string | null; finding_id?: string } }).json;
    expect(json.injectable).toBe(true);
    expect(json.dbms).toBe("SQLite");
    expect(json.finding_id).toBeTruthy();
    const findings = await store.list({ engagement_id: "live-sqlmap-test" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  dIt("sqlmap-exploit dumps the users table through the authorized extraction path", async () => {
    const out = await runtime.execute(
      {
        call_id: "c2",
        name: "security.sqlmap-exploit",
        input: {
          url: `http://127.0.0.1:${target.port}/?q=test`,
          action: "dump",
          table: "users",
        },
      },
      ctx as never,
    );
    const json = (out as { json: { tables: Array<{ table: string; entries: number | null; rows: string[][] }> } }).json;
    const users = json.tables.find((t) => t.table === "users");
    expect(users).toBeDefined();
    expect(users!.entries).toBe(3);
    expect(users!.rows.some((r) => r.includes("alice"))).toBe(true);
  });
});
