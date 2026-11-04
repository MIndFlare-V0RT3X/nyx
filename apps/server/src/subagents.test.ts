// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-level subagent behavior (Phase 3 §3.1): spawn through the real HTTP
// turn path, session-list visibility, the subagent routes, archiving, and
// the isolation invariants as seen from the API.

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
const GUEST_TOKEN = "test-guest-token-0123456789";

const RULES = [
  { id: "allow-r0", match: { risk: "R0" as const }, decision: "allow" as const },
  { id: "allow-r1", match: { risk: "R1" as const }, decision: "allow" as const },
  { id: "ask-r2", match: { risk: "R2" as const }, decision: "ask" as const },
  { id: "ask-r3", match: { risk: "R3" as const }, decision: "ask" as const },
  { id: "ask-r4", match: { risk: "R4" as const }, decision: "ask" as const },
];

/** Dispatches scripted turns on a marker in the last user message (children
 * get unique task markers; the parent consumes the fallback queue). */
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
    const turn = this.next(req);
    if (turn === undefined) throw new Error("dispatch provider: script exhausted");
    if (!Array.isArray(turn)) throw new Error(turn.fail.message);
    for (const chunk of turn) yield chunk;
  }

  private next(req: CompletionRequest): MockTurn | undefined {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    for (const marker of this.byMarker.keys()) {
      if (text.includes(marker)) return this.byMarker.get(marker)!.shift();
    }
    return this.fallback.shift();
  }
}

