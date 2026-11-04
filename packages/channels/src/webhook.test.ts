// SPDX-License-Identifier: AGPL-3.0-or-later
// Webhook adapter acceptance tests (§4.5): a valid POST creates a session and
// returns it; a second POST attaches; an unknown user is rejected (403) and
// audited; a slow turn answers 202 with ids once the timeout elapses; the
// reply is sent exactly once, in the response.
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { SessionEvent } from "@nyx/protocol";
import { ChannelManager } from "./manager.js";
import { ChannelSessionStore } from "./sessions-store.js";
import { WebhookChannel } from "./webhook.js";
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

function fakeRunner(opts: { delayMs?: number } = {}): { runner: ChannelTurnRunner; created: string[]; turns: string[] } {
  const created: string[] = [];
  const turns: string[] = [];
  const runner: ChannelTurnRunner = {
    createSession: async () => {
      created.push(`sess-${created.length}`);
      return { session_id: `sess-${created.length}`, persona_id: "default" };
    },
    forkSession: async (sid) => ({ session_id: `fork-of-${sid}` }),
    startTurn: (input) => {
      turns.push(input.session_id);
      const turn_id = `turn-${turns.length}`;
      const handlers = new Set<(event: SessionEvent) => void>();
      const completion = new Promise<{ ok: boolean; text: string }>((resolve) => {
        void (async () => {
          await new Promise((r) => setTimeout(r, opts.delayMs ?? 10));
          for (const h of handlers) {
            h({ type: "text.delta", session_id: input.session_id, turn_id, text: "reply", ts: 1 });
          }
          resolve({ ok: true, text: "WEBHOOK-REPLY" });
        })();
      });
      return { turn_id, completion, onEvent: (cb) => (handlers.add(cb), () => handlers.delete(cb)) };
    },
  };
  return { runner, created, turns };
}

async function startWebhook(opts: { replyTimeoutMs?: number; delayMs?: number } = {}) {
  const { runner, created, turns } = fakeRunner({ delayMs: opts.delayMs });
  const auditEntries: Array<{ action: string; payload: unknown }> = [];
  const manager = new ChannelManager({
    config: {
      webhook: {
        enabled: true,
        path: "/webhook",
        bind: "127.0.0.1",
        port: 0,
        allowed_owners: ["owner:primary"],
        reply_timeout_ms: opts.replyTimeoutMs ?? 5_000,
      },
    },
    runner,
    sessions: new ChannelSessionStore(freshDb()),
    audit: (entry) => auditEntries.push(entry),
  });
  const adapter = new WebhookChannel({ config: manager.webhook!, manager });
  await adapter.start();
  const port = (adapter["server"]!.address() as { port: number }).port;
  return { adapter, port, created, turns, auditEntries, url: `http://127.0.0.1:${port}/webhook` };
}

interface WebhookJson {
  session_id?: string;
  turn_id?: string;
  reply?: string;
  note?: string;
  error?: string;
}

function post(url: string, body: unknown): Promise<{ status: number; json: WebhookJson }> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: (await res.json()) as WebhookJson }));
}

describe("WebhookChannel", () => {
  it("a valid POST creates a session, runs the turn, and returns the reply; a second POST attaches", async () => {
    const h = await startWebhook();
    try {
      const first = await post(h.url, { channel_user_id: "owner:primary", text: "hello" });
      expect(first.status).toBe(200);
      expect(first.json.session_id).toBe("sess-1");
      expect(first.json.reply).toBe("WEBHOOK-REPLY");

      const second = await post(h.url, { channel_user_id: "owner:primary", text: "again" });
      expect(second.status).toBe(200);
      expect(second.json.session_id).toBe("sess-1"); // attached, not re-created
      expect(h.created).toHaveLength(1);
      expect(h.turns).toEqual(["sess-1", "sess-1"]);
    } finally {
      await h.adapter.stop();
    }
  });

  it("an unknown channel_user_id is a 403, audited, and starts nothing", async () => {
    const h = await startWebhook();
    try {
      const bad = await post(h.url, { channel_user_id: "stranger", text: "let me in" });
      expect(bad.status).toBe(403);
      expect(h.created).toHaveLength(0);
      expect(h.turns).toHaveLength(0);
      expect(h.auditEntries).toHaveLength(1);
      expect(h.auditEntries[0]!.action).toBe("channel.identity.rejected");
    } finally {
      await h.adapter.stop();
    }
  });

  it("a slow turn answers 202 with session and turn ids once reply_timeout_ms elapses", async () => {
    const h = await startWebhook({ replyTimeoutMs: 60, delayMs: 5_000 });
    try {
      const res = await post(h.url, { channel_user_id: "owner:primary", text: "slow" });
      expect(res.status).toBe(202);
      expect(res.json.session_id).toBe("sess-1");
      expect(res.json.turn_id).toBe("turn-1");
      expect(res.json.reply).toBeUndefined();
    } finally {
      await h.adapter.stop();
    }
  });

  it("non-POST or wrong path is a 404; a malformed body is a 400", async () => {
    const h = await startWebhook();
    try {
      const get = await fetch(h.url);
      expect(get.status).toBe(404);
      const wrongPath = await post(`${h.url.replace("/webhook", "/nope")}`, {});
      expect(wrongPath.status).toBe(404);
      const malformed = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(malformed.status).toBe(400);
      const missing = await post(h.url, { text: "no user" });
      expect(missing.status).toBe(400);
    } finally {
      await h.adapter.stop();
    }
  });
});
