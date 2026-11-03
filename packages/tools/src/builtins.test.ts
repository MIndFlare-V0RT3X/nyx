// SPDX-License-Identifier: AGPL-3.0-or-later
// Builtin tool behavior through the full runtime pipeline (validation,
// containment, policy, execution) against a LocalSandboxProvider sandbox.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalEngineImpl, PolicyEngineImpl } from "@nyx/policy";
import { LocalSandboxProvider } from "@nyx/sandbox";
import { createToolRuntime } from "./runtime.js";
import type { ToolExecContext, ToolRuntime } from "./runtime.js";
import { registerBuiltinTools } from "./builtins.js";
import { ToolRegistryImpl } from "./registry.js";
import { ToolRouterImpl } from "./router.js";
import type { PolicyRule, Sandbox, SessionEvent } from "@nyx/protocol";
// @ts-expect-error better-sqlite3 is not a declared dependency of @nyx/tools; tests resolve it from the sibling @nyx/policy workspace (tests are exempt from package import boundaries per the package brief).
import Database from "../../policy/node_modules/better-sqlite3";

let provider: LocalSandboxProvider;
const roots: string[] = [];
const sandboxes: Sandbox[] = [];
const dbs: Array<{ close(): void }> = [];

const RULES: PolicyRule[] = [
  { id: "allow-fs", match: { capability: ["fs.read", "fs.write"] }, decision: "allow" },
  { id: "allow-shell", match: { tool: "shell.exec" }, decision: "allow" },
];

beforeAll(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-tools-blt-"));
  roots.push(root);
  provider = new LocalSandboxProvider({ root });
});

afterEach(async () => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    if (sb) await sb.destroy();
  }
});

afterAll(async () => {
  for (const db of dbs) db.close();
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
});

interface Rig {
  runtime: ToolRuntime;
  events: SessionEvent[];
  sandbox: Sandbox;
  exec: (name: string, input: unknown, call_id?: string) => Promise<ReturnType<ToolRuntime["execute"]>>;
}

async function makeRig(): Promise<Rig> {
  const events: SessionEvent[] = [];
  const sandbox = await provider.provision({ provider: "local", workdir: ".", network: "none" });
  sandboxes.push(sandbox);
  const registry = new ToolRegistryImpl();
  registerBuiltinTools(registry);
  const runtime = createToolRuntime({
    registry,
    router: new ToolRouterImpl(),
    policy: new PolicyEngineImpl(RULES),
    // "manual": every builtin test rule set is allow-only, so the approval
    // engine must never be consulted — a hang here fails the test.
    approvals: new ApprovalEngineImpl(newDb(), { poll_ms: 5 }),
  });
  const execCtx: ToolExecContext = {
    session_id: "sess-blt",
    turn_id: "turn-blt",
    engagement: null,
    sandbox,
    signal: new AbortController().signal,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => execCtx.logger,
    },
    emit: (e) => {
      events.push(e);
    },
  };
  const exec = (name: string, input: unknown, call_id = `call-${name}`): Promise<ToolOutputLike> =>
    runtime.execute({ call_id, name, input }, execCtx) as Promise<ToolOutputLike>;
  return { runtime, events, sandbox, exec };
}

type ToolOutputLike = { kind: string; text?: string; json?: unknown; path?: string; bytes?: number; mime?: string; artifact_id?: string };

function newDb(): { close(): void } {
  const db: { close(): void } = new Database(":memory:") as { close(): void };
  dbs.push(db);
  return db;
}

