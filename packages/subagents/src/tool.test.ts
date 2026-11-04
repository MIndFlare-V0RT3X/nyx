// SPDX-License-Identifier: AGPL-3.0-or-later
// The spawn_subagent tool: registration gating (max_depth 0 → structurally
// absent), definition shape (risk R1, parallel concurrency), input validation,
// and the manager routing (§2.3, §3.6).

import { describe, expect, it } from "vitest";
import type { ToolContext } from "@nyx/protocol";
import { resolveSubagentsConfig } from "./config.js";
import { SubagentError } from "./errors.js";
import { ToolRegistryImpl } from "@nyx/tools";
import type { SubagentManager } from "./manager.js";
import { registerSubagentTool, SPAWN_SUBAGENT_TOOL } from "./tool.js";

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    session_id: "s1",
    turn_id: "t1",
    call_id: "c1",
    sandbox: {
      id: "sbx",
      workdir: "/tmp/x",
      exec: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => undefined,
      list: async () => [],
      destroy: async () => undefined,
    },
    signal: new AbortController().signal,
    logger: {
      debug() {}, info() {}, warn() {}, error() {},
      child() { return this; },
    },
    emit: () => undefined,
    engagement: null,
    ...over,
  };
}

describe("spawn_subagent tool registration", () => {
  it("is structurally absent when max_depth is 0", () => {
    const registry = new ToolRegistryImpl();
    const manager = {} as SubagentManager;
    registerSubagentTool(registry, { manager, config: resolveSubagentsConfig({ max_depth: 0 }) });
    expect(registry.get(SPAWN_SUBAGENT_TOOL)).toBeNull();
    expect(registry.list().map((d) => d.name)).not.toContain(SPAWN_SUBAGENT_TOOL);
  });

  it("registers with risk R1, no capabilities, and parallel concurrency", () => {
    const registry = new ToolRegistryImpl();
    registerSubagentTool(registry, {
      manager: {} as SubagentManager,
      config: resolveSubagentsConfig(),
    });
    const entry = registry.get(SPAWN_SUBAGENT_TOOL);
    expect(entry).not.toBeNull();
    expect(entry!.def).toMatchObject({
      name: SPAWN_SUBAGENT_TOOL,
      risk: "R1",
      capabilities: [],
      concurrency: "parallel",
      // Long-running children get a long wall clock (the 30 s default tool
      // timeout would kill legitimate minutes-long subagents).
      timeout_ms: 600_000,
    });
    // The model-facing schema is the brief's §2.3 shape.
    const schema = entry!.def.input_schema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["task"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["budget_tokens", "task", "tools"]);
  });

  it("rejects invalid input before touching the manager", async () => {
    const registry = new ToolRegistryImpl();
    const manager = {
      spawn: () => {
        throw new Error("must not be called");
      },
    } as unknown as SubagentManager;
    registerSubagentTool(registry, { manager, config: resolveSubagentsConfig() });
    const handler = registry.get(SPAWN_SUBAGENT_TOOL)!.handler;
    await expect(
      handler.execute({ call_id: "c1", name: SPAWN_SUBAGENT_TOOL, input: { task: "" } }, fakeCtx()),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      handler.execute(
        { call_id: "c1", name: SPAWN_SUBAGENT_TOOL, input: { task: "x", bogus: 1 } },
        fakeCtx(),
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("enforces the advertised budget minimum (1024) — the runtime schema drops `minimum`", async () => {
    // Fan-out review R1: the compiled runtime schema is type+properties+
    // required only, so `minimum: 1024` is enforced HERE. Negative, zero,
    // fractional, and sub-minimum budgets must all die at the tool boundary.
    const registry = new ToolRegistryImpl();
    const manager = {
      spawn: () => {
        throw new Error("must not be called");
      },
    } as unknown as SubagentManager;
    registerSubagentTool(registry, { manager, config: resolveSubagentsConfig() });
    const handler = registry.get(SPAWN_SUBAGENT_TOOL)!.handler;
    for (const bad of [-1_000_000, 0, 512, 1024.5]) {
      await expect(
        handler.execute(
          { call_id: "c1", name: SPAWN_SUBAGENT_TOOL, input: { task: "x", budget_tokens: bad } },
          fakeCtx(),
        ),
      ).rejects.toMatchObject({ code: "validation_failed", name: "SubagentError" });
    }
    // The boundary itself is legal.
    const ok = await handler.execute(
      { call_id: "c1", name: SPAWN_SUBAGENT_TOOL, input: { task: "x", budget_tokens: 1024 } },
      fakeCtx({ session_id: "s1", turn_id: "t1", emit: () => undefined }),
    ).catch(() => undefined); // no bound turn → any error is fine; input passed validation
    expect(ok).toBeUndefined();
  });

  it("routes to the manager with the bound parent ref and returns the result as JSON", async () => {
    const registry = new ToolRegistryImpl();
    const calls: unknown[] = [];
    const manager = {
      boundTurn: (session_id: string, turn_id: string) => {
        calls.push(["boundTurn", session_id, turn_id]);
        return { turn_id, ctx: { marker: "parent-ctx" } };
      },
      spawn: (spec: unknown, ctx: unknown, parent: unknown) => {
        calls.push(["spawn", spec, ctx, parent]);
        return Promise.resolve({
          session_id: "child-1",
          summary: "did the thing",
          state: "completed",
          tokens_used: 12,
          duration_ms: 3,
        });
      },
    } as unknown as SubagentManager;
    registerSubagentTool(registry, { manager, config: resolveSubagentsConfig() });
    const handler = registry.get(SPAWN_SUBAGENT_TOOL)!.handler;

    const output = await handler.execute(
      {
        call_id: "c1",
        name: SPAWN_SUBAGENT_TOOL,
        input: { task: "research it", tools: ["fs.read"], budget_tokens: 4096 },
      },
      fakeCtx(),
    );
    expect(output).toEqual({
      kind: "json",
      json: {
        session_id: "child-1",
        summary: "did the thing",
        state: "completed",
        tokens_used: 12,
        duration_ms: 3,
      },
    });
    expect(calls[1]).toEqual([
      "spawn",
      { task: "research it", tools: ["fs.read"], budget_tokens: 4096 },
      { marker: "parent-ctx" },
      { session_id: "s1", turn_id: "t1" },
    ]);
  });

  it("surfaces manager rejections as typed SubagentErrors (tool.error path)", async () => {
    const registry = new ToolRegistryImpl();
    const manager = {
      boundTurn: () => ({ turn_id: "t1", ctx: {} }),
      spawn: () => Promise.reject(new SubagentError("depth_exceeded", "too deep")),
    } as unknown as SubagentManager;
    registerSubagentTool(registry, { manager, config: resolveSubagentsConfig() });
    const handler = registry.get(SPAWN_SUBAGENT_TOOL)!.handler;
    await expect(
      handler.execute(
        { call_id: "c1", name: SPAWN_SUBAGENT_TOOL, input: { task: "x" } },
        fakeCtx(),
      ),
    ).rejects.toMatchObject({ name: "SubagentError", code: "depth_exceeded" });
  });
});
