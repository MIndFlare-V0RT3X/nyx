// SPDX-License-Identifier: AGPL-3.0-or-later
// Telegram adapter acceptance tests (§4.5), fully against a stubbed Bot API:
// an allowed user's message runs a turn and streams via sendMessage +
// editMessageText; a disallowed user gets nothing; /new and /fork work; the
// send/edit/fork flow never touches the network.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { SessionEvent } from "@nyx/protocol";
import { ChannelManager } from "./manager.js";
import { ChannelSessionStore } from "./sessions-store.js";
import { TelegramChannel } from "./telegram.js";
import type { TelegramClient, TelegramUpdate } from "./telegram.js";
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

/** A controllable getUpdates stub: blocks until the test pushes an update. */
class StubTelegramClient implements TelegramClient {
  sent: Array<{ chat_id: string; text: string; kind: "send" | "edit"; message_id?: number }> = [];
  private queue: Array<() => void> = [];
  private pending: Array<TelegramUpdate> = [];
  private blocked: Array<(updates: TelegramUpdate[]) => void> = [];
  closed = false;

  push(update: TelegramUpdate): void {
    this.pending.push(update);
    for (const wake of this.blocked.splice(0)) wake(this.pending.splice(0));
  }

  wake(): void {
    for (const wake of this.blocked.splice(0)) wake([]);
  }

  async getUpdates(offset: number, _timeout_s: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    if (this.pending.length > 0) return this.pending.splice(0);
    if (signal.aborted || this.closed) return [];
    return new Promise<TelegramUpdate[]>((resolve) => {
      this.blocked.push(resolve);
      signal.addEventListener("abort", () => {
        const i = this.blocked.indexOf(resolve);
        if (i >= 0) {
          this.blocked.splice(i, 1);
          resolve([]);
        }
      }, { once: true });
    });
  }

  async sendMessage(
    chat_id: string,
    text: string,
    _opts?: { reply_markup?: unknown },
  ): Promise<{ message_id: number }> {
    void _opts;
    const message_id = this.sent.length + 1;
    this.sent.push({ chat_id, text, kind: "send", message_id });
    return { message_id };
  }

  async editMessageText(
    chat_id: string,
    message_id: number,
    text: string,
    _opts?: { reply_markup?: unknown },
  ): Promise<void> {
    void _opts;
    this.sent.push({ chat_id, text, kind: "edit", message_id });
  }

  async answerCallbackQuery(_callback_query_id: string, _text?: string): Promise<void> {
    void _callback_query_id;
    void _text;
  }
}

function fakeRunner(replyEvents: SessionEvent[] = [], replyText = "TG-REPLY"): {
  runner: ChannelTurnRunner;
  created: string[];
  forked: string[];
  turnInputs: Array<{ session_id: string; text: string }>;
} {
  const created: string[] = [];
  const forked: string[] = [];
  const turnInputs: Array<{ session_id: string; text: string }> = [];
  const runner: ChannelTurnRunner = {
    createSession: async () => {
      created.push(`sess-${created.length}`);
      return { session_id: `sess-${created.length}`, persona_id: "default" };
    },
    forkSession: async (sid) => {
      forked.push(sid);
      return { session_id: `fork-${forked.length}` };
    },
    startTurn: (input) => {
      const text = (input.content[0] as { text: string }).text;
      turnInputs.push({ session_id: input.session_id, text });
      const turn_id = `turn-${turnInputs.length}`;
      const handlers = new Set<(event: SessionEvent) => void>();
      void (async () => {
        for (const e of replyEvents) {
          await new Promise((r) => setTimeout(r, 5));
          for (const h of handlers) h(e);
        }
      })();
      return {
        turn_id,
        completion: new Promise((resolve) => {
          void (async () => {
            await new Promise((r) => setTimeout(r, 20 + replyEvents.length * 5));
            resolve({ ok: true, text: replyText });
          })();
        }),
        onEvent: (cb) => (handlers.add(cb), () => handlers.delete(cb)),
      };
    },
  };
  return { runner, created, forked, turnInputs };
}

