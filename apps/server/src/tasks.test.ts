// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-level durable-task behavior (Phase 4 §2.1.6/§2.1.7): create through
// the REST API, the worker pool claiming and running the attempt as a REAL
// subagent through the REAL agent loop (scripted model), the state-machine
// routes, and the task session's event log.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import type {
  CompletionRequest,
  ModelChunk,
  ModelInfo,
  ModelProvider,
  SessionEvent,
} from "@nyx/protocol";
import type { MockTurn } from "@nyx/model";
import { createServer as createNyxServer, type NyxServer } from "./server.js";

const OWNER_TOKEN = "test-owner-token-0123456789";

const RULES = [
  { id: "allow-r0", match: { risk: "R0" as const }, decision: "allow" as const },
  { id: "allow-r1", match: { risk: "R1" as const }, decision: "allow" as const },
];

/** Dispatches scripted turns on a marker in the last user message. */
class DispatchProvider implements ModelProvider {
  readonly id = "mock";
  private readonly byMarker = new Map<string, MockTurn[]>();
  private readonly fallback: MockTurn[] = [];
  private readonly models: ModelInfo[] = [
    { id: "mock-1", context_window: 128000, max_output: 8192, supports: ["tools"] },
  ];

  script(marker: string, turns: MockTurn[]): this {
    this.byMarker.set(marker, [...turns]);
    return this;
  }

  scriptParent(turns: MockTurn[]): this {
    this.fallback.push(...turns);
    return this;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([...this.models]);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<ModelChunk, void, void> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    const turn =
      [...this.byMarker.keys()]
        .map((m) => [m, this.byMarker.get(m)!.shift()] as const)
        .find(([m, t]) => t !== undefined && text.includes(m))?.[1] ?? this.fallback.shift();
    if (turn === undefined) throw new Error("dispatch provider: script exhausted");
    if (!Array.isArray(turn)) throw new Error(turn.fail.message);
    for (const chunk of turn) yield chunk;
  }
}

function textTurn(text: string): ModelChunk[] {
  return [
    { type: "text.delta", text },
    { type: "usage", usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } },
    { type: "done", finish_reason: "stop" },
  ];
}

interface Rig {
  server: NyxServer;
  dataDir: string;
  sandboxRoot: string;
  memoryRoot: string;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

async function makeRig(provider: ModelProvider): Promise<Rig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-tasks-server-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-tasks-server-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-tasks-server-mem-"));
  const config: NyxConfig = configSchema.parse({
    server: {
      host: "127.0.0.1",
      port: 8787,
      auth: { owner_token: OWNER_TOKEN },
    },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: RULES },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
    tasks: { enabled: true, workers: 1, poll_interval_ms: 50 },
  });
  const server = createNyxServer({ config, data_dir: dataDir, providers: [provider] });
  const rig: Rig = { server, dataDir, sandboxRoot, memoryRoot, close: () => server.close() };
  rigs.push(rig);
  return rig;
}

afterAll(async () => {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) {
    await rm(rig.dataDir, { recursive: true, force: true });
    await rm(rig.sandboxRoot, { recursive: true, force: true });
    await rm(rig.memoryRoot, { recursive: true, force: true });
  }
});

function ownerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

async function readEvents(rig: Rig, sessionId: string): Promise<SessionEvent[]> {
  const { openSessionStore } = await import("@nyx/session");
  const store = openSessionStore(join(rig.dataDir, "nyx.db"));
  try {
    return await store.read(sessionId, 1);
  } finally {
    store.close();
  }
}

