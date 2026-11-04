// SPDX-License-Identifier: AGPL-3.0-or-later
// The channel manager: the single policy point every inbound message passes
// through, whatever the platform. Identity is checked against the operator's
// configured allow lists (unrecognized users are rejected with an audit row
// and no reply — the anti-abuse boundary); conversations map to sessions by
// sha256(channel:user:thread); /new and /fork are handled here, never by the
// model; turns run through the host's TurnRunner (the same lane queue and
// agent loop the HTTP API uses — channels add no parallel policy path).

import type { ContentBlock, Logger, SessionEvent } from "@nyx/protocol";
import type {
  ChannelTurnHandle,
  ChannelTurnRunner,
  ChannelsRuntimeConfig,
  InboundMessage,
  TelegramChannelConfig,
  WebhookChannelConfig,
} from "./types.js";
import type { ChannelSessionStore } from "./sessions-store.js";

export type HandleResult =
  | { status: "rejected"; reason: string }
  | { status: "replied"; text: string; session_id?: string }
  | { status: "started"; handle: ChannelTurnHandle; session_id: string };

export interface ChannelManagerDeps {
  config: ChannelsRuntimeConfig;
  runner: ChannelTurnRunner;
  sessions: ChannelSessionStore;
  /** Audit sink for security-relevant channel decisions (identity rejections). */
  audit?: (entry: { actor: string; action: string; payload: unknown }) => void;
  logger?: Logger;
  now?: () => number;
}

/** Extract the first text block's text (channel transport is text-first). */
export function inboundText(msg: InboundMessage): string {
  for (const block of msg.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Render a turn's reply text from its event stream (deltas, then final message). */
export function replyTextFromEvents(events: SessionEvent[]): string {
  let text = "";
  for (const e of events) {
    if (e.type === "message.assistant") {
      for (const block of e.content) {
        if (block.type === "text") text = block.text; // the committed message wins
      }
    }
  }
  return text;
}

export class ChannelManager {
  readonly webhook?: WebhookChannelConfig;
  readonly telegram?: TelegramChannelConfig;
  private readonly runner: ChannelTurnRunner;
  private readonly sessions: ChannelSessionStore;
  private readonly audit: ChannelManagerDeps["audit"];
  private readonly log: Logger | undefined;
  private readonly now: () => number;

  constructor(deps: ChannelManagerDeps) {
    this.webhook = deps.config.webhook;
    this.telegram = deps.config.telegram;
    this.runner = deps.runner;
    this.sessions = deps.sessions;
    this.audit = deps.audit;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The owner id a channel user maps to, or null when the user is not
   * recognized. Webhook: the payload's channel_user_id must be one of the
   * configured allowed_owners. Telegram: the numeric user id must be in
   * allowed_user_ids and maps to "telegram:<id>".
   */
  resolveOwner(channel: string, channel_user_id: string): string | null {
    if (channel === "webhook") {
      const cfg = this.webhook;
      if (cfg === undefined || !cfg.allowed_owners.includes(channel_user_id)) return null;
      return channel_user_id;
    }
    if (channel === "telegram") {
      const cfg = this.telegram;
      const numeric = Number(channel_user_id);
      if (cfg === undefined || !Number.isInteger(numeric) || !cfg.allowed_user_ids.includes(numeric)) {
        return null;
      }
      return `telegram:${numeric}`;
    }
    return null;
  }

  /** The full inbound pipeline. Adapters render the result; policy lives here. */
  async handleInbound(msg: InboundMessage): Promise<HandleResult> {
    const owner = this.resolveOwner(msg.channel, msg.channel_user_id);
    if (owner === null) {
      // Anti-abuse boundary: rejected with an audit row, no reply.
      this.audit?.({
        actor: `channel:${msg.channel}:${msg.channel_user_id}`,
        action: "channel.identity.rejected",
        payload: {
          channel: msg.channel,
          channel_user_id: msg.channel_user_id,
          thread_id: msg.channel_thread_id ?? null,
          received_at: msg.received_at,
        },
      });
      this.log?.warn("channel.identity_rejected", {
        channel: msg.channel,
        channel_user_id: msg.channel_user_id,
      });
      return { status: "rejected", reason: "unrecognized channel user" };
    }

    const text = inboundText(msg).trim();

    // Commands are handled here, never by the model (§4.3).
    if (text === "/new") {
      const created = await this.runner.createSession({
        owner_id: owner,
        title: `${msg.channel} ${new Date(msg.received_at).toISOString()}`,
      });
      this.sessions.put(msg.channel, msg.channel_user_id, msg.channel_thread_id, created.session_id, this.now());
      return { status: "replied", text: `new session started (${created.session_id})`, session_id: created.session_id };
    }
    if (text === "/fork") {
      const existing = this.sessions.get(msg.channel, msg.channel_user_id, msg.channel_thread_id);
      if (existing === null) {
        const created = await this.runner.createSession({ owner_id: owner });
        this.sessions.put(msg.channel, msg.channel_user_id, msg.channel_thread_id, created.session_id, this.now());
        return { status: "replied", text: `no session to fork — started a new one (${created.session_id})`, session_id: created.session_id };
      }
      const child = await this.runner.forkSession(existing.session_id);
      this.sessions.put(msg.channel, msg.channel_user_id, msg.channel_thread_id, child.session_id, this.now());
      return { status: "replied", text: `forked at the last event (${child.session_id})`, session_id: child.session_id };
    }

    // Attach (or create) the session for this conversation.
    let session_id = this.sessions.get(msg.channel, msg.channel_user_id, msg.channel_thread_id)?.session_id;
    if (session_id === undefined) {
      const created = await this.runner.createSession({ owner_id: owner });
      session_id = created.session_id;
      this.sessions.put(msg.channel, msg.channel_user_id, msg.channel_thread_id, session_id, this.now());
    }

    const content: ContentBlock[] = [{ type: "text", text }];
    const handle = this.runner.startTurn({
      session_id,
      owner_id: owner,
      content,
      // 2.1: the originating channel — the host registers the matching
      // approval presenter (Telegram inline keyboard / webhook body).
      channel: {
        id: msg.channel,
        ...(msg.channel_thread_id !== undefined ? { thread_id: msg.channel_thread_id } : {}),
      },
    });
    return { status: "started", handle, session_id };
  }
}
