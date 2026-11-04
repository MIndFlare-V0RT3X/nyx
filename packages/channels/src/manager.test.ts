// SPDX-License-Identifier: AGPL-3.0-or-later
// Manager acceptance tests: identity gate (webhook + telegram), session
// mapping attach/create, /new and /fork, audit on rejection.
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { ContentBlock, SessionEvent } from "@nyx/protocol";
import { ChannelManager } from "./manager.js";
import { ChannelSessionStore } from "./sessions-store.js";
import type { ChannelTurnRunner } from "./types.js";

type DB = Database.Database;
const dbs: DB[] = [];
function freshDb(): DB {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}
afterAll(() => {
  for (const db of dbs) db.close();
});

interface RunnerLog {
  created: Array<{ owner_id: string; title?: string }>;
  forked: string[];
  turns: Array<{ session_id: string; text: string }>;
}

function fakeRunner(replyText = "THE-REPLY"): { runner: ChannelTurnRunner; log: RunnerLog } {
  const log: RunnerLog = { created: [], forked: [], turns: [] };
  let turnN = 0;
  const runner: ChannelTurnRunner = {
    createSession: async (input) => {
      log.created.push(input);
      return { session_id: `sess-${log.created.length}`, persona_id: "default" };
    },
    forkSession: async (session_id) => {
      log.forked.push(session_id);
      return { session_id: `fork-${log.forked.length}` };
    },
    startTurn: (input) => {
      turnN += 1;
      const turn_id = `turn-${turnN}`;
      log.turns.push({ session_id: input.session_id, text: (input.content[0] as { text: string }).text });
      const handlers = new Set<(event: SessionEvent) => void>();
      const events: SessionEvent[] = [
        { type: "turn.started", session_id: input.session_id, turn_id, ts: 1 },
        { type: "text.delta", session_id: input.session_id, turn_id, text: "THE-", ts: 2 },
        { type: "text.delta", session_id: input.session_id, turn_id, text: "REPLY", ts: 3 },
        {
          type: "message.assistant",
          session_id: input.session_id,
          turn_id,
          content: [{ type: "text", text: replyText }],
          ts: 4,
        },
        { type: "turn.completed", session_id: input.session_id, turn_id, usage: { input_tokens: 1, output_tokens: 1 }, ts: 5 },
      ];
      void (async () => {
        for (const e of events) {
          await new Promise((r) => setTimeout(r, 1));
          for (const h of handlers) h(e);
        }
      })();
      return {
        turn_id,
        completion: new Promise((resolve) => {
          void (async () => {
            await new Promise((r) => setTimeout(r, 10));
            resolve({ ok: true, text: replyText });
          })();
        }),
        onEvent: (cb) => {
          handlers.add(cb);
          return () => handlers.delete(cb);
        },
      };
    },
  };
  return { runner, log };
}

function makeManager(overrides: Partial<ConstructorParameters<typeof ChannelManager>[0]> = {}) {
  const { runner, log } = fakeRunner();
  const sessions = new ChannelSessionStore(freshDb());
  const auditEntries: Array<{ actor: string; action: string; payload: unknown }> = [];
  const manager = new ChannelManager({
    config: {
      webhook: {
        enabled: true,
        path: "/webhook",
        bind: "127.0.0.1",
        port: 8089,
        allowed_owners: ["owner:primary"],
        reply_timeout_ms: 5_000,
      },
      telegram: {
        enabled: true,
        bot_token_env: "NYX_TELEGRAM_BOT_TOKEN",
        allowed_user_ids: [123456789],
        poll_timeout_s: 1,
        edit_interval_ms: 1_500,
      },
    },
    runner,
    sessions,
    audit: (entry) => auditEntries.push(entry),
    now: () => 1_000_000,
    ...overrides,
  });
  return { manager, log, sessions, auditEntries };
}

function inbound(channel: string, userId: string, text: string, threadId?: string) {
  const content: ContentBlock[] = [{ type: "text", text }];
  return {
    channel,
    channel_user_id: userId,
    ...(threadId !== undefined ? { channel_thread_id: threadId } : {}),
    content,
    received_at: 1_000_000,
    raw: {},
  };
}

