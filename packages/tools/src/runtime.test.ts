// SPDX-License-Identifier: AGPL-3.0-or-later
// Pipeline tests for the tool runtime. Real PolicyEngineImpl +
// ApprovalEngineImpl from @nyx/policy (tests are exempt from package import
// boundaries, so better-sqlite3 comes from the sibling workspace's
// node_modules), LocalSandboxProvider sandboxes under os.tmpdir().
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error better-sqlite3 is not a declared dependency of @nyx/tools; tests resolve it from the sibling @nyx/policy workspace (tests are exempt from package import boundaries per the package brief).
import Database from "../../policy/node_modules/better-sqlite3";
import { ApprovalEngineImpl, PolicyEngineImpl } from "@nyx/policy";
import { LocalSandboxProvider } from "@nyx/sandbox";
import { createToolRuntime } from "./runtime.js";
import type { ToolExecContext, ToolRuntime, ToolRuntimeOptions } from "./runtime.js";
import { registerBuiltinTools } from "./builtins.js";
import { ToolRegistryImpl } from "./registry.js";
import { ToolRouterImpl } from "./router.js";
import type {
  Engagement,
  Logger,
  PolicyRule,
  Sandbox,
  ScopeTargets,
  SessionEvent,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolOutput,
} from "@nyx/protocol";

type ToolErrorEvent = Extract<SessionEvent, { type: "tool.error" }>;
type ActionDeniedEvent = Extract<SessionEvent, { type: "action.denied" }>;
type ToolResultEvent = Extract<SessionEvent, { type: "tool.result" }>;

let provider: LocalSandboxProvider;
const roots: string[] = [];
const sandboxes: Sandbox[] = [];
const dbs: Array<{ close(): void }> = [];

beforeAll(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-tools-rt-"));
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

function noopLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function captureLogger(): { logger: Logger; errors: Array<{ msg: string; ctx?: Record<string, unknown> }> } {
  const errors: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, c) => {
      errors.push({ msg, ctx: c });
    },
    child: () => logger,
  };
  return { logger, errors };
}

function engagementOf(targets: ScopeTargets): Engagement {
  const now = Date.now();
  return {
    id: "ENG-TEST-1",
    operator_id: "owner",
    authorized_at: now - 1000,
    expires_at: now + 3_600_000,
    targets,
  };
}

function fakeDef(name: string, extra?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    input_schema: { type: "object" },
    risk: "R0",
    capabilities: [],
    handler: `test:${name}`,
    ...extra,
  };
}

interface HarnessOpts {
  rules?: PolicyRule[];
  /** What the "surface" does with a pending approval; "manual" leaves it pending. */
  approval?: "allow" | "deny" | "manual";
  runtimeOpts?: ToolRuntimeOptions;
  register?: (registry: ToolRegistryImpl) => void;
}

interface Harness {
  runtime: ToolRuntime;
  events: SessionEvent[];
  sandbox: Sandbox;
  execCtx: (o?: { engagement?: Engagement | null; logger?: Logger }) => ToolExecContext;
}