describe("durable tasks over REST (§2.1.6)", () => {
  it("creates a task, the worker runs it as a real subagent, it completes", async () => {
    const provider = new DispatchProvider();
    provider.script("fuzz the parser", [textTurn("fuzzed 100 cases, 0 crashes")]);
    const rig = await makeRig(provider);
    // The pool normally starts in server.start(); the app.request() harness
    // skips that, so start it explicitly (the unit under test is identical).
    rig.server.taskPool.start();

    const res = await rig.server.app.request("/v1/tasks", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        title: "fuzz parser",
        description: "fuzz the parser for an hour and report crashes.",
        subagent_spec: { budget_tokens: 8192 },
        max_attempts: 3,
        retry_backoff_ms: 1000,
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      task_session_id: string;
      state: string;
    };
    expect(created.state).toBe("pending");
    expect(created.task_session_id).toBeTruthy();

    await until(async () => {
      const r = await rig.server.app.request(`/v1/tasks/${created.id}`, {
        headers: ownerHeaders(),
      });
      return ((await r.json()) as { state: string }).state === "completed";
    });

    const final = (await (
      await rig.server.app.request(`/v1/tasks/${created.id}`, { headers: ownerHeaders() })
    ).json()) as {
      state: string;
      attempts: number;
      result: { summary: string; state: string; session_id: string } | null;
      subagent_session_id: string | null;
      task_session_id: string;
    };
    expect(final.state).toBe("completed");
    expect(final.attempts).toBe(1);
    expect(final.result!.summary).toBe("fuzzed 100 cases, 0 crashes");
    // The attempt's subagent session is a real subagent session of the task's
    // own session (no orphans — §2.1.7).
    expect(final.subagent_session_id).toBe(final.result!.session_id);
    const { openSessionStore } = await import("@nyx/session");
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    const child = await store.meta(final.subagent_session_id!);
    expect(child!.kind).toBe("subagent");
    expect(child!.parent_id).toBe(final.task_session_id);
    store.close();

    // The task's own log carries the lifecycle.
    const events = await readEvents(rig, final.task_session_id);
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.created", "task.started", "task.completed"]),
    );
    expect(types).not.toContain("task.retrying");
    await rig.server.taskPool.stop();
  });

  it("pause → paused (never reclaimed), resume → pending, cancel → cancelled", async () => {
    const provider = new DispatchProvider();
    const rig = await makeRig(provider);

    const res = await rig.server.app.request("/v1/tasks", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        title: "never runs",
        description: "stay queued",
        subagent_spec: { budget_tokens: 2048 },
      }),
    });
    const created = (await res.json()) as { id: string };

    const pauseRes = await rig.server.app.request(`/v1/tasks/${created.id}/pause`, {
      method: "POST",
      headers: ownerHeaders(),
    });
    expect(pauseRes.status).toBe(200);
    expect(((await pauseRes.json()) as { state: string }).state).toBe("paused");

    // Paused tasks are never claimed — even with the pool polling.
    rig.server.taskPool.start();
    await new Promise((r) => setTimeout(r, 150));
    const still = (await (
      await rig.server.app.request(`/v1/tasks/${created.id}`, { headers: ownerHeaders() })
    ).json()) as { state: string; attempts: number };
    expect(still.state).toBe("paused");
    expect(still.attempts).toBe(0);

    const resumeRes = await rig.server.app.request(`/v1/tasks/${created.id}/resume`, {
      method: "POST",
      headers: ownerHeaders(),
    });
    expect(((await resumeRes.json()) as { state: string }).state).toBe("pending");

    const delRes = await rig.server.app.request(`/v1/tasks/${created.id}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(delRes.status).toBe(200);
    const after = (await (
      await rig.server.app.request(`/v1/tasks/${created.id}`, { headers: ownerHeaders() })
    ).json()) as { state: string };
    expect(after.state).toBe("cancelled");
    // cancelled is terminal: pause now refuses with 409
    const latePause = await rig.server.app.request(`/v1/tasks/${created.id}/pause`, {
      method: "POST",
      headers: ownerHeaders(),
    });
    expect(latePause.status).toBe(409);
    await rig.server.taskPool.stop();
  });

  it("lists with state filters and validates the body", async () => {
    const provider = new DispatchProvider();
    const rig = await makeRig(provider);

    const bad = await rig.server.app.request("/v1/tasks", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ title: "x", description: "" }),
    });
    expect(bad.status).toBe(400);

    const a = (await (
      await rig.server.app.request("/v1/tasks", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({
          title: "a",
          description: "task a",
          subagent_spec: {},
        }),
      })
    ).json()) as { id: string };
    await rig.server.app.request(`/v1/tasks/${a.id}/pause`, {
      method: "POST",
      headers: ownerHeaders(),
    });
    const list = (await (
      await rig.server.app.request("/v1/tasks?state=paused", { headers: ownerHeaders() })
    ).json()) as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([a.id]);
    const empty = (await (
      await rig.server.app.request("/v1/tasks?state=running", { headers: ownerHeaders() })
    ).json()) as unknown[];
    expect(empty).toEqual([]);
  });
});
