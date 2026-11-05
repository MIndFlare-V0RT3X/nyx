// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Engagement, SandboxSpec } from "@nyx/protocol";
import {
  containerRunArgs,
  DockerSandboxProvider,
  checkDocker,
  egressNetworkCreateArgs,
  egressNetworkGatewayInspectArgs,
} from "./docker.js";
import { isForkable } from "./fork.js";

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

  it("refuses allowlist without a binder and open always (Phase 6.1 semantics)", async () => {
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

describe("DockerSandboxProvider fork (docker daemon)", () => {
  dIt("fork commits the parent to a temp image, runs an isolated child, cleans the tag", async () => {
    const parentDir = await freshHostDir();
    const parent = await provider.provision(spec(parentDir));
    try {
      await parent.writeFile("seed.txt", "parent state");
      const before = await execFileP("docker", ["images", "--format", "{{.Repository}}", "nyx-fork-*"]).then(
        (r) => r.stdout.split("\n").filter((l) => l !== ""),
        () => [] as string[],
      );

      if (!isForkable(parent)) throw new Error("provisioned sandbox is not forkable");
      const child = await parent.fork();
      try {
        // The fork carries the parent's workspace (bind content, host-copied)…
        expect((await child.readFile("seed.txt")).toString("utf8")).toBe("parent state");
        // …and shares nothing after: child writes stay in the child.
        await child.writeFile("child-only.txt", "c");
        await expect(parent.readFile("child-only.txt")).rejects.toThrow();
        await parent.writeFile("parent-only.txt", "p");
        await expect(child.readFile("parent-only.txt")).rejects.toThrow();
        // The child is a live container of its own.
        const res = await child.exec("echo forked");
        expect(res.exit_code).toBe(0);
        expect(res.stdout).toBe("forked\n");
      } finally {
        await child.destroy();
        // The temp image tag is cleaned up (best-effort rmi fired at fork
        // time; give the daemon a beat, then check).
        await new Promise((r) => setTimeout(r, 1500));
        const after = await execFileP("docker", ["images", "--format", "{{.Repository}}", "nyx-fork-*"]).then(
          (r) => r.stdout.split("\n").filter((l) => l !== ""),
          () => [] as string[],
        );
        expect(after.filter((t) => !before.includes(t))).toEqual([]);
      }
      // The parent survived the child's destruction.
      expect((await parent.readFile("seed.txt")).toString("utf8")).toBe("parent state");
    } finally {
      await parent.destroy();
    }
  });
});

// ── Phase 6.1: the egress-proxy arg vectors (no daemon required) ────────────

describe("egress network + run arg builders (Phase 6.1)", () => {
  it("network create: internal bridge, ICC off, labeled for prune", () => {
    const args = egressNetworkCreateArgs("nyx-egress-test");
    expect(args[0]).toBe("network");
    expect(args[1]).toBe("create");
    expect(args).toContain("--internal");
    expect(args).toContain("--opt");
    expect(args).toContain("com.docker.network.bridge.enable_icc=false");
    expect(args).toContain("--label");
    expect(args).toContain("org.nyx.egress=true");
    expect(args[args.length - 1]).toBe("nyx-egress-test");
  });

  it("gateway inspect uses the IPAM template", () => {
    expect(egressNetworkGatewayInspectArgs("net1")).toEqual([
      "network",
      "inspect",
      "net1",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]);
  });

  it("run vector for an allowlist sandbox: the egress network, never 'open'", () => {
    const args = containerRunArgs({
      container: "nyx-sbx-x",
      network: "nyx-egress-test",
      hostDir: "/tmp/host",
      image: "alpine:3.20",
      limits: { memory_mb: 256, cpu: 1 },
    });
    const networkIdx = args.indexOf("--network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(args[networkIdx + 1]).toBe("nyx-egress-test");
    expect(args).toContain("--memory");
    expect(args).toContain("256m");
    expect(args).toContain("--cpus");
    expect(args).toContain("1");
    expect(args.slice(-3)).toEqual(["alpine:3.20", "sleep", "infinity"]);
  });

  it("FD-LEAK / UNIX-SOCKET-PASS: no run vector ever mounts a socket or anything outside the workspace bind", () => {
    // The only bind mount any container gets is <hostDir>:/workspace —
    // /var/run/docker.sock, abstract sockets, and every other host path are
    // structurally absent from the vectors (docs/EGRESS-PROXY.md).
    for (const network of ["none", "nyx-egress-test"]) {
      const args = containerRunArgs({
        container: "c",
        network,
        hostDir: "/tmp/sbx",
        image: "alpine:3.20",
      });
      const mounts = args.filter((_, i) => args[i - 1] === "-v");
      expect(mounts).toEqual(["/tmp/sbx:/workspace"]);
      const flat = args.join(" ");
      expect(flat).not.toContain("docker.sock");
      expect(flat).not.toContain("/var/run");
      expect(flat).not.toContain(".sock");
      expect(flat).not.toContain("--privileged");
      expect(flat).not.toContain("--pid=host");
      expect(flat).not.toContain("--network=host");
      expect(flat).not.toContain("--net=host");
    }
  });

  it("provision with allowlist but NO binder is refused (no proxy, no tools)", async () => {
    const hostDir = await freshHostDir();
    const noBinder = new DockerSandboxProvider();
    const err = await noBinder
      .provision(
        spec(hostDir, {
          network: "allowlist",
          egress: { session_id: "s1", engagement: fakeEngagement() },
        }),
      )
      .then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain("no proxy, no tools");
  });

  it("provision with allowlist but no spec.egress identity is refused", async () => {
    const hostDir = await freshHostDir();
    const binder = new DockerSandboxProvider({
      egress: {
        bindNetwork: async () => {
          throw new Error("should not be called");
        },
        unbindNetwork: async () => undefined,
      },
    });
    const err = await binder
      .provision(spec(hostDir, { network: "allowlist" }))
      .then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain("spec.egress");
  });

  it("local provider refuses allowlist (no container boundary)", async () => {
    const { LocalSandboxProvider: Local } = await import("./local.js");
    const local = new Local({ root: await freshHostDir() });
    const err = await local
      .provision(spec("/tmp/unused", { network: "allowlist" }))
      .then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain("container boundary");
  });
});

function fakeEngagement(): Engagement {
  return {
    id: "ENG-DOCKER-TEST",
    operator_id: "owner",
    authorized_at: Date.now() - 1000,
    expires_at: Date.now() + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
    techniques: ["web_enumeration"],
  };
}
