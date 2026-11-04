// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEngagementYaml, ENGAGEMENT_LOADED_AUDIT_ACTION, EngagementFileError } from "./loader.js";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z

const stacks: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (stacks.length > 0) await stacks.pop()!();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  stacks.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface AuditRow {
  actor: string;
  action: string;
  payload: {
    engagement_id: string;
    content_hash: string;
    window: { start: number; end: number };
    techniques: string[];
    [key: string]: unknown;
  };
}

async function write(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text, "utf8");
  return file;
}

/** The Phase 5 §1.2 example engagement, adapted to the default owner id. */
const FULL_YAML = `schema: 1
id: acme-q4-2026
client: "Acme Corp"
operator_id: "owner"
signed_at: 2026-11-01T00:00:00Z
authorized_by: "Jane Smith, CISO"
emergency_contact: "security@acme.example"

window:
  start: 2026-11-01T00:00:00Z
  end: 2026-12-01T00:00:00Z

targets:
  domains:
    - example.com
    - api.example.com
  cidrs:
    - 203.0.113.0/24
    - 198.51.100.10/32
  urls:
    - "https://app.example.com/portal/*"

exclusions:
  domains:
    - mail.example.com
    - "*.internal.example.com"
  cidrs:
    - 203.0.113.128/25

rate_limits:
  default: { requests_per_second: 10 }
  nmap: { packets_per_second: 100 }
  ffuf: { requests_per_second: 20 }

allowed_techniques:
  - reconnaissance
  - port_scanning
  - web_enumeration
  - vulnerability_scanning
`;