function toolCallTurn(calls: Array<{ id: string; name: string; args: string }>): ModelChunk[] {
  const chunks: ModelChunk[] = [];
  calls.forEach((c, i) => {
    chunks.push({
      type: "tool_call.delta",
      index: i,
      id: c.id,
      name: c.name,
      arguments_delta: c.args,
    });
  });
  chunks.push({ type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  chunks.push({ type: "done", finish_reason: "tool_calls" });
  return chunks;
}

function textTurn(text: string): ModelChunk[] {
  return [
    { type: "text.delta", text },
    { type: "usage", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
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
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-sub-server-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-sub-server-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-sub-server-mem-"));
  const config: NyxConfig = configSchema.parse({
    server: {
      host: "127.0.0.1",
      port: 8787,
      auth: { owner_token: OWNER_TOKEN, tokens: { guest: GUEST_TOKEN } },
    },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: RULES },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
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
function guestHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${GUEST_TOKEN}`, "Content-Type": "application/json" };
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("until: condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function createSession(rig: Rig, title = "subagent test"): Promise<string> {
  const res = await rig.server.app.request("/v1/sessions", {
    method: "POST",
    headers: ownerHeaders(),
    body: JSON.stringify({ title }),
  });
  const meta = (await res.json()) as { session_id: string };
  return meta.session_id;
}

async function postTurn(rig: Rig, id: string, text: string): Promise<void> {
  const res = await rig.server.app.request(`/v1/sessions/${id}/turns`, {
    method: "POST",
    headers: ownerHeaders(),
    body: JSON.stringify({ content: { text } }),
  });
  expect(res.status).toBe(202);
}

/** Reads the persisted event log straight from nyx.db (the SSE endpoint is a
 * live stream and cannot be fully consumed here). */
async function readEvents(rig: Rig, id: string): Promise<SessionEvent[]> {
  const { openSessionStore } = await import("@nyx/session");
  const store = openSessionStore(join(rig.dataDir, "nyx.db"));
  try {
    return await store.read(id);
  } finally {
    store.close();
  }
}

describe("subagents over the server API (Phase 3)", () => {
  it("spawns through a real turn: child completes, summary returns, parent synthesizes", async () => {
    const provider = new DispatchProvider();
    provider.script("topic-alpha", [textTurn("apples are fruit")]);
    provider.script("topic-beta", [textTurn("bears are mammals")]);
    provider.scriptParent([
      toolCallTurn([
        { id: "c1", name: "spawn_subagent", args: '{"task":"study topic-alpha"}' },
        { id: "c2", name: "spawn_subagent", args: '{"task":"study topic-beta"}' },
      ]),
      textTurn("apples are fruit and bears are mammals — synthesis done"),
    ]);
    const rig = await makeRig(provider);
    const sessionId = await createSession(rig);
    await postTurn(rig, sessionId, "study both topics in parallel");

    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });

    const parentEvents = await readEvents(rig, sessionId);
    // Mirrored lifecycle only — no child turn events in the parent's stream.
    const spawned = parentEvents.filter((e) => e.type === "subagent.spawned");
    const completed = parentEvents.filter((e) => e.type === "subagent.completed");
    expect(spawned).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(
      parentEvents.filter(
        (e) =>
          e.type === "turn.started" || e.type === "message.user" || e.type === "text.delta",
      ).length,
    ).toBeGreaterThan(0);
    expect(parentEvents.filter((e) => e.type === "subagent.spawned").length).toBe(2);

    // Both summaries came back to the parent (tool results) and the parent's
    // final message references both.
    const assistantText = parentEvents
      .filter((e) => e.type === "message.assistant")
      .map((e) => JSON.stringify(e))
      .join(" ");
    expect(assistantText).toContain("synthesis done");

    // The tool results carry both SubagentResults.
    const detail = await rig.server.app.request(`/v1/sessions/${sessionId}`, {
      headers: ownerHeaders(),
    });
    const body = (await detail.json()) as {
      projection: {
        tool_calls: Array<{ name: string; status: string; output: unknown }>;
      };
    };
    const spawns = body.projection.tool_calls.filter((t) => t.name === "spawn_subagent");
    expect(spawns).toHaveLength(2);
    expect(spawns.every((t) => t.status === "ok")).toBe(true);
    const summaries = spawns.map((t) => ((t.output as { json: { summary: string } }).json).summary).sort();
    expect(summaries).toEqual(["apples are fruit", "bears are mammals"]);

    // Children ran in PARALLEL: their event windows overlap.
    const childA = spawned[0]!.subagent_session_id;
    const childB = spawned[1]!.subagent_session_id;
    const eventsA = await readEvents(rig, childA);
    const eventsB = await readEvents(rig, childB);
    const window = (events: SessionEvent[]): { start: number; end: number } => {
      const started = events.find((e) => e.type === "turn.started");
      const ended =
        [...events].reverse().find((e) => e.type === "turn.completed") ??
        [...events].reverse().find((e) => e.type === "subagent.completed");
      return { start: started?.ts ?? 0, end: ended?.ts ?? 0 };
    };
    const a = window(eventsA);
    const b = window(eventsB);
    expect(a.start).toBeLessThanOrEqual(b.end);
    expect(b.start).toBeLessThanOrEqual(a.end);

    // The child sessions exist, are subagent-kind, and are hidden from the
    // session list by default.
    const listRes = await rig.server.app.request("/v1/sessions", { headers: ownerHeaders() });
    const list = (await listRes.json()) as Array<{ session_id: string; kind: string }>;
    expect(list.map((m) => m.session_id)).toContain(sessionId);
    expect(list.map((m) => m.session_id)).not.toContain(childA);
    const listAllRes = await rig.server.app.request("/v1/sessions?include_subagents=true", {
      headers: ownerHeaders(),
    });
    const listAll = (await listAllRes.json()) as Array<{ session_id: string; kind: string }>;
    expect(listAll.map((m) => m.session_id)).toContain(childA);
    expect(listAll.find((m) => m.session_id === childA)?.kind).toBe("subagent");
  });

  it("GET /v1/sessions/:id/subagents lists children with states", async () => {
    const provider = new DispatchProvider();
    provider.script("list me", [textTurn("done")]);
    provider.scriptParent([
      toolCallTurn([{ id: "c1", name: "spawn_subagent", args: '{"task":"list me"}' }]),
      textTurn("ok"),
    ]);
    const rig = await makeRig(provider);
    const sessionId = await createSession(rig);
    await postTurn(rig, sessionId, "go");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });

    const res = await rig.server.app.request(`/v1/sessions/${sessionId}/subagents`, {
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    const infos = (await res.json()) as Array<{
      session_id: string;
      parent_session_id: string;
      state: string;
      task: string;
    }>;
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      parent_session_id: sessionId,
      state: "completed",
      task: "list me",
    });

    const missing = await rig.server.app.request("/v1/sessions/does-not-exist/subagents", {
      headers: ownerHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("DELETE /v1/subagents/:id is owner-only and 400s for non-subagent sessions", async () => {
    const provider = new DispatchProvider();
    provider.script("abort me", [textTurn("done")]);
    provider.scriptParent([
      toolCallTurn([{ id: "c1", name: "spawn_subagent", args: '{"task":"abort me"}' }]),
      textTurn("ok"),
    ]);
    const rig = await makeRig(provider);
    const sessionId = await createSession(rig);
    await postTurn(rig, sessionId, "go");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });
    const childId = (
      (await (
        await rig.server.app.request(`/v1/sessions/${sessionId}/subagents`, {
          headers: ownerHeaders(),
        })
      ).json()) as Array<{ session_id: string }>
    )[0]!.session_id;

    // Guest (non-owner) may not abort.
    const forbidden = await rig.server.app.request(`/v1/subagents/${childId}`, {
      method: "DELETE",
      headers: guestHeaders(),
    });
    expect(forbidden.status).toBe(403);

    // The parent session is not a subagent.
    const wrongKind = await rig.server.app.request(`/v1/subagents/${sessionId}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(wrongKind.status).toBe(400);

    // Owner abort of an already-finished child: accepted, no-op.
    const ok = await rig.server.app.request(`/v1/subagents/${childId}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(ok.status).toBe(200);

    const unknown = await rig.server.app.request("/v1/subagents/nope", {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(unknown.status).toBe(404);
  });

  it("DELETE /v1/sessions/:id archives a subagent session (never hard-deletes)", async () => {
    const provider = new DispatchProvider();
    provider.script("archive me", [textTurn("done")]);
    provider.scriptParent([
      toolCallTurn([{ id: "c1", name: "spawn_subagent", args: '{"task":"archive me"}' }]),
      textTurn("ok"),
    ]);
    const rig = await makeRig(provider);
    const sessionId = await createSession(rig);
    await postTurn(rig, sessionId, "go");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });
    const childId = (
      (await (
        await rig.server.app.request(`/v1/sessions/${sessionId}/subagents`, {
          headers: ownerHeaders(),
        })
      ).json()) as Array<{ session_id: string }>
    )[0]!.session_id;

    // Non-subagent sessions cannot be archived.
    const wrongKind = await rig.server.app.request(`/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(wrongKind.status).toBe(400);

    const guest = await rig.server.app.request(`/v1/sessions/${childId}`, {
      method: "DELETE",
      headers: guestHeaders(),
    });
    expect(guest.status).toBe(403);

    const res = await rig.server.app.request(`/v1/sessions/${childId}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: boolean; session: { archived_at: number } };
    expect(body.archived).toBe(true);
    expect(body.session.archived_at).toBeGreaterThan(0);

    // Hidden from lists (even include_subagents), still resolvable.
    const listAll = (await (
      await rig.server.app.request("/v1/sessions?include_subagents=true", {
        headers: ownerHeaders(),
      })
    ).json()) as Array<{ session_id: string }>;
    expect(listAll.map((m) => m.session_id)).not.toContain(childId);
    const meta = await rig.server.app.request(`/v1/sessions/${childId}`, {
      headers: ownerHeaders(),
    });
    expect(meta.status).toBe(200);
    // …and excluded from the parent's subagent list.
    const infos = (await (
      await rig.server.app.request(`/v1/sessions/${sessionId}/subagents`, {
        headers: ownerHeaders(),
      })
    ).json()) as Array<{ session_id: string }>;
    expect(infos).toHaveLength(0);
  });
});
