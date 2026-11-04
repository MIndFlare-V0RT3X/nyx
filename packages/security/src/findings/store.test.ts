// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import * as os from "node:os";
import * as path from "node:path";
import { openSessionStore } from "@nyx/session";
import { FindingStore, orderFindingsForReport } from "./store.js";
import type { Finding } from "./schema.js";
import { severityFromScore, cvssSeverityLabel } from "./schema.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const stacks: Array<() => void> = [];
afterAll(() => {
  while (stacks.length > 0) stacks.pop()!();
});

function makeStore(file = ":memory:"): { store: FindingStore; db: Database.Database } {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  openSessionStore(file, { db }); // runs the drizzle migrations incl. 0004_findings
  const store = new FindingStore({ db, now: () => T0 });
  stacks.push(() => db.close());
  return { store, db };
}

function fixture(overrides: Partial<Omit<Finding, "id" | "discovered_at">> = {}): Omit<
  Finding,
  "id" | "discovered_at"
> {
  return {
    engagement_id: "ENG-2026-042",
    session_id: "sess-1",
    title: "Reflected XSS in the portal login form",
    description: "The q parameter is echoed unescaped into the login page HTML.",
    severity: "medium" as const,
    cvss_3_1: 6.1,
    cwe: ["CWE-79"],
    cve: ["CVE-2026-1234"],
    target: { host: "app.example.com", port: 443, path: "/portal/login" },
    evidence: [{ path: "artifacts/xss-poc.txt", hash: "a".repeat(64), mime: "text/plain" }],
    reproduction: "1. Open /portal/login?q=<script> 2. Observe the alert",
    remediation: "HTML-encode the q parameter on output.",
    status: "open" as const,
    discovered_by: "nuclei/security.nuclei",
    notes: "",
    ...overrides,
  };
}

