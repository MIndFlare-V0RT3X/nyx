// SPDX-License-Identifier: AGPL-3.0-or-later
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathEscapeError, assertRealpathContained, resolveContained } from "./paths.js";

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-paths-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("resolveContained", () => {
  const workdir = "/tmp/nyx-workdir";

  it("rejects ../../etc/passwd", () => {
    expect(() => resolveContained(workdir, "../../etc/passwd")).toThrowError(PathEscapeError);
  });

  it("rejects an absolute path outside the workdir", () => {
    expect(() => resolveContained(workdir, "/etc/passwd")).toThrowError(PathEscapeError);
  });

  it("rejects sibling dirs sharing the workdir prefix", () => {
    expect(() => resolveContained(workdir, "/tmp/nyx-workdirx/file")).toThrowError(
      PathEscapeError,
    );
  });

  it("only judges the final resolved path: leaving and re-entering is allowed", () => {
    // Resolves to /tmp/nyx-workdir/b — contained, so the pure check passes.
    expect(resolveContained(workdir, "a/../../nyx-workdir/b")).toBe(
      path.join(workdir, "b"),
    );
  });

  it("allows sub/../ok.txt (stays within)", () => {
    expect(resolveContained(workdir, "sub/../ok.txt")).toBe(
      path.join(workdir, "ok.txt"),
    );
  });

  it("allows an absolute path inside the workdir", () => {
    expect(resolveContained(workdir, path.join(workdir, "x"))).toBe(
      path.join(workdir, "x"),
    );
  });

  it("allows the workdir itself and empty/./ targets", () => {
    expect(resolveContained(workdir, "")).toBe(workdir);
    expect(resolveContained(workdir, ".")).toBe(workdir);
    expect(resolveContained(workdir, "a/..")).toBe(workdir);
  });

  it("rejects root-relative escapes from a nested workdir", () => {
    const nested = path.join(workdir, "sub");
    expect(() => resolveContained(nested, "../..")).toThrowError(PathEscapeError);
    // a single ".." already leaves the nested workdir
    expect(() => resolveContained(nested, "..")).toThrowError(PathEscapeError);
    expect(resolveContained(nested, "x/..")).toBe(nested);
  });

  it("throws an error naming the offending path and workdir with code path_escape", () => {
    try {
      resolveContained(workdir, "../../etc/passwd");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e).toBeInstanceOf(PathEscapeError);
      expect(e.code).toBe("path_escape");
      expect(e.message).toContain("../../etc/passwd");
      expect(e.message).toContain(workdir);
    }
  });
});

describe("assertRealpathContained", () => {
  it("returns the realpath of a contained file", async () => {
    const workdir = await tmpDir();
    await fsp.writeFile(path.join(workdir, "a.txt"), "hi");
    const real = await assertRealpathContained(workdir, "a.txt");
    expect(real).toBe(path.join(await fsp.realpath(workdir), "a.txt"));
  });

  it("allows a missing file under an existing contained dir (writeFile case)", async () => {
    const workdir = await tmpDir();
    await fsp.mkdir(path.join(workdir, "sub"));
    const real = await assertRealpathContained(workdir, "sub/new.txt");
    expect(real).toBe(path.join(await fsp.realpath(workdir), "sub", "new.txt"));
  });

  it("rejects a symlink inside the workdir pointing at an outside file", async () => {
    const workdir = await tmpDir();
    const outside = await tmpDir();
    const outsideFile = path.join(outside, "secret.txt");
    await fsp.writeFile(outsideFile, "outside");
    await fsp.symlink(outsideFile, path.join(workdir, "link"));
    await expect(assertRealpathContained(workdir, "link")).rejects.toThrowError(
      PathEscapeError,
    );
  });

  it("rejects a symlinked dir inside the workdir pointing outside", async () => {
    const workdir = await tmpDir();
    const outside = await tmpDir();
    await fsp.writeFile(path.join(outside, "f.txt"), "x");
    await fsp.symlink(outside, path.join(workdir, "linkdir"));
    await expect(
      assertRealpathContained(workdir, "linkdir/f.txt"),
    ).rejects.toThrowError(PathEscapeError);
  });

  it("rejects a dangling symlink pointing outside (writeFile escape)", async () => {
    const workdir = await tmpDir();
    await fsp.symlink("/etc/definitely-not-here-yet", path.join(workdir, "dangling"));
    await expect(assertRealpathContained(workdir, "dangling")).rejects.toThrowError(
      PathEscapeError,
    );
  });

  it("allows a symlink pointing back inside the workdir", async () => {
    const workdir = await tmpDir();
    await fsp.writeFile(path.join(workdir, "real.txt"), "x");
    await fsp.symlink(path.join(workdir, "real.txt"), path.join(workdir, "alias"));
    const real = await assertRealpathContained(workdir, "alias");
    expect(real).toBe(path.join(await fsp.realpath(workdir), "real.txt"));
  });

  it("works when the workdir itself is reached through a symlink", async () => {
    const real = await tmpDir();
    const holder = await tmpDir();
    const alias = path.join(holder, "alias");
    await fsp.symlink(real, alias);
    await fsp.writeFile(path.join(real, "a.txt"), "x");
    const got = await assertRealpathContained(alias, "a.txt");
    expect(got).toBe(path.join(await fsp.realpath(real), "a.txt"));
    await expect(assertRealpathContained(alias, "../escape.txt")).rejects.toThrowError(
      PathEscapeError,
    );
  });
});