async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const events: SessionEvent[] = [];
  const sandbox = await provider.provision({ provider: "local", workdir: ".", network: "none" });
  sandboxes.push(sandbox);

  const policy = new PolicyEngineImpl(opts.rules ?? []);
  const db = new Database(":memory:");
  dbs.push(db);
  const auto = opts.approval ?? "manual";
  let approvals: ApprovalEngineImpl;
  // The surface (server/CLI), not the runtime, owns approval.* events; the
  // harness mirrors that wiring and auto-resolves like an operator would.
  approvals = new ApprovalEngineImpl(db, {
    poll_ms: 5,
    onCreated: (rec) => {
      events.push({
        type: "approval.requested",
        session_id: rec.session_id,
        turn_id: rec.turn_id,
        approval_id: rec.id,
        action_digest: rec.action_digest,
        summary: rec.summary,
        risk: rec.risk,
        ts: Date.now(),
      });
      if (auto !== "manual") {
        void approvals.resolve(rec.id, auto, "test:operator").catch(() => undefined);
      }
    },
    onResolved: (rec) => {
      events.push({
        type: "approval.resolved",
        session_id: rec.session_id,
        turn_id: rec.turn_id,
        approval_id: rec.id,
        decision: rec.decision === "allow" ? "allow" : "deny",
        decided_by: rec.decided_by ?? "unknown",
        ts: Date.now(),
      });
    },
  });

  const registry = new ToolRegistryImpl();
  opts.register?.(registry);
  const runtime = createToolRuntime({
    registry,
    router: new ToolRouterImpl(),
    policy,
    approvals,
    opts: opts.runtimeOpts,
  });

  const execCtx = (o?: { engagement?: Engagement | null; logger?: Logger }): ToolExecContext => ({
    session_id: "sess-test",
    turn_id: "turn-test",
    engagement: o?.engagement ?? null,
    sandbox,
    signal: new AbortController().signal,
    logger: o?.logger ?? noopLogger(),
    emit: (e) => {
      events.push(e);
    },
  });

  return { runtime, events, sandbox, execCtx };
}

const toolErrors = (events: SessionEvent[]): ToolErrorEvent[] =>
  events.filter((e): e is ToolErrorEvent => e.type === "tool.error");
const denials = (events: SessionEvent[]): ActionDeniedEvent[] =>
  events.filter((e): e is ActionDeniedEvent => e.type === "action.denied");
const results = (events: SessionEvent[]): ToolResultEvent[] =>
  events.filter((e): e is ToolResultEvent => e.type === "tool.result");
const eventTypes = (events: SessionEvent[]): string[] => events.map((e) => e.type);

const call = (name: string, input: unknown, call_id = "call-1"): ToolCall => ({
  call_id,
  name,
  input,
});

