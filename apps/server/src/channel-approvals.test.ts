// SPDX-License-Identifier: AGPL-3.0-or-later
// Full-stack channel approvals (2.1.4): a turn hitting an `ask` verdict on a
// channel surface presents interactively instead of dying on the TTL.
//
// - Telegram: a message triggers an R2-ask tool → inline keyboard appears →
//   "Allow" click runs the tool → "Deny" click skips it → timeout auto-denies
//   with the expired message. A TEXT message while an approval is pending is
//   NOT a decision — it queues as a normal turn.
// - Webhook: the POST returns an approval_required body with resolve_url;
//   POSTing the resolve_url with allow runs the tool, deny skips it.
// - Aborting the session while an approval is pending withdraws it (no
//   orphan) and the turn ends turn.failed/aborted.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as tcpProbe } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { configSchema } from "@nyx/config";
import type { NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn, mockToolTurn } from "@nyx/model";
import { createServer as createNyxServer } from "./server.js";
import { openSessionStore } from "@nyx/session";
import type { TelegramClient, TelegramUpdate } from "@nyx/channels";

const OWNER_TOKEN = "owner-token-approvals";

/** A rule that makes fs.write (R1, no engagement needed) require approval. */
const ASK_FS_WRITE = { id: "ask-write", match: { tool: "fs.write" }, decision: "ask" as const };

interface Rig {
  server: ReturnType<typeof createNyxServer>;
  started: { close(): Promise<void> };
  dataDir: string;
  sandboxRoot: string;
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterAll(async () => {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) {
    await rm(rig.dataDir, { recursive: true, force: true });
    await rm(rig.sandboxRoot, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = tcpProbe();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolvePort(port));
    });
  });
}

async function makeRig(opts: {
  providers: MockProvider[];
  channels: NyxConfig["channels"];
  telegram_client?: TelegramClient;
}): Promise<Rig & { apiPort: number }> {
  const apiPort = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-appr-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-appr-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-appr-mem-"));
  const config: NyxConfig = configSchema.parse({
    server: { host: "127.0.0.1", port: apiPort, auth: { owner_token: OWNER_TOKEN } },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: [ASK_FS_WRITE] },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
    ...(opts.channels !== undefined ? { channels: opts.channels } : {}),
  });
  const server = createNyxServer({
    config,
    data_dir: dataDir,
    providers: opts.providers,
    ...(opts.telegram_client !== undefined ? { telegram_client: opts.telegram_client } : {}),
  });
  const started = await server.start();
  const rig: Rig = {
    server,
    started,
    dataDir,
    sandboxRoot,
    close: async () => {
      await server.close();
      await started.close();
    },
  };
  rigs.push(rig);
  return { ...rig, apiPort };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