describe("FindingStore — create / get roundtrip", () => {
  it("stores every field and hands back the stamped id and discovery time", async () => {
    const { store } = makeStore();
    const f = await store.create(fixture());
    expect(f.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(f.discovered_at).toBe(T0);
    const got = await store.get(f.id);
    expect(got).toEqual(f);
  });

  it("survives a restart (file-backed nyx.db, migrations idempotent)", async () => {
    const dir = mkdirSync(path.join(os.tmpdir(), `nyx-findings-${process.pid}-${Date.now()}`), {
      recursive: true,
    })!;
    const file = path.join(dir, "nyx.db");
    const first = makeStore(file);
    const created = await first.store.create(fixture());
    first.db.close();

    const second = makeStore(file);
    const got = await second.store.get(created.id);
    expect(got).not.toBeNull();
    expect(got?.title).toBe("Reflected XSS in the portal login form");
    expect(got?.evidence[0]?.hash).toBe("a".repeat(64));
  });
});

describe("FindingStore — list filters", () => {
  it("filters by engagement, severity set, and status", async () => {
    const { store } = makeStore();
    await store.create(fixture({ title: "a", severity: "critical", status: "confirmed" }));
    await store.create(
      fixture({ title: "b", severity: "low", status: "false_positive", engagement_id: "OTHER" }),
    );
    await store.create(fixture({ title: "c", severity: "high", status: "open" }));
    await store.create(fixture({ title: "d", severity: "critical", status: "open" }));

    expect((await store.list({ engagement_id: "ENG-2026-042" })).length).toBe(3);
    expect((await store.list({ engagement_id: "OTHER" })).length).toBe(1);
    expect((await store.list({ severity: ["critical", "high"] })).length).toBe(3);
    expect((await store.list({ status: "open" })).length).toBe(2);
    expect((await store.list({ severity: ["critical"], status: "open" })).length).toBe(1);
    expect((await store.list({})).length).toBe(4);
  });
});

describe("FindingStore — update + FTS sync", () => {
  it("patches fields and the FTS index follows the new title", async () => {
    const { store } = makeStore();
    const f = await store.create(fixture());
    await store.update(f.id, { status: "confirmed", notes: "client reproduced", title: "Stored XSS in profile name" });

    const got = await store.get(f.id);
    expect(got?.status).toBe("confirmed");
    expect(got?.notes).toBe("client reproduced");
    expect(got?.title).toBe("Stored XSS in profile name");
    // The old title no longer matches; the new one does (AFTER UPDATE trigger).
    expect((await store.search("portal login")).length).toBe(0);
    expect((await store.search("profile name")).length).toBe(1);
  });

  it("update of a missing finding throws not_found", async () => {
    const { store } = makeStore();
    await expect(store.update("nope", { status: "confirmed" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("FindingStore — FTS search", () => {
  it("matches tokens in title and description across findings", async () => {
    const { store } = makeStore();
    await store.create(fixture());
    await store.create(fixture({ title: "SQL injection in the search endpoint", description: "The id parameter reaches a raw query." }));
    expect((await store.search("XSS")).length).toBe(1);
    expect((await store.search("injection")).length).toBe(1);
    expect((await store.search("parameter")).length).toBe(2);
    expect((await store.search("login form echoed")).length).toBe(1); // AND semantics
  });

  it("sanitizes the query — operators and quotes never reach MATCH syntax", async () => {
    const { store } = makeStore();
    await store.create(fixture());
    // A raw " OR " injection would match everything; sanitized it matches nothing.
    expect((await store.search("xss OR 1=1")).length).toBe(0);
    expect((await store.search('"; DROP TABLE findings; --'))).toEqual([]);
    expect((await store.search("   "))).toEqual([]);
  });
});

describe("FindingStore — the structural session binding (§5 Reviewer 2)", () => {
  it("derives engagement_id and session_id from the binding", async () => {
    const { store } = makeStore();
    const f = await store.createInSession(
      { session_id: "sess-9", engagement: { id: "ENG-BOUND", operator_id: "owner", authorized_at: 1, expires_at: 2, targets: { cidrs: [], domains: [] } } },
      fixture(),
    );
    expect(f.engagement_id).toBe("ENG-BOUND");
    expect(f.session_id).toBe("sess-9");
  });

  it("refuses to write findings for a session with no engagement", async () => {
    const { store } = makeStore();
    await expect(
      store.createInSession({ session_id: "sess-x", engagement: null }, fixture()),
    ).rejects.toMatchObject({ code: "no_engagement" });
  });

  it("a foreign engagement id in the input is inert — the binding wins", async () => {
    const { store } = makeStore();
    const f = await store.createInSession(
      {
        session_id: "sess-9",
        engagement: { id: "ENG-REAL", operator_id: "owner", authorized_at: 1, expires_at: 2, targets: { cidrs: [], domains: [] } },
      },
      // @ts-expect-error deliberately hostile input: a foreign engagement id
      { ...fixture(), engagement_id: "ENG-FORGED" },
    );
    expect(f.engagement_id).toBe("ENG-REAL");
  });
});

describe("severity helpers + report ordering", () => {
  it("maps CVSS scores to severity bands", () => {
    expect(severityFromScore(0)).toBe("info");
    expect(severityFromScore(3.1)).toBe("low");
    expect(severityFromScore(6.1)).toBe("medium");
    expect(severityFromScore(8.3)).toBe("high");
    expect(severityFromScore(10)).toBe("critical");
    expect(() => severityFromScore(10.5)).toThrow(RangeError);
    expect(cvssSeverityLabel(9.8)).toBe("Critical");
  });

  it("orders findings by severity band, then CVSS descending", () => {
    const a: Finding = { ...fixture(), id: "a", discovered_at: 1, severity: "high", cvss_4_0: 8.5 } as Finding;
    const b: Finding = { ...fixture(), id: "b", discovered_at: 2, severity: "critical" } as Finding;
    const c: Finding = { ...fixture(), id: "c", discovered_at: 3, severity: "high", cvss_3_1: 7.1 } as Finding;
    const d: Finding = { ...fixture(), id: "d", discovered_at: 4, severity: "info" } as Finding;
    expect(orderFindingsForReport([a, d, b, c]).map((f) => f.id)).toEqual(["b", "a", "c", "d"]);
  });
});