async function startTg(replyEvents?: SessionEvent[], replyText?: string) {
  const { runner, created, forked, turnInputs } = fakeRunner(replyEvents, replyText);
  const auditEntries: Array<{ action: string; payload: unknown }> = [];
  const manager = new ChannelManager({
    config: {
      telegram: {
        enabled: true,
        bot_token_env: "NYX_TELEGRAM_BOT_TOKEN",
        allowed_user_ids: [123456789],
        poll_timeout_s: 25,
        edit_interval_ms: 1_200,
      },
    },
    runner,
    sessions: new ChannelSessionStore(freshDb()),
    audit: (entry) => auditEntries.push(entry),
  });
  const client = new StubTelegramClient();
  const adapter = new TelegramChannel({
    config: manager.telegram!,
    manager,
    client,
    now: () => {
      // A fake clock that advances 1_500ms per call: every dirty render passes
      // the throttle, deterministically.
      fakeClock += 1_500;
      return fakeClock;
    },
  });
  await adapter.start();
  return { adapter, client, created, forked, turnInputs, auditEntries };
}

let fakeClock = 1_000_000;
beforeEach(() => {
  fakeClock = 1_000_000;
});

function message(updateId: number, userId: number, text: string, chatId = 42): TelegramUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId * 10, chat: { id: chatId }, from: { id: userId }, text },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withTg(
  fn: (h: Awaited<ReturnType<typeof startTg>>) => Promise<void>,
  replyEvents?: SessionEvent[],
  replyText?: string,
): Promise<void> {
  const h = await startTg(replyEvents, replyText);
  try {
    await fn(h);
  } finally {
    await h.adapter.stop();
  }
}

describe("TelegramChannel", () => {
  it("an allowed user's message runs a turn and the reply streams via send + edit", async () => {
    const sid = "sess-1";
    const events: SessionEvent[] = [
      { type: "text.delta", session_id: sid, turn_id: "turn-1", text: "TG-", ts: 1 },
      { type: "text.delta", session_id: sid, turn_id: "turn-1", text: "RE", ts: 2 },
      { type: "text.delta", session_id: sid, turn_id: "turn-1", text: "PLY", ts: 3 },
    ];
    await withTg(async (h) => {
      h.client.push(message(1, 123456789, "hello"));
      await sleep(150);
      expect(h.turnInputs).toEqual([{ session_id: "sess-1", text: "hello" }]);
      // One message was sent, then edited with the accumulated deltas.
      const sends = h.client.sent.filter((s) => s.kind === "send");
      const edits = h.client.sent.filter((s) => s.kind === "edit");
      expect(sends.length).toBe(1);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      // The final text is the completed reply.
      const last = h.client.sent[h.client.sent.length - 1]!;
      expect(last.text).toBe("TG-REPLY");
    }, events, "TG-REPLY");
  });

  it("a message from a disallowed user id is ignored: no turn, no reply, audited", async () => {
    await withTg(async (h) => {
      h.client.push(message(2, 666, "let me in"));
      await sleep(80);
      expect(h.turnInputs).toHaveLength(0);
      expect(h.created).toHaveLength(0);
      expect(h.client.sent).toHaveLength(0);
      expect(h.auditEntries).toHaveLength(1);
      expect(h.auditEntries[0]!.action).toBe("channel.identity.rejected");
    });
  });

  it("/new starts a fresh session; /fork forks the current one", async () => {
    await withTg(async (h) => {
      h.client.push(message(3, 123456789, "hello"));
      await sleep(60);
      expect(h.created).toHaveLength(1);

      h.client.push(message(4, 123456789, "/new"));
      await sleep(60);
      expect(h.created).toHaveLength(2);
      // The confirmation went to the chat.
      expect(h.client.sent.some((s) => s.text.includes("new session started"))).toBe(true);

      h.client.push(message(5, 123456789, "/fork"));
      await sleep(60);
      expect(h.forked).toEqual(["sess-2"]);
      expect(h.client.sent.some((s) => s.text.includes("forked at the last event"))).toBe(true);
    });
  });

  it("non-text updates and updates without a sender are ignored", async () => {
    await withTg(async (h) => {
      h.client.push({ update_id: 6 });
      h.client.push({ update_id: 7, message: { message_id: 1, chat: { id: 42 }, text: "no sender" } });
      await sleep(60);
      expect(h.turnInputs).toHaveLength(0);
      expect(h.created).toHaveLength(0);
    });
  });

  it("stop() halts the poll loop cleanly", async () => {
    const h = await startTg();
    h.client.closed = true;
    h.client.wake();
    await h.adapter.stop();
    expect(h.client.sent).toHaveLength(0);
  });
});