/** Every stored event of every session in the rig's store. */
async function allEvents(dataDir: string) {
  const store = openSessionStore(join(dataDir, "nyx.db"));
  try {
    const sessions = await store.list({ limit: 1000 });
    const events = [];
    for (const s of sessions) events.push(...(await store.read(s.session_id, 1)));
    return events;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Mock Telegram client: scripted updates + recorded API calls.
// ---------------------------------------------------------------------------

interface SentCall {
  method: string;
  args: Record<string, unknown>;
}

class MockTelegram implements TelegramClient {
  private updates: TelegramUpdate[] = [];
  private nextId = 1;
  readonly sent: SentCall[] = [];

  push(update: Omit<TelegramUpdate, "update_id">): void {
    this.updates.push({ update_id: this.nextId++, ...update } as TelegramUpdate);
  }

  getUpdates(offset: number, _timeout_s: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return new Promise((resolvePromise, reject) => {
      const check = (): void => {
        const due = this.updates.filter((u) => u.update_id >= offset);
        if (due.length > 0) {
          resolvePromise(due);
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  sendMessage(chat_id: string, text: string, opts?: { reply_markup?: unknown }) {
    this.sent.push({ method: "sendMessage", args: { chat_id, text, ...(opts ?? {}) } });
    return Promise.resolve({ message_id: 500 + this.sent.length });
  }

  editMessageText(
    chat_id: string,
    message_id: number,
    text: string,
    opts?: { reply_markup?: unknown },
  ) {
    this.sent.push({
      method: "editMessageText",
      args: { chat_id, message_id, text, ...(opts ?? {}) },
    });
    return Promise.resolve();
  }

  answerCallbackQuery(callback_query_id: string, text?: string) {
    this.sent.push({ method: "answerCallbackQuery", args: { callback_query_id, text } });
    return Promise.resolve();
  }
}

/** The approval_id from the first keyboard the client was asked to send. */
function approvalIdFromKeyboard(client: MockTelegram): string {
  const send = client.sent.find(
    (s) =>
      s.method === "sendMessage" &&
      (s.args.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard !==
        undefined,
  );
  if (send === undefined) throw new Error("no keyboard sent yet");
  const markup = send.args.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  };
  const data = markup.inline_keyboard[0]![0]!.callback_data;
  return data.slice(data.indexOf(":") + 1);
}

beforeEach(() => {
  // keep each test's rigs independent (module-level array is fine; beforeEach
  // exists to make intent explicit)
});

describe("channel approvals over Telegram (2.1.4)", () => {
  it("message → keyboard → Allow click → tool runs; text during pending is NOT a decision", async () => {
    const telegram = new MockTelegram();
    const rig = await makeRig({
      providers: [
        new MockProvider("mock", [
          mockToolTurn({
            call_id: "c1",
            name: "fs.write",
            input: { path: "t.txt", content: "TG-OK" },
          }),
          mockTextTurn("file written"),
          mockTextTurn("queued reply"),
        ]),
      ],
      channels: {
        telegram: {
          enabled: true,
          bot_token_env: "TG_TOKEN_UNUSED",
          allowed_user_ids: [42],
          poll_timeout_s: 1,
          edit_interval_ms: 500,
        },
      },
      telegram_client: telegram,
    });

    // The operator asks for a write; fs.write is ask-gated by the test rule.
    telegram.push({
      message: { message_id: 1, chat: { id: 100 }, from: { id: 42 }, text: "write the file" },
    });

    await until(() =>
      telegram.sent.some((s) => s.method === "sendMessage" && s.args.reply_markup !== undefined),
    );
    const approvalId = approvalIdFromKeyboard(telegram);

    // A TEXT message while the approval is pending is not a decision: it
    // queues as a normal turn. Wait for the queued turn to be recorded, then
    // assert the approval is STILL pending (no text-based resolution).
    telegram.push({
      message: { message_id: 2, chat: { id: 100 }, from: { id: 42 }, text: "are you there?" },
    });
    const store0 = openSessionStore(join(rig.dataDir, "nyx.db"));
    let telegramSession = "";
    try {
      telegramSession = (await store0.list({ limit: 10 }))[0]!.session_id;
    } finally {
      store0.close();
    }
    await new Promise((r) => setTimeout(r, 200));
    const stillPending = await rig.server.app.request(
      `/v1/approvals?session_id=${telegramSession}`,
      { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } },
    );
    expect(((await stillPending.json()) as Array<unknown>).length).toBe(1); // not resolved by text

    // The Allow click resolves the approval.
    telegram.push({
      callback_query: {
        id: "cq-1",
        data: `allow:${approvalId}`,
        from: { id: 42 },
        message: { message_id: 1, chat: { id: 100 } },
      },
    });

    // The tool ran and the turn completed.
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some((e) => e.type === "tool.result");
    });
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some((e) => e.type === "turn.completed");
    });

    // The file was really written in the session sandbox.
    const sandboxes = await readdir(rig.sandboxRoot);
    expect(sandboxes.length).toBe(1);
    const written = await readFile(join(rig.sandboxRoot, sandboxes[0]!, "t.txt"), "utf8");
    expect(written).toBe("TG-OK");

    // The button press was answered and the keyboard edited to the decision.
    expect(
      telegram.sent.some(
        (s) => s.method === "answerCallbackQuery" && s.args.text === "approved ✅",
      ),
    ).toBe(true);
    expect(
      telegram.sent.some(
        (s) => s.method === "editMessageText" && s.args.text === "✅ approved by telegram:42",
      ),
    ).toBe(true);

    // The queued text turn ran after the approved one (FIFO, no policy skip).
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.filter((e) => e.type === "turn.completed").length >= 2;
    });
  });

  it("Deny click skips the tool; timeout sends the expired message and auto-denies", async () => {
    const telegram = new MockTelegram();
    const rig = await makeRig({
      providers: [
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "fs.write", input: { path: "d.txt", content: "x" } }),
          mockTextTurn("file written"),
          // the deny path's follow-up turn
          mockToolTurn({ call_id: "c2", name: "fs.write", input: { path: "e.txt", content: "y" } }),
          mockTextTurn("done"),
        ]),
      ],
      channels: {
        telegram: {
          enabled: true,
          bot_token_env: "TG_TOKEN_UNUSED",
          allowed_user_ids: [42],
          poll_timeout_s: 1,
          edit_interval_ms: 500,
          approval_ttl_ms: 1_200, // short for the timeout leg
        },
      },
      telegram_client: telegram,
    });

    // Deny leg.
    telegram.push({
      message: { message_id: 1, chat: { id: 100 }, from: { id: 42 }, text: "write it" },
    });
    await until(() =>
      telegram.sent.some((s) => s.method === "sendMessage" && s.args.reply_markup !== undefined),
    );
    const denyId = approvalIdFromKeyboard(telegram);
    telegram.push({
      callback_query: {
        id: "cq-1",
        data: `deny:${denyId}`,
        from: { id: 42 },
        message: { message_id: 1, chat: { id: 100 } },
      },
    });
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some((e) => e.type === "action.denied" && e.reason === "approval");
    });
    const afterDeny = await allEvents(rig.dataDir);
    expect(afterDeny.some((e) => e.type === "tool.result")).toBe(false); // skipped
    expect(
      telegram.sent.some(
        (s) => s.method === "editMessageText" && s.args.text === "❌ denied by telegram:42",
      ),
    ).toBe(true);

    // Timeout leg (same chat, new conversation turn).
    telegram.push({
      message: { message_id: 2, chat: { id: 100 }, from: { id: 42 }, text: "write it again" },
    });
    await until(() => {
      const keyboards = telegram.sent.filter(
        (s) => s.method === "sendMessage" && s.args.reply_markup !== undefined,
      );
      return keyboards.length >= 2;
    });
    // Let the 400ms TTL lapse: the engine auto-denies and withdraws.
    await until(() =>
      telegram.sent.some((s) => s.args.text === "⏱ approval expired — action denied"),
    );
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return (
        events.filter((e) => e.type === "action.denied" && e.reason === "approval").length >= 2
      );
    });
  });

  it("aborting the session while an approval is pending withdraws it (no orphan)", async () => {
    const telegram = new MockTelegram();
    const rig = await makeRig({
      providers: [
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "fs.write", input: { path: "a.txt", content: "x" } }),
          mockTextTurn("file written"),
        ]),
      ],
      channels: {
        telegram: {
          enabled: true,
          bot_token_env: "TG_TOKEN_UNUSED",
          allowed_user_ids: [42],
          poll_timeout_s: 1,
          edit_interval_ms: 500,
        },
      },
      telegram_client: telegram,
    });

    telegram.push({
      message: { message_id: 1, chat: { id: 100 }, from: { id: 42 }, text: "write the file" },
    });
    await until(() =>
      telegram.sent.some((s) => s.method === "sendMessage" && s.args.reply_markup !== undefined),
    );

    // Find the session the channel created, then abort it over the API.
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    let sessionId = "";
    try {
      const sessions = await store.list({ limit: 10 });
      sessionId = sessions[0]!.session_id;
    } finally {
      store.close();
    }
    const res = await rig.server.app.request(`/v1/sessions/${sessionId}/turns`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aborted_running: true });

    // The presenter learned the request died: the keyboard message is edited
    // to "approval withdrawn".
    await until(() =>
      telegram.sent.some(
        (s) => s.method === "editMessageText" && s.args.text === "approval withdrawn",
      ),
    );
    // The turn ended aborted and nothing is pending.
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some(
        (e) =>
          e.type === "turn.failed" && (e as { error: { code?: string } }).error.code === "aborted",
      );
    });
    const pending = await rig.server.app.request(`/v1/approvals?session_id=${sessionId}`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(await pending.json()).toEqual([]);
  });
});

