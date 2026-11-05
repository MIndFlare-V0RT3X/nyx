// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx doctor` engagement checks (2.0.4): active domain-only engagements warn;
// CIDR-constrained and expired ones do not; a missing database is a clean ok.

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import type { Engagement } from "@nyx/protocol";
import { openSessionStore } from "@nyx/session";
import { doctorChecks, renderDoctorReport } from "./doctor.js";

function offlineConfig(): NyxConfig {
  return configSchema.parse({
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    sandbox: { provider: "local" },
  });
}

function engagement(
  partial: { cidrs?: string[]; domains?: string[] },
  expiresAt: number,
): Engagement {
  // The frozen protocol requires both arrays; "absent" is an empty array.
  return {
    id: `ENG-${Math.random().toString(36).slice(2, 8)}`,
    operator_id: "owner",
    authorized_at: Date.now(),
    expires_at: expiresAt,
    targets: { cidrs: [], domains: [], ...partial },
  };
}

async function seedSession(
  dataDir: string,
  engagementOrNull: ReturnType<typeof engagement> | null,
): Promise<string> {
  const store = openSessionStore(join(dataDir, "nyx.db"));
  try {
    const meta = await store.create({
      owner_id: "owner",
      persona_id: "default",
      engagement: engagementOrNull,
    });
    return meta.session_id;
  } finally {
    store.close();
  }
}

describe("doctor engagement checks (2.0.4)", () => {
  it("warns on active domain-only engagements; cidr-constrained and expired do not warn", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nyx-doctor-eng-"));
    try {
      await seedSession(
        dataDir,
        engagement({ domains: ["example.com"], cidrs: [] }, Date.now() + 3_600_000),
      );
      await seedSession(
        dataDir,
        engagement({ domains: ["safe.example"], cidrs: ["10.0.0.0/8"] }, Date.now() + 3_600_000),
      );
      await seedSession(
        dataDir,
        engagement({ domains: ["expired.example"], cidrs: [] }, Date.now() - 1_000),
      );
      await seedSession(dataDir, null);

      const report = await doctorChecks({
        env: { NYX_SKIP_DOCKER: "1" },
        config: offlineConfig(),
        data_dir: dataDir,
        docker_available: true,
      });
      const check = report.checks.find((c) => c.name === "engagements");
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.detail).toContain("1 active domain-only engagement");
      expect(check!.detail).toContain("no CIDR constraint");
      expect(check!.critical).toBe(false); // a warning, not a failure
      expect(report.exit_code).toBe(0);

      const rendered = renderDoctorReport(report);
      expect(rendered).toContain("! engagements");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("no domain-only engagements → ok, and no database → ok", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nyx-doctor-eng2-"));
    try {
      const empty = await doctorChecks({
        env: { NYX_SKIP_DOCKER: "1" },
        config: offlineConfig(),
        data_dir: dataDir,
        docker_available: true,
      });
      expect(empty.checks.find((c) => c.name === "engagements")!.status).toBe("ok");

      await seedSession(
        dataDir,
        engagement({ domains: ["safe.example"], cidrs: ["10.0.0.0/8"] }, Date.now() + 3_600_000),
      );
      const clean = await doctorChecks({
        env: { NYX_SKIP_DOCKER: "1" },
        config: offlineConfig(),
        data_dir: dataDir,
        docker_available: true,
      });
      const check = clean.checks.find((c) => c.name === "engagements")!;
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("none domain-only");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
