// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §4 acceptance — the local fork: a filesystem COPY of the parent
// with no shared state in either direction, and the artifacts dir reset.

import { afterAll, describe, expect, it } from "vitest";
import type { Sandbox } from "@nyx/protocol";
import { LocalSandboxProvider } from "./local.js";
import { ensureArtifactsDir, forkSandbox, isForkable } from "./fork.js";

const provider = new LocalSandboxProvider();
const created: Sandbox[] = [];

async function newSandbox(): Promise<Sandbox> {
  const sbx = await provider.provision({ provider: "local", workdir: "", network: "none" });
  created.push(sbx);
  return sbx;
}

afterAll(async () => {
  while (created.length > 0) {
    await created
      .pop()!
      .destroy()
      .catch(() => undefined);
  }
});

describe("fork (local provider)", () => {
  it("the child starts as a copy of the parent and then shares NOTHING", async () => {
    const parent = await newSandbox();
    await parent.writeFile("seed.txt", "parent state");
    await parent.writeFile("artifacts/leftover.txt", "inherited handoff content");

    const child = await forkSandbox(parent);
    created.push(child);
    expect(child.id).not.toBe(parent.id);
    expect(child.workdir).not.toBe(parent.workdir);

    // The copy carries the parent's pre-fork state…
    expect((await child.readFile("seed.txt")).toString("utf8")).toBe("parent state");
    // …including the (to-be-reset) artifacts dir.
    expect((await child.readFile("artifacts/leftover.txt")).toString("utf8")).toBe(
      "inherited handoff content",
    );

    // ensureArtifactsDir resets the channel: inherited handoff content must
    // not leak back out as if this child had published it.
    await ensureArtifactsDir(child);
    expect((await child.list("artifacts")).length).toBe(0);

    // Isolation, child → parent: a child write never reaches the parent.
    await child.writeFile("child-only.txt", "from the child");
    await expect(parent.readFile("child-only.txt")).rejects.toThrow();
    // Isolation, parent → child: a post-fork parent write never reaches the child.
    await parent.writeFile("parent-only.txt", "after the fork");
    await expect(child.readFile("parent-only.txt")).rejects.toThrow();
  });

  it("destroying the child leaves the parent intact (and vice versa)", async () => {
    const parent = await newSandbox();
    await parent.writeFile("keep.txt", "kept");
    const child = await forkSandbox(parent);
    await child.writeFile("gone.txt", "gone");

    await child.destroy();
    await expect(child.readFile("gone.txt")).rejects.toThrow();
    expect((await parent.readFile("keep.txt")).toString("utf8")).toBe("kept");
  });

  it("isForkable distinguishes capable sandboxes; forkSandbox refuses the rest loudly", async () => {
    const parent = await newSandbox();
    expect(isForkable(parent)).toBe(true);
    const fake: Sandbox = {
      id: "fake",
      workdir: "/tmp/fake",
      exec: async () => ({
        exit_code: 0,
        stdout: "",
        stderr: "",
        duration_ms: 0,
        truncated: false,
      }),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => undefined,
      list: async () => [],
      destroy: async () => undefined,
    };
    expect(isForkable(fake)).toBe(false);
    await expect(forkSandbox(fake)).rejects.toMatchObject({ code: "not_supported" });
  });

  it("grandchildren: a fork of a fork is isolated from both ancestors", async () => {
    const root = await newSandbox();
    await root.writeFile("root.txt", "root");
    const child = await forkSandbox(root);
    created.push(child);
    const grandchild = await forkSandbox(child);
    created.push(grandchild);
    expect((await grandchild.readFile("root.txt")).toString("utf8")).toBe("root");
    await grandchild.writeFile("g.txt", "g");
    await expect(child.readFile("g.txt")).rejects.toThrow();
    await expect(root.readFile("g.txt")).rejects.toThrow();
  });
});
