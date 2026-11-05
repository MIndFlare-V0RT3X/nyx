// SPDX-License-Identifier: AGPL-3.0-or-later
// The IPC auth token: generated at kernel boot, written 0600 next to the
// socket, rotated whenever the agent process it was minted for goes away.
// The kernel prints the FILE PATH at boot, never the token itself.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

export function generateIpcToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface TokenFile {
  file: string;
  token: string;
}

/** Write the token file with 0600 (best-effort on exotic filesystems). */
export async function writeTokenFile(file: string, token: string): Promise<void> {
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    /* some filesystems refuse chmod; the mode at creation already applied */
  }
}

/**
 * Atomically rotate the token file: write the new token to a sibling temp
 * file and rename over the old path, so a reader never sees a torn write.
 */
export async function rotateTokenFile(file: string): Promise<TokenFile> {
  const token = generateIpcToken();
  const tmp = `${file}.tmp-${Date.now()}`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  await rename(tmp, file);
  return { file, token };
}

/** Read the token (trimming the newline). Throws on missing/corrupt file. */
export async function readTokenFile(file: string): Promise<string> {
  const text = await readFile(file, "utf8");
  const token = text.trim();
  if (token.length === 0) throw new Error(`token file ${file} is empty`);
  return token;
}

/** The canonical runtime dir + file names for a split-mode data dir. */
export function runtimePaths(dataDir: string): {
  runtimeDir: string;
  kernelSocket: string;
  kernelTokenFile: string;
  toolsSocket: string;
  toolsTokenFile: string;
} {
  return runtimeDirPaths(path.join(dataDir, "runtime"));
}

/**
 * The split paths given the RUNTIME dir directly — what the tools and agent
 * processes get: they learn where the SOCKETS are, never where nyx.db
 * lives (that stays kernel-only).
 */
export function runtimeDirPaths(runtimeDir: string): {
  runtimeDir: string;
  kernelSocket: string;
  kernelTokenFile: string;
  toolsSocket: string;
  toolsTokenFile: string;
} {
  return {
    runtimeDir,
    kernelSocket: path.join(runtimeDir, "kernel.sock"),
    kernelTokenFile: path.join(runtimeDir, "kernel.token"),
    toolsSocket: path.join(runtimeDir, "tools.sock"),
    toolsTokenFile: path.join(runtimeDir, "tools.token"),
  };
}