describe("tool runtime pipeline", () => {
  it("unknown tool → tool_unknown error event, no crash, model-facing text", async () => {
    const h = await makeHarness({ register: (r) => registerBuiltinTools(r) });
    const out = await h.runtime.execute(call("nope.tool", {}), h.execCtx());

    expect(out).toEqual({ kind: "text", text: 'error: unknown tool "nope.tool"' });
    expect(eventTypes(h.events)).toEqual(["tool.call", "tool.error"]);
    const err = toolErrors(h.events)[0]!;
    expect(err.call_id).toBe("call-1");
    expect(err.error.code).toBe("tool_unknown");
    expect(err.error.message).toContain("nope.tool");
    expect(results(h.events)).toEqual([]);
    expect(denials(h.events)).toEqual([]);
  });

  it("invalid input → validation_failed naming path + message", async () => {
    const h = await makeHarness({ register: (r) => registerBuiltinTools(r) });

    const missing = await h.runtime.execute(call("fs.read", {}), h.execCtx());
    expect(missing).toEqual({
      kind: "text",
      text: 'error: invalid input for "fs.read": path: Required',
    });
    expect(toolErrors(h.events)[0]!.error.code).toBe("validation_failed");

    const wrongType = await h.runtime.execute(call("fs.read", { path: 42 }), h.execCtx());
    expect(wrongType.kind).toBe("text");
    if (wrongType.kind === "text") {
      expect(wrongType.text).toContain("path");
      expect(wrongType.text).toContain("Expected string");
    }
    expect(toolErrors(h.events)[1]!.error.code).toBe("validation_failed");

    const nonObject = await h.runtime.execute(call("fs.read", "hello"), h.execCtx());
    expect(nonObject.kind).toBe("text");
    expect(toolErrors(h.events)[2]!.error.code).toBe("validation_failed");
    expect(results(h.events)).toEqual([]);
  });

  it("path escape → tool.error path_escape and the handler NEVER ran; contained paths are rewritten", async () => {
    const spy = vi.fn(
      async (c: ToolCall, _ctx: ToolContext): Promise<ToolOutput> => ({
        kind: "text",
        text: `ran ${JSON.stringify(c.input)}`,
      }),
    );
    const h = await makeHarness({
      rules: [{ id: "allow-fs-read", match: { tool: "fs.read" }, decision: "allow" }],
      register: (r) => {
        // A recording fake registered under the builtin fs.read name: the
        // runtime's path_fields apply by tool name, so the spy proves the
        // handler is unreachable for escaping paths.
        r.register(fakeDef("fs.read", { handler: "test:fs.read" }), { execute: spy });
      },
    });

    const escape = await h.runtime.execute(call("fs.read", { path: "../../etc/passwd" }), h.execCtx());
    expect(escape).toEqual({ kind: "text", text: "error: path escapes the sandbox workdir" });
    expect(toolErrors(h.events)[0]!.error.code).toBe("path_escape");
    expect(results(h.events)).toEqual([]);
    expect(denials(h.events)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    const absolute = await h.runtime.execute(call("fs.read", { path: "/etc/passwd" }), h.execCtx());
    expect(absolute).toEqual({ kind: "text", text: "error: path escapes the sandbox workdir" });
    expect(toolErrors(h.events)[1]!.error.code).toBe("path_escape");
    expect(spy).not.toHaveBeenCalled();

    // A contained path IS rewritten to an absolute workdir path before the
    // handler sees it, while tool.call keeps the original model request.
    const ok = await h.runtime.execute(call("fs.read", { path: "inside.txt" }), h.execCtx());
    expect(ok.kind).toBe("text");
    expect(spy).toHaveBeenCalledTimes(1);
    const seen = spy.mock.calls[0]![0];
    expect((seen.input as { path: string }).path).toBe(
      path.join(h.sandbox.workdir, "inside.txt"),
    );
    const toolCalls = h.events.filter(
      (e): e is Extract<SessionEvent, { type: "tool.call" }> => e.type === "tool.call",
    );
    // The escape and absolute attempts also emitted tool.call before being
    // rejected; the last one is the successful contained call.
    expect(toolCalls.at(-1)?.input).toEqual({ path: "inside.txt" });
    expect(toolCalls).toHaveLength(3);
    expect(results(h.events)).toHaveLength(1);
  });

  it("R0 tool under an allow rule executes; tool.result emitted; output returned", async () => {
    const h = await makeHarness({
      rules: [{ id: "allow-fs-read", match: { tool: "fs.read" }, decision: "allow" }],
      register: (r) => registerBuiltinTools(r),
    });
    await h.sandbox.writeFile("hello.txt", "hi there\n");

    const out = await h.runtime.execute(call("fs.read", { path: "hello.txt" }), h.execCtx());
    expect(out).toEqual({ kind: "text", text: "hi there\n" });
    expect(eventTypes(h.events)).toEqual(["tool.call", "tool.result"]);
    expect(results(h.events)[0]!.output).toEqual(out);
    expect(denials(h.events)).toEqual([]);
  });

  it("policy deny rule → action.denied reason policy with rule_id; no tool.result", async () => {
    const h = await makeHarness({
      rules: [{ id: "deny-fs-read", match: { tool: "fs.read" }, decision: "deny" }],
      register: (r) => registerBuiltinTools(r),
    });

    const out = await h.runtime.execute(call("fs.read", { path: "hello.txt" }), h.execCtx());
    expect(out.kind).toBe("text");
    if (out.kind === "text") {
      expect(out.text).toContain("denied by policy (rule deny-fs-read):");
      expect(out.text).toContain("fs.read");
    }
    const denied = denials(h.events);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toBe("policy");
    expect(denied[0]!.rule_id).toBe("deny-fs-read");
    expect(denied[0]!.detail).toContain("fs.read");
    expect(results(h.events)).toEqual([]);
    expect(h.events.filter((e) => e.type === "approval.requested")).toEqual([]);
  });

  it("force_ask triggers an approval even under an allow rule (allow verdict → executes)", async () => {
    const spy = vi.fn(
      async (): Promise<ToolOutput> => ({ kind: "text", text: "echo ran" }),
    );
    const h = await makeHarness({
      rules: [{ id: "allow-echo", match: { tool: "test.echo" }, decision: "allow" }],
      approval: "allow",
      register: (r) => r.register(fakeDef("test.echo"), { execute: spy }),
    });

    // Without force_ask the allow verdict executes silently.
    const plain = await h.runtime.execute(call("test.echo", {}), h.execCtx());
    expect(plain).toEqual({ kind: "text", text: "echo ran" });
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(0);

    const forced = await h.runtime.execute(call("test.echo", {}, "call-2"), h.execCtx(), {
      force_ask: true,
    });
    expect(forced).toEqual({ kind: "text", text: "echo ran" });
    expect(spy).toHaveBeenCalledTimes(2);
    // exactly one approval.requested — emitted by the surface, never duplicated by the runtime
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(eventTypes(h.events).slice(-3)).toEqual([
      "approval.requested",
      "approval.resolved",
      "tool.result",
    ]);
    expect(results(h.events)).toHaveLength(2);
  });

  it("ask flow denied by the operator → action.denied reason approval; handler never ran", async () => {
    const spy = vi.fn(
      async (): Promise<ToolOutput> => ({ kind: "text", text: "should not run" }),
    );
    const h = await makeHarness({
      approval: "deny",
      register: (r) => r.register(fakeDef("test.echo"), { execute: spy }),
    });

    const out = await h.runtime.execute(call("test.echo", {}), h.execCtx());
    expect(out).toEqual({ kind: "text", text: "denied: approval was denied" });
    const denied = denials(h.events);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toBe("approval");
    expect(denials(h.events)[0]!.detail).toContain("test.echo");
    expect(results(h.events)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("output over 64 KB spills into an artifact file with the correct byte count", async () => {
    const big = "x".repeat(100 * 1024);
    const h = await makeHarness({
      rules: [{ id: "allow-big", match: { tool: "test.big" }, decision: "allow" }],
      register: (r) =>
        r.register(
          fakeDef("test.big"),
          { execute: async () => ({ kind: "text", text: big }) },
        ),
    });

    const out = await h.runtime.execute(call("test.big", {}, "call-big"), h.execCtx());
    expect(out).toEqual({
      kind: "artifact",
      artifact_id: "call-big",
      path: path.join(h.sandbox.workdir, ".nyx", "artifacts", "call-big.txt"),
      bytes: 100 * 1024,
    });
    const spilled = await h.sandbox.readFile(".nyx/artifacts/call-big.txt");
    expect(spilled.length).toBe(100 * 1024);
    expect(spilled.subarray(0, 4).toString("utf8")).toBe("xxxx");
    // tool.result carries the artifact output, not the oversized text
    expect(results(h.events)).toHaveLength(1);
    expect(results(h.events)[0]!.output).toEqual(out);
    expect(toolErrors(h.events)).toEqual([]);
  });

  it("outputs at or under the limit pass through unchanged", async () => {
    const h = await makeHarness({
      rules: [{ id: "allow-size", match: { tool: "test.size" }, decision: "allow" }],
      register: (r) =>
        r.register(
          fakeDef("test.size"),
          { execute: async (c) => ({ kind: "text", text: "y".repeat(Number((c.input as { n: number }).n)) }) },
        ),
    });

    const exact = await h.runtime.execute(call("test.size", { n: 65536 }), h.execCtx());
    expect(exact).toEqual({ kind: "text", text: "y".repeat(65536) });

    const over = await h.runtime.execute(call("test.size", { n: 65537 }, "call-over"), h.execCtx());
    expect(over.kind).toBe("artifact");
    if (over.kind === "artifact") {
      expect(over.bytes).toBe(65537);
      expect(over.artifact_id).toBe("call-over");
    }
  });

  it("handler throw → tool_failed, model-facing text, full error logged, no tool.result", async () => {
    const log = captureLogger();
    const h = await makeHarness({
      rules: [{ id: "allow-throw", match: { tool: "test.throw" }, decision: "allow" }],
      register: (r) =>
        r.register(
          fakeDef("test.throw"),
          {
            execute: async () => {
              throw new Error("boom");
            },
          },
        ),
    });

    const out = await h.runtime.execute(call("test.throw", {}), h.execCtx({ logger: log.logger }));
    expect(out).toEqual({ kind: "text", text: 'error: tool "test.throw" failed: boom' });
    const err = toolErrors(h.events)[0]!;
    expect(err.error.code).toBe("tool_failed");
    expect(err.error.message).toBe("boom");
    expect(err.error.stack).toBeUndefined();
    expect(results(h.events)).toEqual([]);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]!.msg).toContain("test.throw");
  });

  it("handler that never settles past def.timeout_ms → tool_timeout", async () => {
    const h = await makeHarness({
      rules: [{ id: "allow-sleep", match: { tool: "test.sleep" }, decision: "allow" }],
      register: (r) =>
        r.register(
          fakeDef("test.sleep", { timeout_ms: 60 }),
          { execute: () => new Promise<ToolOutput>(() => undefined) },
        ),
    });

    const out = await h.runtime.execute(call("test.sleep", {}), h.execCtx());
    expect(out).toEqual({ kind: "text", text: 'error: tool "test.sleep" timed out after 60ms' });
    const err = toolErrors(h.events)[0]!;
    expect(err.error.code).toBe("tool_timeout");
    expect(results(h.events)).toEqual([]);
  });

  it("runtime default_timeout_ms applies when the definition has none", async () => {
    const h = await makeHarness({
      rules: [{ id: "allow-hang", match: { tool: "test.hang" }, decision: "allow" }],
      runtimeOpts: { default_timeout_ms: 60 },
      register: (r) =>
        r.register(
          fakeDef("test.hang"),
          { execute: () => new Promise<ToolOutput>(() => undefined) },
        ),
    });

    const out = await h.runtime.execute(call("test.hang", {}), h.execCtx());
    expect(out).toEqual({ kind: "text", text: 'error: tool "test.hang" timed out after 60ms' });
    expect(toolErrors(h.events)[0]!.error.code).toBe("tool_timeout");
  });

  it("an already-aborted outer signal → code aborted, turn continues", async () => {
    const h = await makeHarness({
      rules: [{ id: "allow-hang", match: { tool: "test.hang" }, decision: "allow" }],
      register: (r) =>
        r.register(
          fakeDef("test.hang"),
          { execute: () => new Promise<ToolOutput>(() => undefined) },
        ),
    });
    const ac = new AbortController();
    ac.abort();
    const ctx = { ...h.execCtx(), signal: ac.signal };

    const out = await h.runtime.execute(call("test.hang", {}), ctx);
    expect(out.kind).toBe("text");
    if (out.kind === "text") {
      expect(out.text).toContain('error: tool "test.hang" aborted');
    }
    expect(toolErrors(h.events)[0]!.error.code).toBe("aborted");
    expect(results(h.events)).toEqual([]);
  });

  it("specsForModel returns curated name/description/input_schema for every registered tool", async () => {
    const h = await makeHarness({ register: (r) => registerBuiltinTools(r) });
    const specs = h.runtime.specsForModel();

    expect(specs.map((s) => s.name)).toEqual([
      "fs.read",
      "fs.list",
      "fs.write",
      "shell.exec",
      "web.fetch",
    ]);
    for (const spec of specs) {
      expect(Object.keys(spec).sort()).toEqual(["description", "input_schema", "name"]);
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.input_schema.type).toBe("object");
      expect(spec.input_schema.properties).toBeTypeOf("object");
    }
  });
});
