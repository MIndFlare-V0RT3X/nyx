// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx doctor` — one report over the machine's ability to run NYX: node
// version, SQLite, config validity, Docker, provider reachability, sandbox
// selection. Exit 0 when everything critical is OK, 1 otherwise. No network
// unless a configured hosted provider needs a reachability probe (5s cap).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import { isDomainOnlyEngagement } from "@nyx/policy";
import { checkDocker } from "@nyx/sandbox";
import { LEGACY_DB_FILES } from "@nyx/db";
import { openSessionStore } from "@nyx/session";
import type { ModelProvider } from "@nyx/protocol";
import { resolveCliConfig, resolveDataDir } from "./config.js";
import { buildProviders } from "./providers.js";
import { createCliLogger } from "./logger.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** A critical failure sets the command's exit code to 1. */
  critical: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exit_code: 0 | 1;
}

export interface DoctorOptions {
  /** Env source (default process.env): NYX_SKIP_DOCKER, NYX_ENV, provider keys. */
  env?: NodeJS.ProcessEnv;
  /** Test injection: skip config resolution and use this config verbatim. */
  config?: NyxConfig;
  /** Test injection: data dir to scan for engagement warnings (default NYX_DATA_DIR or ~/.nyx). */
  data_dir?: string;
  /** Test injection: skip the `docker version` spawn. */
  docker_available?: boolean;
  /** Reachability probe budget per provider (default 5000). */
  provider_timeout_ms?: number;
}

const REQUIRED_NODE_MAJOR = 22;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function checkNode(): Promise<DoctorCheck> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const ok = major >= REQUIRED_NODE_MAJOR;
  return {
    name: "node",
    status: ok ? "ok" : "fail",
    detail: ok
      ? `v${process.versions.node} (>= ${REQUIRED_NODE_MAJOR} required)`
      : `v${process.versions.node} is too old (>= ${REQUIRED_NODE_MAJOR} required)`,
    critical: true,
  };
}

