// SPDX-License-Identifier: AGPL-3.0-or-later
// WebSocket round-trip on a real ephemeral port: token auth, subscribe,
// event frames in order while a scripted turn runs, unsubscribe, and
// rejection of bad tokens.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { configSchema } from "@nyx/config";
import { MockProvider, mockTextTurn } from "@nyx/model";
import { createServer } from "./server.js";
import type { NyxServer } from "./server.js";

const OWNER_TOKEN = "ws-owner-token-0123456789";

const rigs: Array<{ server: NyxServer; dirs: string[] }> = [];

async function makeRig(): Promise<NyxServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-ws-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-ws-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-ws-mem-"));
  const config = configSchema.parse({
    server: { host: "127.0.0.1", port: 8790, auth: { owner_token: OWNER_TOKEN, tokens: {} } },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: [{ id: "allow-r0", match: { risk: "R0" }, decision: "allow" }] },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
  });
  const server = createServer({
    config,
    data_dir: dataDir,
    providers: [new MockProvider("mock", [mockTextTurn("ws turn reply")])],
  });
  rigs.push({ server, dirs: [dataDir, sandboxRoot, memoryRoot] });
  return server;
}

afterAll(async () => {
  for (const rig of rigs) await rig.server.close();
  for (const rig of rigs) {
    for (const dir of rig.dirs) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A ws client that never drops a frame: a persistent listener queues parsed
 * messages, so bursts arriving between awaits are buffered, not lost.
 */
function makeQueuingClient(ws: WebSocket): {
  next(timeoutMs?: number, label?: string): Promise<Record<string, unknown>>;
} {
  const queue: Array<Promise<Record<string, unknown>>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on("message", (data) => {
    const parsed = Promise.resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      parsed.then(waiter, () => undefined);
    } else {
      queue.push(parsed);
    }
  });
  return {
    next(timeoutMs = 5000, label = "?"): Promise<Record<string, unknown>> {
      const queued = queue.shift();
      if (queued !== undefined) return queued;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`ws message timeout (${label})`)),
          timeoutMs,
        );
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
  };
}

function nextOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** A rejected upgrade surfaces as a client error followed by close. */
function expectUpgradeFailure(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expected upgrade failure timeout")),
      timeoutMs,
    );
    ws.once("error", () => undefined);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("websocket /v1/ws", () => {
  it("authenticates by ?token=, subscribes, streams turn events in order, unsubscribes", async () => {
    const server = await makeRig();
    const handle = await server.start({ port: 0 });
    const base = `ws://127.0.0.1:${handle.port}/v1/ws`;

    // bad token → the upgrade is refused (client sees error then close)
    const bad = new WebSocket(`${base}?token=wrong`);
    await expectUpgradeFailure(bad);

    // owner token → open, subscribe, run a turn, watch frames
    const ws = new WebSocket(`${base}?token=${encodeURIComponent(OWNER_TOKEN)}`);
    await nextOpen(ws);
    const client = makeQueuingClient(ws);

    const createRes = await server.app.request("/v1/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const meta = (await createRes.json()) as { session_id: string };

    ws.send(JSON.stringify({ type: "subscribe", session_id: meta.session_id, from_seq: 0 }));
    const subscribed = await client.next(5000, "subscribe");
    expect(subscribed.type).toBe("event");
    expect((subscribed.event as { type: string }).type).toBe("session.created");

    const turnRes = await server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { text: "hello over ws" } }),
    });
    expect(turnRes.status).toBe(202);

    const types: string[] = [];
    for (let i = 0; i < 12; i++) {
      const frame = await client.next(5000, `frame-${i}`);
      if (frame.type === "event") {
        const event = frame.event as { type: string; seq: number };
        types.push(`${event.seq}:${event.type}`);
      }
      if (types.some((t) => t.endsWith(":turn.completed"))) break;
    }
    expect(types.some((t) => t.endsWith(":turn.started"))).toBe(true);
    expect(types.some((t) => t.endsWith(":message.assistant"))).toBe(true);
    expect(types.some((t) => t.endsWith(":turn.completed"))).toBe(true);

    // unsubscribe stops the pump: no further frames arrive
    ws.send(JSON.stringify({ type: "unsubscribe", session_id: meta.session_id }));
    const quiet = await client.next(1200, "quiet").then(
      () => false,
      () => true,
    );
    expect(quiet).toBe(true);

    ws.close();
    await handle.close();
  });
});
