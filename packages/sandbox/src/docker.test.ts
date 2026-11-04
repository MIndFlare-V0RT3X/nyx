// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { SandboxSpec } from "@nyx/protocol";
import { DockerSandboxProvider, checkDocker } from "./docker.js";

const execFileP = promisify(execFile);

// Docker-dependent tests skip when the daemon is missing or NYX_SKIP_DOCKER
// is set. The first docker test pays the alpine:3.20 image pull latency.
const dockerAvailable = (await checkDocker()) && !process.env.NYX_SKIP_DOCKER;
const dIt = (name: string, fn: () => Promise<void>, timeout = 120_000): void => {
  if (dockerAvailable) it(name, fn, timeout);
  else it.skip(name, fn, timeout);
};

const provider = new DockerSandboxProvider();
const tmpRoots: string[] = [];

async function freshHostDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-docker-sbx-"));
  tmpRoots.push(dir);
  return dir;
}

function spec(workdir: string, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return { provider: "docker", workdir, network: "none", ...extra };
}

async function dockerInspectFails(container: string): Promise<boolean> {
  try {
    await execFileP("docker", ["inspect", container]);
    return false;
  } catch {
    return true;
  }
}

afterAll(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("DockerSandboxProvider (no daemon required)", () => {
  it("checkDocker is false for a missing docker binary", async () => {
    expect(await checkDocker("nyx-no-such-docker-bin")).toBe(false);
  });

  it("refuses network modes other than none in Phase 0", async () => {
    const hostDir = await freshHostDir();
    for (const network of ["allowlist", "open"] as const) {
      const err = await provider.provision(spec(hostDir, { network })).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const e = err as Error & { code?: string };
      expect(e.code).toBe("not_implemented");
      expect(e.message).toContain(network);
      expect(e.message).toContain("egress");
    }
  });

  it("throws not_implemented mentioning Docker when the binary is missing", async () => {
    const hostDir = await freshHostDir();
    const noDocker = new DockerSandboxProvider({ dockerBin: "nyx-no-such-docker-bin" });
    const err = await noDocker.provision(spec(hostDir)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { code?: string };
    expect(e.code).toBe("not_implemented");
    expect(e.message).toContain("Docker");
  });
});

describe("DockerSandboxProvider (docker daemon)", () => {
  dIt("execs echo hello", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      const res = await sb.exec("echo hello");
      expect(res.exit_code).toBe(0);
      expect(res.stdout).toBe("hello\n");
      expect(res.stderr).toBe("");
      expect(res.truncated).toBe(false);
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await sb.destroy();
    }
  });

  dIt("roundtrips writeFile/readFile through the bind mount", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      const bytes = Buffer.from(Uint8Array.from({ length: 256 }, (_, i) => i));
      await sb.writeFile("bin.dat", bytes);
      await sb.writeFile("txt.txt", "hello docker");
      expect(await sb.readFile("bin.dat")).toEqual(bytes);
      expect((await sb.readFile("txt.txt")).toString("utf8")).toBe("hello docker");

      // The container writes land on the host bind source.
      const hostCopy = await fsp.readFile(path.join(hostDir, "txt.txt"));
      expect(hostCopy.toString("utf8")).toBe("hello docker");

      await expect(sb.readFile("no-such-file.txt")).rejects.toThrowError();
    } finally {
      await sb.destroy();
    }
  });

  dIt("lists entries with types and sizes", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      await sb.writeFile("one.txt", "12345");
      await sb.writeFile("two.txt", "1234567");
      await sb.exec("mkdir adir");
      const entries = await sb.list(".");
      expect(entries).toEqual([
        { name: "adir", type: "dir", size: 0 },
        { name: "one.txt", type: "file", size: 5 },
        { name: "two.txt", type: "file", size: 7 },
      ]);
    } finally {
      await sb.destroy();
    }
  });

  dIt("execs with a contained cwd", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      await sb.exec("mkdir sub");
      const res = await sb.exec("pwd", { cwd: "sub" });
      expect(res.exit_code).toBe(0);
      expect(res.stdout.trim()).toBe("/workspace/sub");
      // cwd outside /workspace is refused before invoking docker.
      await expect(sb.exec("pwd", { cwd: "../.." })).rejects.toThrowError();
    } finally {
      await sb.destroy();
    }
  });

  dIt("destroy removes the container and a host dir it created", async () => {
    const hostBase = await freshHostDir();
    const hostDir = path.join(hostBase, "created-by-provision");
    const sb = await provider.provision(spec(hostDir));
    const container = sb.id;
    expect(container.startsWith("nyx-sbx-")).toBe(true);
    expect(sb.workdir).toBe("/workspace");
    expect(await dockerInspectFails(container)).toBe(false);

    await sb.destroy();
    expect(await dockerInspectFails(container)).toBe(true);
    // We created hostDir during provision, so destroy removed it again.
    await expect(fsp.stat(hostDir)).rejects.toThrowError();
    // Idempotent.
    await expect(sb.destroy()).resolves.toBeUndefined();
  });

  dIt("kills wall-clock overruns with exit 124", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      const res = await sb.exec("sleep 10", { timeout_ms: 500 });
      expect(res.exit_code).toBe(124);
      expect(res.duration_ms).toBeLessThan(5000);
      expect(res.stderr).toContain("wall clock timeout");
    } finally {
      await sb.destroy();
    }
  });

  dIt("network is none: outbound HTTP fails", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      const res = await sb.exec("wget -q -T 3 -O /dev/null http://example.com");
      expect(res.exit_code).not.toBe(0);
    } finally {
      await sb.destroy();
    }
  });

  dIt("rejects file ops outside /workspace", async () => {
    const hostDir = await freshHostDir();
    const sb = await provider.provision(spec(hostDir));
    try {
      await expect(sb.readFile("/etc/passwd")).rejects.toThrowError();
      await expect(sb.readFile("../../etc/passwd")).rejects.toThrowError();
      await expect(sb.writeFile("/etc/nyx-escape-test", "x")).rejects.toThrowError();
    } finally {
      await sb.destroy();
    }
  });
});
