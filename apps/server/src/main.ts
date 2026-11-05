// SPDX-License-Identifier: AGPL-3.0-or-later
// The nyx-server binary entry. Resolves config, data dir, and auth; starts
// the HTTP + WS server; shuts down gracefully. Works out of the box offline:
// with no config file present it boots a fallback config (mock provider,
// local dev sandbox) and prints a generated owner token exactly once.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, loadConfig, type NyxConfig } from "@nyx/config";
import { createServer } from "./server.js";
import { SERVER_ID } from "./version.js";

/** The zero-config fallback: mock provider, local dev sandbox, sane policy. */
function fallbackConfig(): NyxConfig {
  return configSchema.parse({
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: {
      rules: [
        { id: "allow-r0", match: { risk: "R0" }, decision: "allow" },
        { id: "allow-r1", match: { risk: "R1" }, decision: "allow" },
        { id: "ask-r2", match: { risk: "R2" }, decision: "ask" },
        { id: "ask-r3", match: { risk: "R3" }, decision: "ask" },
        { id: "ask-r4", match: { risk: "R4" }, decision: "ask" },
      ],
    },
    sandbox: { provider: "local" },
  });
}

async function main(): Promise<void> {
  const configPath = process.env.NYX_CONFIG_PATH ?? "nyx.config.yaml";
  // Phase 6.1: the dev-only egress escape hatch — same double condition as
  // the CLI (NYX_ENV=development AND the explicit flag); loadConfig enforces.
  const allowDirectEgress = process.argv.includes("--allow-direct-egress");
  let config: NyxConfig;
  if (existsSync(configPath)) {
    config = await loadConfig(configPath, {
      ...(allowDirectEgress ? { allowDirectEgress: true } : {}),
    });
  } else {
    config = fallbackConfig();
    process.stderr.write(
      `nyx-server: no config file at ${configPath} — using the offline fallback (mock provider, local dev sandbox)\n`,
    );
  }

  const dataDir = process.env.NYX_DATA_DIR ?? join(homedir(), ".nyx");
  mkdirSync(dataDir, { recursive: true });

  const server = createServer({ config, data_dir: dataDir });
  const host = config.server?.host ?? "127.0.0.1";
  const port = config.server?.port ?? 8787;

  if (server.auth.generated) {
    // Printed exactly once, never persisted: the operator's first login.
    process.stdout.write(
      `\n  ${SERVER_ID} — generated owner token (will differ every boot):\n  ${server.auth.owner_token}\n\n`,
    );
  }

  const handle = await server.start({ host, port });
  process.stdout.write(`  nyx-server listening on http://${host}:${handle.port}\n`);

  const shutdown = (signal: string) => {
    process.stdout.write(`\nnyx-server: ${signal} received, shutting down\n`);
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `nyx-server: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