async function checkSqlite(): Promise<DoctorCheck> {
  try {
    const store = openSessionStore(":memory:");
    const count = (await store.list({ limit: 1 })).length;
    store.close();
    return {
      name: "sqlite",
      status: "ok",
      detail: `better-sqlite3 ok (list returned ${count} sessions)`,
      critical: true,
    };
  } catch (err) {
    return {
      name: "sqlite",
      status: "fail",
      detail: `session store failed to open: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
    };
  }
}

async function checkConfig(
  env: NodeJS.ProcessEnv,
  injected: NyxConfig | undefined,
): Promise<{ check: DoctorCheck; config: NyxConfig }> {
  if (injected !== undefined) {
    return {
      check: { name: "config", status: "ok", detail: "injected (test)", critical: true },
      config: injected,
    };
  }
  try {
    const resolved = await resolveCliConfig(env);
    return {
      check: {
        name: "config",
        status: "ok",
        detail:
          resolved.source.kind === "file"
            ? `valid (${resolved.source.path})`
            : "missing — fallback offline config (mock provider, local dev sandbox)",
        critical: true,
      },
      config: resolved.config,
    };
  } catch (err) {
    return {
      check: {
        name: "config",
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        critical: true,
      },
      // The fallback keeps the remaining checks meaningful even with a broken
      // config file: doctor reports everything, not just the first failure.
      config: configSchema.parse({
        providers: { mock: { kind: "mock" } },
        router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
        sandbox: { provider: "local" },
      }),
    };
  }
}

async function checkDockerAvailable(
  env: NodeJS.ProcessEnv,
  injected: boolean | undefined,
): Promise<{ status: DoctorStatus; detail: string; available: boolean; skipped: boolean }> {
  if (env.NYX_SKIP_DOCKER === "1") {
    return { status: "skip", detail: "NYX_SKIP_DOCKER=1", available: false, skipped: true };
  }
  if (injected !== undefined) {
    return {
      status: injected ? "ok" : "warn",
      detail: injected ? "docker CLI reachable" : "docker CLI not reachable",
      available: injected,
      skipped: false,
    };
  }
  const available = await checkDocker();
  return {
    status: available ? "ok" : "warn",
    detail: available
      ? "docker CLI reachable"
      : "docker CLI not reachable (docker sandbox would fail)",
    available,
    skipped: false,
  };
}

async function checkProviders(
  config: NyxConfig,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const entries = Object.entries(config.providers);
  const logger = createCliLogger(config.logging, { sink: { write: () => undefined } });
  let okCount = 0;

  for (const [id, entry] of entries) {
    if (entry.kind === "mock") {
      okCount += 1;
      checks.push({
        name: `provider ${id}`,
        status: "ok",
        detail: "mock (offline)",
        critical: false,
      });
      continue;
    }
    let provider: ModelProvider | undefined;
    try {
      provider = buildProviders(
        configSchema.parse({ ...config, providers: { [id]: entry } }),
        logger,
        env,
      )[0];
      if (provider === undefined) throw new Error(`provider ${id} produced no instance`);
    } catch (err) {
      checks.push({
        name: `provider ${id}`,
        status: "skip",
        detail: err instanceof Error ? err.message : String(err),
        critical: false,
      });
      continue;
    }
    try {
      const models = await withTimeout(provider.listModels(), timeoutMs);
      okCount += 1;
      checks.push({
        name: `provider ${id}`,
        status: "ok",
        detail:
          entry.models.length > 0
            ? `${models.length} declared model(s) (offline)`
            : `reachable — ${models.length} model(s)`,
        critical: false,
      });
    } catch (err) {
      checks.push({
        name: `provider ${id}`,
        status: "fail",
        detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
        critical: false,
      });
    }
  }

  if (entries.length === 0) {
    checks.push({
      name: "providers",
      status: "fail",
      detail: "no providers configured (router has nothing to route to)",
      critical: true,
    });
  } else if (okCount === 0) {
    checks.push({
      name: "providers",
      status: "fail",
      detail: "no reachable provider (every configured provider failed or was skipped)",
      critical: true,
    });
  }
  return checks;
}

function checkSandbox(
  config: NyxConfig,
  env: NodeJS.ProcessEnv,
  docker: { status: DoctorStatus; available: boolean; skipped: boolean },
): DoctorCheck {
  const provider = config.sandbox.provider;
  if (provider === "local") {
    if (env.NYX_ENV === "production") {
      return {
        name: "sandbox",
        status: "fail",
        detail: 'provider "local" refused: NYX_ENV=production requires the docker provider',
        critical: true,
      };
    }
    return {
      name: "sandbox",
      status: "ok",
      detail: 'provider "local" (development — no isolation, no network blocking)',
      critical: true,
    };
  }
  if (docker.skipped) {
    return {
      name: "sandbox",
      status: "skip",
      detail: 'provider "docker" (docker check skipped)',
      critical: true,
    };
  }
  return {
    name: "sandbox",
    status: docker.available ? "ok" : "fail",
    detail: docker.available
      ? `provider "docker" (image ${config.sandbox.image})`
      : `provider "docker" selected but the docker CLI is not reachable`,
    critical: true,
  };
}

/**
 * 2.0.4: warn when any ACTIVE engagement is domain-only (domains declared,
 * no CIDR constraint). The runtime pin trusts the first resolution for such
 * engagements; the warning points the operator at the audit row recorded at
 * creation time.
 */
async function checkEngagements(dataDir: string): Promise<DoctorCheck> {
  if (!existsSync(join(dataDir, "nyx.db"))) {
    return {
      name: "engagements",
      status: "ok",
      detail: "no sessions database yet",
      critical: false,
    };
  }
  try {
    const store = openSessionStore(join(dataDir, "nyx.db"));
    try {
      const now = Date.now();
      const sessions = await store.list({ limit: 100_000 });
      const domainOnly: Array<{ engagement_id: string; session_id: string }> = [];
      let withEngagement = 0;
      for (const session of sessions) {
        const engagement = session.engagement;
        if (engagement === null) continue;
        withEngagement += 1;
        if (engagement.expires_at <= now) continue; // inactive — expired
        if (isDomainOnlyEngagement(engagement)) {
          domainOnly.push({ engagement_id: engagement.id, session_id: session.session_id });
        }
      }
      if (domainOnly.length > 0) {
        const listed = domainOnly
          .slice(0, 3)
          .map((e) => `${e.engagement_id} (session ${e.session_id.slice(0, 8)}…)`)
          .join(", ");
        const more = domainOnly.length > 3 ? `, +${domainOnly.length - 3} more` : "";
        return {
          name: "engagements",
          status: "warn",
          detail:
            `${domainOnly.length} active domain-only engagement${domainOnly.length === 1 ? "" : "s"} ` +
            `(no CIDR constraint; the DNS pin trusts the first resolution — ` +
            `creation-time resolutions are in the audit log): ${listed}${more}`,
          critical: false,
        };
      }
      return {
        name: "engagements",
        status: "ok",
        detail:
          withEngagement === 0
            ? "no engagements bound"
            : `${withEngagement} engagement${withEngagement === 1 ? "" : "s"} scanned, none domain-only`,
        critical: false,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      name: "engagements",
      status: "warn",
      detail: `could not scan sessions: ${err instanceof Error ? err.message : String(err)}`,
      critical: false,
    };
  }
}

/**
 * 2.0.1/2.2: the database report — nyx.db is the single store; any legacy
 * split-DB file still present will migrate on the next start (originals are
 * renamed, never deleted).
 */
function checkDatabase(dataDir: string): DoctorCheck {
  const nyxDb = join(dataDir, "nyx.db");
  const legacy = LEGACY_DB_FILES.filter((name) => existsSync(join(dataDir, name)));
  if (!existsSync(nyxDb)) {
    if (legacy.length > 0) {
      return {
        name: "database",
        status: "warn",
        detail:
          `no nyx.db yet, but ${legacy.length} legacy file(s) present (${legacy.join(", ")}) — ` +
          "the next server/CLI start migrates them into one nyx.db " +
          "(chain-verified; originals renamed, never deleted)",
        critical: false,
      };
    }
    return {
      name: "database",
      status: "ok",
      detail: "no sessions database yet (created on first run)",
      critical: false,
    };
  }
  if (legacy.length > 0) {
    return {
      name: "database",
      status: "warn",
      detail:
        `nyx.db (unified) present; ${legacy.length} legacy file(s) pending migration ` +
        `(${legacy.join(", ")}) — the next server/CLI start migrates them in one ` +
        "chain-verified transaction and renames the originals, never deletes them",
      critical: false,
    };
  }
  return {
    name: "database",
    status: "ok",
    detail: "nyx.db — unified (events, audit, approvals, channels, heartbeat)",
    critical: false,
  };
}

/** Run every doctor check and compute the exit code. */
export async function doctorChecks(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.provider_timeout_ms ?? 5_000;

  const checks: DoctorCheck[] = [];
  checks.push(await checkNode());
  checks.push(await checkSqlite());
  const { check: configCheck, config } = await checkConfig(env, opts.config);
  checks.push(configCheck);
  const docker = await checkDockerAvailable(env, opts.docker_available);
  const dockerCritical = config.sandbox.provider === "docker" && !docker.skipped;
  checks.push({
    name: "docker",
    status: docker.status,
    detail: docker.detail,
    critical: dockerCritical,
  });
  checks.push(...(await checkProviders(config, env, timeoutMs)));
  checks.push(checkSandbox(config, env, docker));
  const dataDir = opts.data_dir ?? resolveDataDir(env);
  checks.push(checkDatabase(dataDir));
  // 2.0.4: surface domain-only engagements from the operator's data dir.
  checks.push(await checkEngagements(dataDir));

  const failed = checks.some((check) => check.critical && check.status === "fail");
  return { checks, exit_code: failed ? 1 : 0 };
}

/** Render the report: one status line per check plus a summary line. */
export function renderDoctorReport(report: DoctorReport): string {
  const icon: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const lines = report.checks.map(
    (check) => `${icon[check.status]} ${check.name.padEnd(16)} ${check.detail}`,
  );
  const criticalFailures = report.checks.filter((c) => c.critical && c.status === "fail").length;
  lines.push("");
  lines.push(
    criticalFailures === 0
      ? "all critical checks passed"
      : `${criticalFailures} critical check${criticalFailures === 1 ? "" : "s"} failed`,
  );
  return lines.join("\n");
}
