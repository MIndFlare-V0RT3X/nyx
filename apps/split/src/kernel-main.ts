// SPDX-License-Identifier: AGPL-3.0-or-later
// nyx-kernel — the KERNEL PROCESS binary (Phase 7.3). Hosts the trusted
// zone (config, credential vault, policy, audit, nyx.db, memory, tasks) and
// the token-authenticated kernel socket.
//
// Boot: nyx-kernel --config <file> --data-dir <dir>
//   stdout: {"ok":true,"socket":…,"token_file":…,"pid":…}
// Shutdown: SIGTERM/SIGINT — closes the socket, verifies the audit chain,
//   exits 0.
//
// Token rotation: whenever the last AGENT connection closes (the agent
// process exited — normally or not), the boot token rotates atomically. A
// restarting agent reads the fresh file at ITS boot; the pre-restart token
// is dead the moment rotation lands, so it cannot be replayed.

import { mkdir } from "node:fs/promises";
import { pino } from "pino";
import { loadConfig } from "@nyx/config";
import { IpcServer } from "@nyx/ipc";
import { generateIpcToken, rotateTokenFile, runtimePaths, writeTokenFile } from "@nyx/ipc";
import { startKernelHost } from "./kernel-host.js";

interface KernelArgs {
  configPath: string;
  dataDir: string;
}

function parseArgs(argv: string[]): KernelArgs {
  const args: KernelArgs = {
    configPath: process.env.NYX_CONFIG_PATH ?? "nyx.config.yaml",
    dataDir: process.env.NYX_DATA_DIR ?? "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--config" && next !== undefined) {
      args.configPath = next;
      i += 1;
    } else if (arg === "--data-dir" && next !== undefined) {
      args.dataDir = next;
      i += 1;
    }
  }
  if (args.dataDir.length === 0) {
    process.stderr.write("nyx-kernel: --data-dir <dir> is required\n");
    process.exit(2);
  }
  return args;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const logger = pino({ level: process.env.NYX_LOG_LEVEL ?? "warn" });
  const config = await loadConfig(args.configPath);
  const paths = runtimePaths(args.dataDir);
  await mkdir(paths.runtimeDir, { recursive: true });

  const host = await startKernelHost({ config, dataDir: args.dataDir });

  // Boot token + rotation-on-agent-exit.
  let token = generateIpcToken();
  await writeTokenFile(paths.kernelTokenFile, token);

  const server = new IpcServer({
    socketPath: paths.kernelSocket,
    token: () => token,
    serverVersion: "nyx-kernel",
    handler: host.handler,
    onListening: () => {
      logger.info(
        { socket: paths.kernelSocket, token_file: paths.kernelTokenFile, pid: process.pid },
        "nyx-kernel listening",
      );
    },
    // R1-5 (fan-out): rotate on EVERY authenticated disconnect (not just
    // the agent's) — rotation is the replay defense, and any client going
    // away is a restart about to read the fresh file. The write is the
    // ATOMIC rotateTokenFile (temp + rename; a booting client never sees a
    // torn file) and the in-memory swap only lands after the file does.
    onDisconnect: () => {
      void rotateTokenFile(paths.kernelTokenFile)
        .then((rotated) => {
          token = rotated.token;
          logger.info("ipc token rotated (client disconnected)");
        })
        .catch(() => {
          // A failed rotation must never kill the kernel; the old token
          // simply stays valid until the next disconnect retries.
          logger.warn("ipc token rotation failed; keeping the current token");
        });
    },
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "nyx-kernel shutting down");
    void server.stop().then(async () => {
      const audit = host.verifyAudit();
      logger.info({ ok: audit.ok, checked: audit.checked }, "audit chain verified at shutdown");
      await host.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await server.start();
  process.stdout.write(
    `${JSON.stringify({ ok: true, socket: paths.kernelSocket, token_file: paths.kernelTokenFile, pid: process.pid })}\n`,
  );
  await new Promise<void>(() => undefined); // run until signalled
}

main().catch((err: unknown) => {
  process.stderr.write(
    `nyx-kernel: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
