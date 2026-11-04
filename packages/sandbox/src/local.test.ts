// SPDX-License-Identifier: AGPL-3.0-or-later
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Sandbox, SandboxSpec } from "@nyx/protocol";
import { LocalSandboxProvider } from "./local.js";
import { PathEscapeError } from "./paths.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-local-sbx-"));
const provider = new LocalSandboxProvider({ root });

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function spec(extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return { provider: "local", workdir: "", network: "none", ...extra };
}

async function withSandbox(s: SandboxSpec, fn: (sb: Sandbox) => Promise<void>): Promise<void> {
  const sb = await provider.provision(s);
  try {
    await fn(sb);
  } finally {
    await sb.destroy();
  }
}

describe("LocalSandboxProvider", () => {
  it("provisions a fresh workdir under the root", async () => {
    await withSandbox(spec(), async (sb) => {
      expect(sb.workdir.startsWith(path.join(root, path.sep))).toBe(true);
      const st = await fsp.stat(sb.workdir);
      expect(st.isDirectory()).toBe(true);
      expect(sb.id.length).toBeGreaterThan(0);
    });
  });

  it("execs echo hello", async () => {
    await withSandbox(spec(), async (sb) => {
      const res = await sb.exec("echo hello");
      expect(res.exit_code).toBe(0);
      expect(res.stdout).toBe("hello\n");
      expect(res.stderr).toBe("");
      expect(res.truncated).toBe(false);
      expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  it("captures stderr and non-zero exit codes", async () => {
    await withSandbox(spec(), async (sb) => {
      const res = await sb.exec("echo oops >&2; exit 3");
      expect(res.exit_code).toBe(3);
      expect(res.stderr).toBe("oops\n");
    });
  });

  it("roundtrips writeFile/readFile (text and binary)", async () => {
    await withSandbox(spec(), async (sb) => {
      await sb.writeFile("a.txt", "hello world");
      expect((await sb.readFile("a.txt")).toString("utf8")).toBe("hello world");

      await fsp.mkdir(path.join(sb.workdir, "sub"));
      await sb.writeFile("sub/bin.dat", Buffer.from(Uint8Array.from({ length: 256 }, (_, i) => i)));
      expect(await sb.readFile("sub/bin.dat")).toEqual(
        Buffer.from(Uint8Array.from({ length: 256 }, (_, i) => i)),
      );

      // Absolute path inside the workdir is allowed.
      expect((await sb.readFile(path.join(sb.workdir, "a.txt"))).toString("utf8")).toBe(
        "hello world",
      );
    });
  });

  it("lists entries with types and sizes", async () => {
    await withSandbox(spec(), async (sb) => {
      await sb.writeFile("one.txt", "12345");
      await sb.writeFile("two.txt", "1234567");
      await fsp.mkdir(path.join(sb.workdir, "adir"));
      const entries = await sb.list(".");
      expect(entries).toEqual([
        { name: "adir", type: "dir", size: 0 },
        { name: "one.txt", type: "file", size: 5 },
        { name: "two.txt", type: "file", size: 7 },
      ]);
    });
  });

  it("execs with a contained cwd", async () => {
    await withSandbox(spec(), async (sb) => {
      await sb.exec("mkdir sub");
      const res = await sb.exec("pwd", { cwd: "sub" });
      expect(res.exit_code).toBe(0);
      expect(res.stdout.trim()).toBe(path.join(sb.workdir, "sub"));
      // cwd that escapes the workdir is refused before spawning.
      await expect(sb.exec("pwd", { cwd: "../.." })).rejects.toThrowError(PathEscapeError);
    });
  });

  it("kills long commands on timeout (SIGKILL marker 137)", async () => {
    await withSandbox(spec(), async (sb) => {
      const res = await sb.exec("sleep 5", { timeout_ms: 300 });
      expect(res.exit_code).toBe(137);
      expect(res.duration_ms).toBeLessThan(2000);
      expect(res.truncated).toBe(false);
    });
  });

  it("does not inherit parent env (canary var absent, HOME = workdir)", async () => {
    process.env.NYX_SANDBOX_TEST_CANARY = "leaky-value";
    try {
      await withSandbox(spec(), async (sb) => {
        const res = await sb.exec("env");
        expect(res.exit_code).toBe(0);
        expect(res.stdout).not.toContain("NYX_SANDBOX_TEST_CANARY");
        expect(res.stdout).not.toContain("leaky-value");
        expect(res.stdout).toContain(`HOME=${sb.workdir}`);
        expect(res.stdout).toContain("PATH=");
        expect(res.stdout).toContain("LANG=");
      });
    } finally {
      delete process.env.NYX_SANDBOX_TEST_CANARY;
    }
  });

  it("merges spec env and per-exec env", async () => {
    await withSandbox(spec({ env: { NYX_BASE_VAR: "from-spec" } }), async (sb) => {
      expect((await sb.exec("echo $NYX_BASE_VAR")).stdout).toBe("from-spec\n");
      expect((await sb.exec("echo $FOO", { env: { FOO: "bar" } })).stdout).toBe("bar\n");
      // per-exec env wins over the spec env
      const res = await sb.exec("echo $NYX_BASE_VAR", {
        env: { NYX_BASE_VAR: "override" },
      });
      expect(res.stdout).toBe("override\n");
    });
  });

  it("caps captured output at 1 MB and flags truncation", async () => {
    await withSandbox(spec(), async (sb) => {
      const res = await sb.exec("head -c 2097152 /dev/zero");
      expect(res.exit_code).toBe(0);
      expect(res.truncated).toBe(true);
      expect(Buffer.byteLength(res.stdout, "utf8")).toBe(1024 * 1024);
    });
  });

  it("rejects file ops through symlinks that escape the workdir", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-outside-"));
    try {
      await withSandbox(spec(), async (sb) => {
        const outsideFile = path.join(outside, "secret.txt");
        await fsp.writeFile(outsideFile, "outside");
        await fsp.symlink(outsideFile, path.join(sb.workdir, "link"));
        await fsp.symlink(outside, path.join(sb.workdir, "linkdir"));
        // dangling symlink pointing outside
        await fsp.symlink(
          path.join(outside, "not-yet-created.txt"),
          path.join(sb.workdir, "dangling"),
        );

        await expect(sb.readFile("link")).rejects.toThrowError(PathEscapeError);
        await expect(sb.readFile("linkdir/secret.txt")).rejects.toThrowError(PathEscapeError);
        await expect(sb.writeFile("dangling", "x")).rejects.toThrowError(PathEscapeError);
        await expect(sb.readFile("../../etc/passwd")).rejects.toThrowError(PathEscapeError);
        await expect(sb.writeFile("/etc/nyx-escape-test", "x")).rejects.toThrowError(
          PathEscapeError,
        );
      });
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects exec with a non-existent cwd", async () => {
    await withSandbox(spec(), async (sb) => {
      await expect(sb.exec("pwd", { cwd: "does-not-exist" })).rejects.toThrowError();
    });
  });

  it("destroy removes the workdir and is idempotent", async () => {
    const sb = await provider.provision(spec());
    const workdir = sb.workdir;
    await sb.destroy();
    await expect(fsp.stat(workdir)).rejects.toThrowError(); // ENOENT
    await expect(sb.destroy()).resolves.toBeUndefined();
  });

  describe("production guard", () => {
    it("refuses to provision when NYX_ENV=production", async () => {
      const before = process.env.NYX_ENV;
      process.env.NYX_ENV = "production";
      try {
        const err = await provider.provision(spec()).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        const e = err as Error & { code?: string };
        expect(e.code).toBe("not_implemented");
        expect(e.message).toContain("local sandbox is not allowed in production");
        expect(e.message).toContain("docker provider");
      } finally {
        if (before === undefined) delete process.env.NYX_ENV;
        else process.env.NYX_ENV = before;
      }
    });

    it("provisions when NYX_ENV is not production", async () => {
      const before = process.env.NYX_ENV;
      delete process.env.NYX_ENV;
      try {
        const sb = await provider.provision(spec());
        await sb.destroy();
      } finally {
        if (before !== undefined) process.env.NYX_ENV = before;
      }
    });

    it("refuses to provision with force_prod even outside production", async () => {
      const prodish = new LocalSandboxProvider({ root, force_prod: true });
      const err = await prodish.provision(spec()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { code?: string }).code).toBe("not_implemented");
    });
  });
});
