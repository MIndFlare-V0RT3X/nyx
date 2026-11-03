// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx run` acceptance: one-shot against the mock provider (streamed reply,
// exit 0), a tool round with visible file side effects in the session
// sandbox, and the non-interactive auto-deny path (R2 ask → denied after the
// grace period, turn still completes).

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mockTextTurn, mockToolTurn } from "@nyx/model";
import { runOneShot } from "./run.js";
import {
  captureOutput,
  findSandboxFile,
  loopbackEngagement,
  loopbackServer,
  makeRig,
  repeatingMock,
  scriptedMock,
} from "./harness.test.js";

describe("runOneShot", () => {
  it("streams the mock reply to stdout and exits 0", async () => {
    const rig = await makeRig();
    const out = captureOutput();
    const result = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "hello",
      providers: [scriptedMock([mockTextTurn("hello from the mock provider")])],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(result.exit_code).toBe(0);
    expect(out.stdout.toString()).toContain("hello from the mock provider");
    // stdout ends with a newline; stderr carried the session id.
    expect(out.stdout.toString().endsWith("\n")).toBe(true);
    expect(out.stderr.toString()).toContain(`session ${result.session_id}`);
    expect(result.assistant_text).toBe("hello from the mock provider");
  });

  it("reuses a session via --session and serves a second turn", async () => {
    const rig = await makeRig();
    const out = captureOutput();
    const first = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "first",
      providers: [repeatingMock("first reply")],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    const second = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "second",
      session_id: first.session_id,
      providers: [repeatingMock("second reply")],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(second.exit_code).toBe(0);
    expect(second.session_id).toBe(first.session_id);
    expect(out.stdout.toString()).toContain("second reply");
  });

  it("tool round: transcript lines for call + result, file visible in the sandbox workdir", async () => {
    const rig = await makeRig();
    const out = captureOutput();
    const result = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "write a note",
      providers: [
        scriptedMock([
          mockToolTurn({
            call_id: "c1",
            name: "fs.write",
            input: { path: "notes/out.txt", content: "sandbox side effect" },
          }),
          mockTextTurn("wrote the note"),
        ]),
      ],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(result.exit_code).toBe(0);
    const stderr = out.stderr.toString();
    expect(stderr).toContain("→ fs.write");
    expect(stderr).toContain('{"path":"notes/out.txt","content":"sandbox side effect"}');
    expect(stderr).toContain("✓ fs.write");
    expect(out.stdout.toString()).toContain("wrote the note");

    const file = await findSandboxFile(rig.dirs.sandboxRoot, "notes/out.txt");
    expect(file).not.toBeNull();
    expect(await readFile(file as string, "utf8")).toBe("sandbox side effect");
  });

  it("non-interactive approval: auto-denied after ~2s with the note; the turn still completes", async () => {
    const rig = await makeRig();
    const server = await loopbackServer("target body");
    try {
      const out = captureOutput();
      const started = Date.now();
      const result = await runOneShot({
        config: rig.config,
        data_dir: rig.dirs.data,
        message: "fetch it",
        engagement: loopbackEngagement(),
        providers: [
          scriptedMock([
            mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: server.url } }),
            mockTextTurn("turn finished after the denial"),
          ]),
        ],
        stdout: out.stdout,
        stderr: out.stderr,
      });
      const elapsed = Date.now() - started;

      expect(result.exit_code).toBe(0);
      expect(out.stdout.toString()).toContain("turn finished after the denial");
      const stderr = out.stderr.toString();
      expect(stderr).toContain("⏸ approval required:");
      expect(stderr).toContain("approval required in non-interactive mode — denied; use `nyx chat`");
      expect(stderr).toContain("✗ web.fetch: denied (approval)");
      // The denial path must actually have waited for the grace period, and
      // must not have hung: comfortably between 2s and a 10s sanity bound.
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  });

  it("the approval lifecycle events land in the session log in order", async () => {
    const rig = await makeRig();
    const server = await loopbackServer("body");
    try {
      const out = captureOutput();
      const result = await runOneShot({
        config: rig.config,
        data_dir: rig.dirs.data,
        message: "fetch it",
        engagement: loopbackEngagement(),
        providers: [
          scriptedMock([
            mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: server.url } }),
            mockTextTurn("done"),
          ]),
        ],
        stdout: out.stdout,
        stderr: out.stderr,
      });
      expect(result.exit_code).toBe(0);
      const { openSessionStore } = await import("@nyx/session");
      const store = openSessionStore(`${rig.dirs.data}/nyx.db`);
      try {
        const events = await store.read(result.session_id);
        const types = events.map((e) => e.type);
        const requested = types.indexOf("approval.requested");
        const resolved = types.indexOf("approval.resolved");
        const denied = types.indexOf("action.denied");
        expect(requested).toBeGreaterThanOrEqual(0);
        expect(resolved).toBeGreaterThan(requested);
        expect(denied).toBeGreaterThan(requested);
        const resolvedEvent = events.find((e) => e.type === "approval.resolved");
        expect(resolvedEvent).toMatchObject({
          decision: "deny",
          decided_by: "cli:non-interactive",
        });
      } finally {
        store.close();
      }
    } finally {
      await server.close();
    }
  });

  it("a failing turn exits 1 with the failure on stderr", async () => {
    const rig = await makeRig();
    const out = captureOutput();
    const result = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "fail please",
      providers: [scriptedMock([{ fail: { name: "ProviderError", message: "mock provider exploded" } }])],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(result.exit_code).toBe(1);
    expect(out.stderr.toString()).toContain("turn failed");
    expect(out.stderr.toString()).toContain("mock provider exploded");
  });

  it("an unknown session id exits 1 without starting a turn", async () => {
    const rig = await makeRig();
    const out = captureOutput();
    const result = await runOneShot({
      config: rig.config,
      data_dir: rig.dirs.data,
      message: "hello",
      session_id: "no-such-session",
      providers: [repeatingMock("x")],
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(result.exit_code).toBe(1);
    expect(out.stderr.toString()).toContain("session no-such-session not found");
  });
});