describe("loadEngagementYaml — the §1.2 fixture maps exactly onto the protocol Engagement", () => {
  it("loads, maps every field, and pins the content hash", async () => {
    const dir = await tmpDir("nyx-sec-load-");
    const file = await write(dir, "eng.yaml", FULL_YAML);

    const loaded = await loadEngagementYaml(file, { now: () => NOW });
    const e = loaded.engagement;
    expect(e.id).toBe("acme-q4-2026");
    expect(e.operator_id).toBe("owner");
    expect(e.authorized_at).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(e.starts_at).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(e.expires_at).toBe(Date.parse("2026-12-01T00:00:00Z"));
    expect(e.client).toBe("Acme Corp");
    expect(e.title).toBe("Acme Corp");
    expect(e.authorized_by).toBe("Jane Smith, CISO");
    expect(e.emergency_contact).toBe("security@acme.example");
    expect(e.targets.domains).toEqual(["example.com", "api.example.com"]);
    expect(e.targets.cidrs).toEqual(["203.0.113.0/24", "198.51.100.10/32"]);
    expect(e.targets.urls).toEqual(["https://app.example.com/portal/*"]);
    expect(e.targets.exclude).toEqual({
      domains: ["mail.example.com", "*.internal.example.com"],
      cidrs: ["203.0.113.128/25"],
    });
    expect(e.techniques).toEqual([
      "reconnaissance",
      "port_scanning",
      "web_enumeration",
      "vulnerability_scanning",
    ]);
    expect(e.rate_limits).toEqual({
      default: { requests_per_second: 10 },
      nmap: { packets_per_second: 100 },
      ffuf: { requests_per_second: 20 },
    });
    expect(loaded.content_hash).toBe(
      createHash("sha256").update(FULL_YAML, "utf8").digest("hex"),
    );
    expect(loaded.warnings).toEqual([]);
    expect(loaded.file).toBe(file);
  });

  it("emits a security.engagement.loaded audit row with the hash and window", async () => {
    const dir = await tmpDir("nyx-sec-audit-");
    const file = await write(dir, "eng.yaml", FULL_YAML);
    const rows: AuditRow[] = [];

    await loadEngagementYaml(file, { now: () => NOW, audit: (r) => rows.push(r as AuditRow) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("system:security");
    expect(rows[0]!.action).toBe(ENGAGEMENT_LOADED_AUDIT_ACTION);
    expect(rows[0]!.payload.engagement_id).toBe("acme-q4-2026");
    expect(rows[0]!.payload.content_hash).toBe(
      createHash("sha256").update(FULL_YAML, "utf8").digest("hex"),
    );
    expect(rows[0]!.payload.window).toEqual({
      start: Date.parse("2026-11-01T00:00:00Z"),
      end: Date.parse("2026-12-01T00:00:00Z"),
    });
    expect(rows[0]!.payload.techniques).toContain("port_scanning");
  });

  it("JSON engagement files load too (YAML superset)", async () => {
    const dir = await tmpDir("nyx-sec-json-");
    const file = await write(
      dir,
      "eng.json",
      JSON.stringify({
        schema: 1,
        id: "json-eng",
        client: "JSON Corp",
        operator_id: "owner",
        signed_at: "2026-11-01T00:00:00Z",
        authorized_by: "A. Authorizer",
        emergency_contact: "sec@example.com",
        window: { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" },
        targets: { domains: ["example.com"] },
      }),
    );
    const loaded = await loadEngagementYaml(file, { now: () => NOW });
    expect(loaded.engagement.id).toBe("json-eng");
    // domain-only engagement → the documented warning
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("domain-only authorization");
  });
});

describe("loadEngagementYaml — refusals", () => {
  it("unreadable file", async () => {
    await expect(loadEngagementYaml("/nonexistent/eng.yaml")).rejects.toMatchObject({
      code: "unreadable",
    });
  });

  it("malformed YAML", async () => {
    const dir = await tmpDir("nyx-sec-bad-");
    const file = await write(dir, "eng.yaml", "targets: [unclosed");
    await expect(loadEngagementYaml(file)).rejects.toMatchObject({ code: "invalid_yaml" });
  });

  it("schema violations: unknown field, bad window, no targets, missing metadata", async () => {
    const dir = await tmpDir("nyx-sec-schema-");
    const base = {
      schema: 1,
      id: "x",
      client: "X Corp",
      operator_id: "owner",
      signed_at: "2026-11-01T00:00:00Z",
      authorized_by: "A",
      emergency_contact: "sec@example.com",
      window: { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" },
      targets: { domains: ["example.com"] },
    };

    const unknown = await write(
      dir,
      "unknown.yaml",
      JSON.stringify({ ...base, sneaky: true }),
    );
    await expect(loadEngagementYaml(unknown)).rejects.toMatchObject({ code: "validation_failed" });

    const endBeforeStart = await write(
      dir,
      "window.yaml",
      JSON.stringify({
        ...base,
        window: { start: "2026-12-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
      }),
    );
    const err = await loadEngagementYaml(endBeforeStart).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementFileError);
    expect((err as EngagementFileError).code).toBe("validation_failed");
    expect((err as EngagementFileError).message).toContain("window.end");

    const noTargets = await write(dir, "empty.yaml", JSON.stringify({ ...base, targets: {} }));
    await expect(loadEngagementYaml(noTargets)).rejects.toMatchObject({
      code: "validation_failed",
    });

    const noClient = await write(
      dir,
      "noclient.yaml",
      JSON.stringify({ ...base, client: undefined }),
    );
    await expect(loadEngagementYaml(noClient)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("a rate-limit entry must declare exactly one unit and a valid class key", async () => {
    const dir = await tmpDir("nyx-sec-rate-");
    const base = {
      schema: 1,
      id: "x",
      client: "X Corp",
      operator_id: "owner",
      signed_at: "2026-11-01T00:00:00Z",
      authorized_by: "A",
      emergency_contact: "sec@example.com",
      window: { start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" },
      targets: { domains: ["example.com"] },
    };
    const both = await write(
      dir,
      "both.yaml",
      JSON.stringify({
        ...base,
        rate_limits: { ffuf: { requests_per_second: 10, packets_per_second: 10 } },
      }),
    );
    await expect(loadEngagementYaml(both)).rejects.toMatchObject({
      code: "validation_failed",
    });
    const neither = await write(
      dir,
      "neither.yaml",
      JSON.stringify({ ...base, rate_limits: { ffuf: {} } }),
    );
    await expect(loadEngagementYaml(neither)).rejects.toMatchObject({
      code: "validation_failed",
    });
    const badKey = await write(
      dir,
      "badkey.yaml",
      JSON.stringify({ ...base, rate_limits: { "Bad Key!": { requests_per_second: 10 } } }),
    );
    await expect(loadEngagementYaml(badKey)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("invalid targets (bad CIDR, bad wildcard) are refused after schema parse", async () => {
    const dir = await tmpDir("nyx-sec-targets-");
    const file = await write(
      dir,
      "eng.yaml",
      `schema: 1
id: x
client: "X Corp"
operator_id: "owner"
signed_at: 2026-11-01T00:00:00Z
authorized_by: "A"
emergency_contact: "sec@example.com"
window: { start: 2026-11-01T00:00:00Z, end: 2026-12-01T00:00:00Z }
targets:
  cidrs: ["203.0.113.300/24"]
  domains: ["**.example.com"]
`,
    );
    const err = await loadEngagementYaml(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementFileError);
    expect((err as EngagementFileError).code).toBe("invalid_targets");
    expect((err as EngagementFileError).message).toContain("203.0.113.300/24");
  });

  it("an expired window is refused up front", async () => {
    const dir = await tmpDir("nyx-sec-exp-");
    const file = await write(
      dir,
      "eng.yaml",
      JSON.stringify({
        schema: 1,
        id: "x",
        client: "X Corp",
        operator_id: "owner",
        signed_at: "2026-01-01T00:00:00Z",
        authorized_by: "A",
        emergency_contact: "sec@example.com",
        window: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
        targets: { domains: ["example.com"] },
      }),
    );
    await expect(loadEngagementYaml(file, { now: () => NOW })).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("a not-yet-active window LOADS — the engine denies actions until it opens", async () => {
    const dir = await tmpDir("nyx-sec-future-");
    const file = await write(
      dir,
      "eng.yaml",
      JSON.stringify({
        schema: 1,
        id: "x",
        client: "X Corp",
        operator_id: "owner",
        signed_at: "2026-11-01T00:00:00Z",
        authorized_by: "A",
        emergency_contact: "sec@example.com",
        window: { start: "2026-12-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
        targets: { domains: ["example.com"] },
      }),
    );
    const loaded = await loadEngagementYaml(file, { now: () => NOW });
    expect(loaded.engagement.starts_at).toBeGreaterThan(NOW);
  });
});
