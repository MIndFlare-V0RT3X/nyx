// SPDX-License-Identifier: AGPL-3.0-or-later
// nyx-tools — the TOOLS PROCESS binary (Phase 7.3). Hosts the tool
// registry, tool runtime, and sandbox provider; a CLIENT of the kernel
// socket for policy/approvals; a SERVER on the tools socket for the agent.
//
// Boot: nyx-tools --config <file> --data-dir <dir>
//   stdout: {"ok":true,"socket":…,"pid":…}

import { mkdir } from "node:fs/promises";
import { pino } from "pino";
import { loadConfig } from "@nyx/config";
import { IpcClient, IpcServer } from "@nyx/ipc";
import { generateIpcToken, readTokenFile, runtimeDirPaths, writeTokenFile } from "@nyx/ipc";
import { startToolsHost } from "./tools-host.js";

interface ToolsArgs {
  configPath: string;
  runtimeDir: string;
}

function parseArgs(argv: string[]): ToolsArgs {
  const args: ToolsArgs = {
    configPath: process.env.NYX_CONFIG_PATH ?? "nyx.config.yaml",
    runtimeDir: process.env.NYX_RUNTIME_DIR ?? "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--config" && next !== undefined) {
      args.configPath = next;
      i += 1;
    } else if (arg === "--runtime-dir" && next !== undefined) {
      args.runtimeDir = next;
      i += 1;
    }
  }
  if (args.runtimeDir.length === 0) {
    process.stderr.write("nyx-tools: --runtime-dir <dir> is required\n");
    process.exit(2);
  }
  return args;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const logger = pino({ level: process.env.NYX_LOG_LEVEL ?? "warn" });
  const config = await loadConfig(args.configPath);
  // The tools process learns the RUNTIME dir (sockets + tokens) — never the
  // data dir (nyx.db is kernel-only).
  const paths = runtimeDirPaths(args.runtimeDir);
  await mkdir(paths.runtimeDir, { recursive: true });

  // Client of the kernel (policy/approvals live there).
  const kernelToken = await readTokenFile(paths.kernelTokenFile);
  const kernel = new IpcClient({
    socketPath: paths.kernelSocket,
    token: kernelToken,
    role: "tools",
    timeoutMs: 180_000,
  });
  await kernel.connect();

  const host = await startToolsHost({ config, dataDir: paths.runtimeDir, kernel, logger });

  // Server for the agent.
  const toolsToken = generateIpcToken();
  await writeTokenFile(paths.toolsTokenFile, toolsToken);
  const server = new IpcServer({
    socketPath: paths.toolsSocket,
    token: toolsToken,
    serverVersion: "nyx-tools",
    handler: host.handler,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "nyx-tools shutting down");
    void server.stop().then(async () => {
      await host.close();
      await kernel.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await server.start();
  process.stdout.write(
    `${JSON.stringify({ ok: true, socket: paths.toolsSocket, token_file: paths.toolsTokenFile, pid: process.pid })}\n`,
  );
  await new Promise<void>(() => undefined); // run until signalled
}

main().catch((err: unknown) => {
  process.stderr.write(`nyx-tools: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