describe("ChannelManager", () => {
  it("webhook: a known owner runs a turn; an unknown user is rejected with an audit row and no runner work", async () => {
    const { manager, log, auditEntries } = makeManager();

    const ok = await manager.handleInbound(inbound("webhook", "owner:primary", "hello"));
    expect(ok.status).toBe("started");
    if (ok.status !== "started") return;
    expect(ok.session_id).toBe("sess-1");
    const settled = await ok.handle.completion;
    expect(settled.text).toBe("THE-REPLY");

    const bad = await manager.handleInbound(inbound("webhook", "owner:attacker", "let me in"));
    expect(bad).toEqual({ status: "rejected", reason: "unrecognized channel user" });
    expect(log.turns).toHaveLength(1); // the attacker never started a turn
    expect(log.created).toHaveLength(1); // and never created a session
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]!.action).toBe("channel.identity.rejected");
    expect(auditEntries[0]!.payload).toMatchObject({ channel: "webhook", channel_user_id: "owner:attacker" });
  });

  it("telegram: an allowed user id maps to telegram:<id>; others are rejected", async () => {
    const { manager, log } = makeManager();

    const ok = await manager.handleInbound(inbound("telegram", "123456789", "hi", "42"));
    expect(ok.status).toBe("started");
    expect(log.created[0]!.owner_id).toBe("telegram:123456789");

    const bad = await manager.handleInbound(inbound("telegram", "666", "hi", "42"));
    expect(bad.status).toBe("rejected");
    expect(log.created).toHaveLength(1);
  });

  it("first message creates a session; the second attaches to the same one (same thread key)", async () => {
    const { manager, log } = makeManager();
    const first = await manager.handleInbound(inbound("webhook", "owner:primary", "one"));
    const second = await manager.handleInbound(inbound("webhook", "owner:primary", "two"));
    expect(first.status).toBe("started");
    expect(second.status).toBe("started");
    if (first.status !== "started" || second.status !== "started") return;
    expect(second.session_id).toBe(first.session_id);
    expect(log.created).toHaveLength(1);
    expect(log.turns.map((t) => t.text)).toEqual(["one", "two"]);

    // A different thread maps to a different conversation.
    const other = await manager.handleInbound(inbound("webhook", "owner:primary", "x", "thread-2"));
    expect(other.status).toBe("started");
    if (other.status !== "started") return;
    expect(other.session_id).not.toBe(first.session_id);
    expect(log.created).toHaveLength(2);
  });

  it("/new starts a fresh session and remaps the conversation", async () => {
    const { manager, log } = makeManager();
    const first = await manager.handleInbound(inbound("telegram", "123456789", "hello", "7"));
    expect(first.status).toBe("started");

    const cmd = await manager.handleInbound(inbound("telegram", "123456789", "/new", "7"));
    expect(cmd.status).toBe("replied");
    if (cmd.status !== "replied") return;
    expect(cmd.text).toContain("new session started");
    expect(cmd.session_id).not.toBe((first as { session_id: string }).session_id);
    expect(log.created).toHaveLength(2);

    // Subsequent messages attach to the new session.
    const after = await manager.handleInbound(inbound("telegram", "123456789", "next", "7"));
    expect(after.status).toBe("started");
    if (after.status !== "started") return;
    expect(after.session_id).toBe(cmd.session_id);
  });

  it("/fork forks at the last event and remaps; with no prior session it starts fresh", async () => {
    const { manager, log } = makeManager();
    const first = await manager.handleInbound(inbound("webhook", "owner:primary", "history"));
    expect(first.status).toBe("started");
    if (first.status !== "started") return;

    const cmd = await manager.handleInbound(inbound("webhook", "owner:primary", "/fork"));
    expect(cmd.status).toBe("replied");
    if (cmd.status !== "replied") return;
    expect(cmd.text).toContain("forked at the last event");
    expect(log.forked).toEqual([first.session_id]);

    // No prior mapping → graceful fresh start.
    const fresh = await manager.handleInbound(inbound("webhook", "owner:primary", "/fork", "never-seen"));
    expect(fresh.status).toBe("replied");
    if (fresh.status !== "replied") return;
    expect(fresh.text).toContain("no session to fork");
  });
});
