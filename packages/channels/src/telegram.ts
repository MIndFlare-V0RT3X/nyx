// SPDX-License-Identifier: AGPL-3.0-or-later
// The Telegram channel: long-polling getUpdates against the Bot API, replies
// rendered by editing one message as deltas arrive (throttled to Telegram's
// real-world edit rate), final text on turn completion. The client is an
// interface so tests stub the API and CI never touches the network; the
// default client talks to api.telegram.org with the operator's bot token.

import type { Logger } from "@nyx/protocol";
import type {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundMessage,
  TelegramChannelConfig,
} from "./types.js";
import type { ChannelManager } from "./manager.js";

/** The Telegram Bot API surface this adapter needs (injectable for tests). */
export interface TelegramClient {
  getUpdates(offset: number, timeout_s: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(
    chat_id: string,
    text: string,
    opts?: { reply_markup?: unknown },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chat_id: string,
    message_id: number,
    text: string,
    opts?: { reply_markup?: unknown },
  ): Promise<void>;
  /** 2.1: stop the client-side spinner on a callback query. */
  answerCallbackQuery(callback_query_id: string, text?: string): Promise<void>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  /** 2.1: inline-keyboard button press (approval resolution). */
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
}

const TELEGRAM_MAX_LEN = 4096;
/** Never edit faster than this even if deltas arrive quicker. */
const MIN_EDIT_INTERVAL_MS = 1_200;

export function createHttpTelegramClient(
  token: string,
  baseUrl = "https://api.telegram.org",
): TelegramClient {
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`telegram ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok || body.result === undefined) {
      throw new Error(`telegram ${method} failed: ${body.description ?? "unknown error"}`);
    }
    return body.result;
  };
  return {
    getUpdates: (offset, timeout_s, signal) =>
      call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: timeout_s,
        allowed_updates: ["message", "callback_query"],
      }).catch(async (err: unknown) => {
        // Long-poll aborted by stop(): a clean shutdown, not an error.
        if (signal.aborted) return [];
        throw err;
      }),
    sendMessage: (chat_id, text, opts) =>
      call<{ message_id: number }>("sendMessage", {
        chat_id,
        text,
        ...(opts?.reply_markup !== undefined ? { reply_markup: opts.reply_markup } : {}),
      }),
    editMessageText: (chat_id, message_id, text, opts) =>
      call<boolean>("editMessageText", {
        chat_id,
        message_id,
        text,
        ...(opts?.reply_markup !== undefined ? { reply_markup: opts.reply_markup } : {}),
      }).then(() => undefined),
    answerCallbackQuery: (callback_query_id, text) =>
      call<boolean>("answerCallbackQuery", {
        callback_query_id,
        ...(text !== undefined ? { text } : {}),
      }).then(() => undefined),
  };
}

export interface TelegramAdapterOptions {
  config: TelegramChannelConfig;
  manager: ChannelManager;
  client: TelegramClient;
  logger?: Logger;
  now?: () => number;
  /** Test seam: sleep between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** 2.1: callback_query routing (the approval bridge). */
  onCallbackQuery?: (query: NonNullable<TelegramUpdate["callback_query"]>) => void;
}

export class TelegramChannel implements ChannelAdapter {
  readonly id = "telegram";
  readonly capabilities: ChannelCapability[] = ["text", "thread"];
  private readonly opts: TelegramAdapterOptions;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private offset = 0;
  private messageHandlers: Array<(msg: InboundMessage) => void> = [];
  private errorHandlers: Array<(err: unknown) => void> = [];

  constructor(opts: TelegramAdapterOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.controller !== undefined) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.opts.logger?.info("channel.telegram.started", {
      poll_timeout_s: this.opts.config.poll_timeout_s,
      allowed_user_ids: this.opts.config.allowed_user_ids.length,
    });
    this.loop = (async () => {
      while (!signal.aborted) {
        try {
          const updates = await this.opts.client.getUpdates(
            this.offset,
            this.opts.config.poll_timeout_s,
            signal,
          );
          for (const update of updates) {
            this.offset = update.update_id + 1;
            this.dispatch(update);
          }
        } catch (err) {
          if (signal.aborted) return;
          for (const h of this.errorHandlers) h(err);
          await (this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(
            1_000,
          );
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  async send(msg: OutboundMessage): Promise<{ message_id: string }> {
    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const chatId = msg.channel_thread_id;
    if (chatId === undefined) throw new Error("telegram send requires channel_thread_id (chat id)");
    // Telegram caps messages at 4096 chars — split long replies.
    const sent = await this.opts.client.sendMessage(chatId, text.slice(0, TELEGRAM_MAX_LEN));
    for (let offset = TELEGRAM_MAX_LEN; offset < text.length; offset += TELEGRAM_MAX_LEN) {
      await this.opts.client.sendMessage(chatId, text.slice(offset, offset + TELEGRAM_MAX_LEN));
    }
    return { message_id: String(sent.message_id) };
  }

  onMessage(handler: (msg: InboundMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const i = this.messageHandlers.indexOf(handler);
      if (i >= 0) this.messageHandlers.splice(i, 1);
    };
  }

  onError(handler: (err: unknown) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const i = this.errorHandlers.indexOf(handler);
      if (i >= 0) this.errorHandlers.splice(i, 1);
    };
  }

  private dispatch(update: TelegramUpdate): void {
    // 2.1: inline-keyboard button presses route to the approval bridge.
    if (update.callback_query !== undefined) {
      this.opts.onCallbackQuery?.(update.callback_query);
      return;
    }
    const message = update.message;
    if (message === undefined || message.text === undefined || message.from === undefined) return;
    const msg: InboundMessage = {
      channel: "telegram",
      channel_user_id: String(message.from.id),
      channel_thread_id: String(message.chat.id),
      content: [{ type: "text", text: message.text }],
      received_at: (this.opts.now ?? Date.now)(),
      raw: update,
    };
    for (const h of this.messageHandlers) h(msg);
    // The rendering flow: identity/session/turn policy is the manager's; the
    // adapter renders the outcome (§4.4 — streaming via message edits).
    void this.render(msg);
  }

  private async render(msg: InboundMessage): Promise<void> {
    const chatId = msg.channel_thread_id;
    if (chatId === undefined) return;
    try {
      const result = await this.opts.manager.handleInbound(msg);
      if (result.status === "rejected") {
        return; // no reply for unrecognized users (anti-abuse)
      }
      if (result.status === "replied") {
        await this.opts.client.sendMessage(chatId, result.text);
        return;
      }

      // Streaming: one message, edited as deltas arrive, throttled.
      let messageId: number | undefined;
      let current = "";
      let lastEditAt = 0;
      let dirty = false;
      const editInterval = Math.max(
        this.opts.config.edit_interval_ms ?? 1_500,
        MIN_EDIT_INTERVAL_MS,
      );
      const now = this.opts.now ?? Date.now;

      const maybeEdit = async (): Promise<void> => {
        if (!dirty) return;
        const t = now();
        if (messageId !== undefined && t - lastEditAt < editInterval) return; // throttled
        dirty = false;
        lastEditAt = t;
        const text = current === "" ? "…" : current;
        if (messageId === undefined) {
          const sent = await this.opts.client.sendMessage(chatId, text.slice(0, TELEGRAM_MAX_LEN));
          messageId = sent.message_id;
        } else {
          await this.opts.client
            .editMessageText(chatId, messageId, text.slice(0, TELEGRAM_MAX_LEN))
            .catch(() => undefined); // edits of unchanged text fail; not fatal
        }
      };

      const unsubscribe = result.handle.onEvent((event) => {
        if (event.type === "text.delta") {
          current += event.text; // deltas are incremental (see the CLI chat state)
          dirty = true;
        } else if (event.type === "message.assistant") {
          for (const block of event.content) {
            if (block.type === "text") {
              current = block.text; // the committed message wins
              dirty = true;
            }
          }
        } else if (event.type === "turn.completed" || event.type === "turn.failed") {
          dirty = true;
        }
        void maybeEdit();
      });

      try {
        const settled = await result.handle.completion;
        // Final render: the completed reply text exactly once.
        const finalText =
          settled.text === "" ? (settled.ok ? "(no reply text)" : "turn failed") : settled.text;
        if (messageId === undefined) {
          await this.opts.client.sendMessage(chatId, finalText.slice(0, TELEGRAM_MAX_LEN));
        } else if (finalText.slice(0, TELEGRAM_MAX_LEN) !== current.slice(0, TELEGRAM_MAX_LEN)) {
          await this.opts.client
            .editMessageText(chatId, messageId, finalText.slice(0, TELEGRAM_MAX_LEN))
            .catch(() => undefined);
        }
      } finally {
        unsubscribe();
      }
    } catch (err) {
      for (const h of this.errorHandlers) h(err);
    }
  }
}