describe("channel approvals over webhook (2.1.4)", () => {
  it("POST → approval_required body → resolve_url allow → tool runs; deny skips", async () => {
    const port = await freePort();
    const rig = await makeRig({
      providers: [
        new MockProvider("mock", [
          mockToolTurn({
            call_id: "c1",
            name: "fs.write",
            input: { path: "w.txt", content: "WH-OK" },
          }),
          mockTextTurn("file written"),
          mockToolTurn({
            call_id: "c2",
            name: "fs.write",
            input: { path: "w2.txt", content: "y" },
          }),
          mockTextTurn("written"),
        ]),
      ],
      channels: {
        webhook: {
          enabled: true,
          path: "/webhook",
          bind: "127.0.0.1",
          port,
          allowed_owners: ["owner:primary"],
          reply_timeout_ms: 15_000,
        },
      },
    });

    const url = `http://127.0.0.1:${port}/webhook`;
    const apiHeaders = {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "content-type": "application/json",
    };

    // The first POST hits the ask verdict: the response IS the presentation.
    const first = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel_user_id: "owner:primary", text: "write it" }),
    }).then(async (res) => ({
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    }));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("approval_required");
    expect(typeof first.body.approval_id).toBe("string");
    expect(first.body.risk).toBe("R1"); // fs.write risk; the ask verdict comes from the policy rule
    expect(String(first.body.resolve_url)).toMatch(/^\/v1\/approvals\/.+\/resolve$/);
    // Channel TTL default: 5 minutes.
    expect(Number(first.body.expires_at) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(Number(first.body.expires_at) - Date.now()).toBeGreaterThan(240_000);

    // Resolve via the resolve_url on the main API (bearer auth).
    const allow = await rig.server.app.request(String(first.body.resolve_url), {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(allow.status).toBe(200);
    expect(((await allow.json()) as { decision: string }).decision).toBe("allow");

    // The tool ran.
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some((e) => e.type === "tool.result");
    });
    const sandboxes = await readdir(rig.sandboxRoot);
    expect(sandboxes.length).toBe(1);
    expect(await readFile(join(rig.sandboxRoot, sandboxes[0]!, "w.txt"), "utf8")).toBe("WH-OK");

    // Deny leg: the second approval is denied — the tool is skipped.
    const second = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel_user_id: "owner:primary", text: "write another" }),
    }).then(async (res) => ({
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    }));
    expect(second.body.status).toBe("approval_required");
    const deny = await rig.server.app.request(String(second.body.resolve_url), {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(deny.status).toBe(200);
    await until(async () => {
      const events = await allEvents(rig.dataDir);
      return events.some((e) => e.type === "action.denied" && e.reason === "approval");
    });
    const events = await allEvents(rig.dataDir);
    expect(events.filter((e) => e.type === "tool.result").length).toBe(1); // only the allowed one

    // The resolve route enforces auth like every other /v1 route.
    const unauth = await rig.server.app.request(String(second.body.resolve_url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(unauth.status).toBe(401);
  });
});