describe("builtin tools", () => {
  it("fs.read returns utf-8 text for text files (multibyte stays text)", async () => {
    const rig = await makeRig();
    await rig.sandbox.writeFile("note.md", "héllo wörld — 你好\n");
    const out = await rig.exec("fs.read", { path: "note.md" });
    expect(out).toEqual({ kind: "text", text: "héllo wörld — 你好\n" });
  });

  it("fs.read returns a file descriptor for binary content", async () => {
    const rig = await makeRig();
    const blob = Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x89, 0xfe, 0xff]);
    await rig.sandbox.writeFile("blob.bin", blob);
    const out = await rig.exec("fs.read", { path: "blob.bin" });
    expect(out.kind).toBe("file");
    expect((out as { bytes: number }).bytes).toBe(blob.length);
    expect((out as { mime: string }).mime).toBe("application/octet-stream");
    expect((out as { path: string }).path).toBe(path.join(rig.sandbox.workdir, "blob.bin"));
  });

  it("fs.read of a missing file → tool_failed (not a crash)", async () => {
    const rig = await makeRig();
    const out = await rig.exec("fs.read", { path: "nope.txt" });
    expect(out.kind).toBe("text");
    const err = rig.events.find((e) => e.type === "tool.error") as
      | { error: { code?: string } }
      | undefined;
    expect(err?.error.code).toBe("tool_failed");
  });

  it("fs.list returns sorted entries with types and sizes", async () => {
    const rig = await makeRig();
    await rig.sandbox.writeFile("a.txt", "12345");
    await rig.sandbox.exec("mkdir sub");
    await rig.sandbox.writeFile("sub/inner.txt", "x");

    const out = await rig.exec("fs.list", { path: "." });
    expect(out).toEqual({
      kind: "json",
      json: [
        { name: "a.txt", type: "file", size: 5 },
        { name: "sub", type: "dir", size: 0 },
      ],
    });

    const sub = await rig.exec("fs.list", { path: "sub" }, "call-sub");
    expect(sub).toEqual({
      kind: "json",
      json: [{ name: "inner.txt", type: "file", size: 1 }],
    });
  });

  it("fs.list defaults to the workdir when path is omitted", async () => {
    const rig = await makeRig();
    await rig.sandbox.writeFile("only.txt", "ab");
    const out = await rig.exec("fs.list", {});
    expect(out).toEqual({
      kind: "json",
      json: [{ name: "only.txt", type: "file", size: 2 }],
    });
  });

  it("fs.write writes the file and reports path + utf-8 byte count", async () => {
    const rig = await makeRig();
    const out = await rig.exec("fs.write", { path: "out/note.txt".replace("out/", ""), content: "héllo" });
    expect(out).toEqual({
      kind: "json",
      json: { path: path.join(rig.sandbox.workdir, "note.txt"), bytes: 6 },
    });
    expect((await rig.sandbox.readFile("note.txt")).toString("utf8")).toBe("héllo");
  });

  it("fs.write to an escaping path → path_escape before the handler runs", async () => {
    const rig = await makeRig();
    const out = await rig.exec("fs.write", { path: "../../evil.txt", content: "nope" });
    expect(out).toEqual({ kind: "text", text: "error: path escapes the sandbox workdir" });
    const err = rig.events.find((e) => e.type === "tool.error") as
      | { error: { code?: string } }
      | undefined;
    expect(err?.error.code).toBe("path_escape");
    const entries = await rig.sandbox.list(".");
    expect(entries).toEqual([]);
  });

  it("shell.exec returns exit/stdout/stderr in the fixed text format", async () => {
    const rig = await makeRig();
    const out = await rig.exec("shell.exec", { cmd: "echo hello" });
    expect(out).toEqual({
      kind: "text",
      text: "exit 0\n--- stdout ---\nhello\n\n--- stderr ---\n",
    });
  });

  it("shell.exec non-zero exit is a result, not a tool error", async () => {
    const rig = await makeRig();
    const out = await rig.exec("shell.exec", { cmd: "echo oops >&2; exit 3" });
    expect(out).toEqual({
      kind: "text",
      text: "exit 3\n--- stdout ---\n\n--- stderr ---\noops\n",
    });
    expect(rig.events.filter((e) => e.type === "tool.error")).toEqual([]);
    expect(rig.events.filter((e) => e.type === "tool.result")).toHaveLength(1);
  });

  it("shell.exec timeout_ms kills the command tree (exit 137) and still reports a result", async () => {
    const rig = await makeRig();
    const out = await rig.exec("shell.exec", { cmd: "sleep 5", timeout_ms: 250 }, "call-sleep");
    expect(out.kind).toBe("text");
    expect((out as { text: string }).text.startsWith("exit 137")).toBe(true);
    const toolCall = rig.events.find((e) => e.type === "tool.call") as
      | { name: string }
      | undefined;
    expect(toolCall?.name).toBe("shell.exec");
  });

  it("every builtin run through the pipeline emits tool.call then tool.result", async () => {
    const rig = await makeRig();
    await rig.sandbox.writeFile("ping.txt", "pong");
    await rig.exec("fs.read", { path: "ping.txt" }, "call-order");
    expect(rig.events.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
  });
});
