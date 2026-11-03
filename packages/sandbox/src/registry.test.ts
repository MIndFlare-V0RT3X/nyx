// SPDX-License-Identifier: AGPL-3.0-or-later
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SandboxProvider } from "@nyx/protocol";
import { DockerSandboxProvider } from "./docker.js";
import { LocalSandboxProvider } from "./local.js";
import { SandboxProviders, createDefaultSandboxRegistry } from "./registry.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-registry-"));

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("SandboxProviders", () => {
  it("registers, gets and lists providers", () => {
    const local = new LocalSandboxProvider({ root });
    const docker = new DockerSandboxProvider();
    const reg = new SandboxProviders().register(local).register(docker);
    expect(reg.list()).toEqual(["docker", "local"]);
    expect(reg.get("local")).toBe(local);
    expect(reg.get("docker")).toBe(docker);
  });

  it("get throws for an unknown provider id", () => {
    const reg = new SandboxProviders();
    expect(() => reg.get("nope")).toThrowError(/unknown sandbox provider "nope"/);
  });

  it("register throws on duplicate ids", () => {
    const reg = new SandboxProviders().register(new LocalSandboxProvider({ root }));
    expect(() => reg.register(new LocalSandboxProvider({ root }))).toThrowError(
      /already registered/,
    );
  });

  it("satisfies the protocol SandboxProvider shape", () => {
    const local: SandboxProvider = new LocalSandboxProvider({ root });
    const reg = new SandboxProviders().register(local);
    const got: SandboxProvider = reg.get("local");
    expect(typeof got.provision).toBe("function");
    expect(got.id).toBe("local");
  });

  it("provisions through the registry", async () => {
    const reg = new SandboxProviders().register(new LocalSandboxProvider({ root }));
    const sb = await reg.get("local").provision({
      provider: "local",
      workdir: "",
      network: "none",
    });
    try {
      const res = await sb.exec("echo via-registry");
      expect(res.stdout).toBe("via-registry\n");
    } finally {
      await sb.destroy();
    }
  });
});

describe("createDefaultSandboxRegistry", () => {
  it("pre-registers the built-in providers", () => {
    const reg = createDefaultSandboxRegistry();
    expect(reg.list()).toEqual(["docker", "local"]);
    expect(reg.get("local")).toBeInstanceOf(LocalSandboxProvider);
    expect(reg.get("docker")).toBeInstanceOf(DockerSandboxProvider);
  });
});
