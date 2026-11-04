// SPDX-License-Identifier: AGPL-3.0-or-later
// Centralized path containment for sandboxed filesystem access.
//
// resolveContained() is pure path algebra (no fs): it resolves a target
// against a workdir and refuses anything that lands outside it.
// assertRealpathContained() additionally resolves symlinks via fs.realpath
// so a link planted inside the workdir cannot point the operation outside.
//
// @nyx/tools reuses these helpers for its file tools; every sandbox
// provider re-enforces them on its own file APIs.

import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** Thrown when a path resolves outside the sandbox workdir. */
export class PathEscapeError extends Error {
  code = "path_escape" as const;
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/**
 * Resolve `target` against `workdir` and return the absolute result.
 * Throws PathEscapeError unless the result is `workdir` itself or a path
 * underneath it. Pure string/path check — no filesystem access, so it
 * catches `../../etc/passwd`, absolute paths outside the workdir, and
 * `..` chains that leave and re-enter, while allowing `..` segments that
 * stay inside and absolute paths that are already inside.
 */
export function resolveContained(workdir: string, target: string): string {
  const base = path.resolve(workdir);
  const resolved = path.resolve(base, target);
  // path.sep suffix so "/workdirx" is not accepted as inside "/workdir";
  // the filesystem root is its own prefix.
  const prefix = base === path.sep ? path.sep : base + path.sep;
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new PathEscapeError(
      `path "${target}" escapes sandbox workdir "${base}" (resolved to "${resolved}")`,
    );
  }
  return resolved;
}

/** Bound on symlink hops when chasing a possibly-dangling final component. */
const MAX_SYMLINK_FOLLOWS = 40;

/**
 * Like fs.realpath, but tolerates a missing final path (writing a new file)
 * by resolving the deepest existing ancestor. Dangling symlinks are followed
 * through readlink so that a link pointing outside the workdir is caught
 * even when its target does not exist yet.
 */
async function realpathAllowMissing(p: string, follows: number): Promise<string> {
  if (follows > MAX_SYMLINK_FOLLOWS) {
    throw new Error(`too many levels of symbolic links while resolving "${p}"`);
  }
  try {
    return await fsp.realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
    let isLink = false;
    try {
      isLink = (await fsp.lstat(p)).isSymbolicLink();
    } catch {
      // p itself is missing (or an ancestor is) — fall through to the parent.
    }
    if (isLink) {
      const link = await fsp.readlink(p);
      const next = path.isAbsolute(link) ? link : path.resolve(path.dirname(p), link);
      return realpathAllowMissing(next, follows + 1);
    }
    const parent = path.dirname(p);
    if (parent === p) throw err;
    return path.join(await realpathAllowMissing(parent, follows), path.basename(p));
  }
}

/**
 * realpath-verified containment: resolve `target` against `workdir`, resolve
 * symlinks on both ends, and re-verify that the real path is still inside the
 * real workdir. Catches symlink escapes (a symlink inside the workdir that
 * points outside). Returns the verified real path — callers should perform
 * the actual fs operation on the returned value, not on their original input.
 */
export async function assertRealpathContained(workdir: string, target: string): Promise<string> {
  const base = path.resolve(workdir);
  const resolved = resolveContained(base, target);
  const realBase = await fsp.realpath(base);
  const prefix = realBase === path.sep ? path.sep : realBase + path.sep;
  const candidate = await realpathAllowMissing(resolved, 0);
  if (candidate !== realBase && !candidate.startsWith(prefix)) {
    throw new PathEscapeError(
      `path "${target}" escapes sandbox workdir "${base}" via symlink (realpath is "${candidate}")`,
    );
  }
  return candidate;
}
