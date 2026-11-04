// SPDX-License-Identifier: AGPL-3.0-or-later
// Heartbeat integration (Phase 1 §1.3): a triggered heartbeat enqueues a
// turn at heartbeat priority into a (new) session's lane and it runs the
// normal agent loop; a disabled config registers no specs; the persisted
// state lands in the unified nyx.db.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema } from "@nyx/config";
import type { NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn } from "@nyx/model";
import { createServer as createNyxServer } from "./server.js";
import Database from "better-sqlite3";

interface Rig {
  server: ReturnType<typeof createNyxServer>;
  dataDir: string;
  close(): Promise<void>;
}
const rigs: Rig[] = [];

afterAll(async () => {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) await rm(rig.dataDir, { recursive: true, force: true });
});

async function makeRig(opts: { heartbeat?: unknown } = {}): Promise<Rig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-hb-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-hb-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-hb-mem-"));
  const config: NyxConfig = configSchema.parse({
    server: { host: "127.0.0.1", port: 8791, auth: { owner_token: "hb-owner-token" } },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
    ...(opts.heartbeat !== undefined ? { heartbeat: opts.heartbeat } : {}),
  });
  const server = createNyxServer({
    config,
    data_dir: dataDir,
    providers: [new MockProvider("mock", [mockTextTurn("HEARTBEAT-REPLY")])],
  });
  const rig: Rig = { server, dataDir, close: () => server.close() };
  rigs.push(rig);
  return rig;
}

describe("heartbeat (server integration)", () => {
  it("trigger() fires a turn at heartbeat priority into a new session via the lane", async () => {
    const rig = await makeRig({
      heartbeat: {
        enabled: true,
        specs: [
          {
            id: "memory-review",
            schedule: "0 3 * * *",
            prompt: "Review the last 24 hours of memory.",
            priority: "heartbeat",
            enabled: true,
          },
        ],
      },
    });

    expect(rig.server.heartbeats.list().map((s) => s.id)).toEqual(["memory-review"]);

    // Manual fire (the same path a scheduled fire takes).
    await rig.server.heartbeats.trigger("memory-review");

    // The turn ran in a fresh session through the real loop: find it in the
    // store and assert the full event sequence.
    const { openSessionStore } = await import("@nyx/session");
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    try {
      const sessions = await store.list({ limit: 10 });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const hbSession = sessions.find((s) => s.title === "heartbeat memory-review");
      expect(hbSession).toBeDefined();
      const events = await store.read(hbSession!.session_id, 1);
      const types = events.map((e) => e.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("message.user");
      expect(types).toContain("message.assistant");
      expect(types[types.length - 1]).toBe("turn.completed");
      const user = events.find((e) => e.type === "message.user");
      expect(JSON.stringify(user)).toContain("Review the last 24 hours of memory.");
    } finally {
      store.close();
    }

    // The manual fire is persisted in the unified nyx.db history.
    const hbDb = new Database(join(rig.dataDir, "nyx.db"));
    try {
      const rows = hbDb
        .prepare("SELECT spec_id, status, source FROM heartbeat_history")
        .all() as Array<{ spec_id: string; status: string; source: string }>;
      expect(rows).toEqual([{ spec_id: "memory-review", status: "fired", source: "manual" }]);
    } finally {
      hbDb.close();
    }
  });

  it("heartbeat config absent → no specs registered, nothing runs", async () => {
    const rig = await makeRig();
    expect(rig.server.heartbeats.list()).toEqual([]);
    await expect(rig.server.heartbeats.trigger("anything")).rejects.toThrow(/unknown heartbeat spec/);
  });
});
