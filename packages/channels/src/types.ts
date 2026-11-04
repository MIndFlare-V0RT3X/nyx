// SPDX-License-Identifier: AGPL-3.0-or-later
// The channel surface contract: adapters translate between a platform and
// NYX's InboundMessage/OutboundMessage shapes. The manager (not the adapter)
// owns identity checks, session mapping, and command handling — adapters are
// transport, the manager is policy.

import type { ContentBlock, Logger, SessionEvent } from "@nyx/protocol";

export interface InboundMessage {
  channel: string;
  /** Platform-specific stable user id (webhook: the configured owner id; Telegram: the numeric user id). */
  channel_user_id: string;
  /** For threaded platforms; absent for flat ones. */
  channel_thread_id?: string;
  content: ContentBlock[];
  received_at: number;
  /** The platform payload, stored for audit only — never interpreted. */
  raw: unknown;
}

export interface OutboundMessage {
  content: ContentBlock[];
  channel_thread_id?: string;
  reply_to?: string;
}

export type ChannelCapability = "text" | "image" | "file" | "thread" | "reactions";

export interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapability[];
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<{ message_id: string }>;
  onMessage(handler: (msg: InboundMessage) => void): () => void;
  onError(handler: (err: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// What the manager needs from the host runtime (implemented by the server).
// ---------------------------------------------------------------------------

/** A running channel turn: events stream, completion carries the reply text. */
export interface ChannelTurnHandle {
  turn_id: string;
  /** Resolves when the turn completes or fails; text is the rendered reply. */
  completion: Promise<{ ok: boolean; text: string }>;
  /** Live event subscription (deltas for streaming renderers). */
  onEvent(cb: (event: SessionEvent) => void): () => void;
}

/** The slice of the runtime the channel manager drives. */
export interface ChannelTurnRunner {
  createSession(input: {
    owner_id: string;
    persona_id?: string;
    title?: string;
  }): Promise<{ session_id: string; persona_id: string }>;
  /** Fork a session at its last event; the child becomes the active mapping target. */
  forkSession(session_id: string): Promise<{ session_id: string }>;
  startTurn(input: {
    session_id: string;
    owner_id: string;
    content: ContentBlock[];
    /** 2.1: the originating channel, so the host can register the right approval presenter. */
    channel?: {
      id: string;
      /** The channel's conversation id (Telegram chat id; webhook thread id). */
      thread_id?: string;
    };
  }): ChannelTurnHandle;
}

// ---------------------------------------------------------------------------
// Config shapes (mirrored by the zod schema in @nyx/config).
// ---------------------------------------------------------------------------

export interface WebhookChannelConfig {
  enabled: boolean;
  path: string;
  bind: string;
  port: number;
  /** channel_user_id values that map to owner sessions; anything else is rejected. */
  allowed_owners: string[];
  /** How long a POST waits for the turn before answering with ids only. */
  reply_timeout_ms: number;
  /** 2.1: approval TTL for webhook-originated turns (default 5 min). */
  approval_ttl_ms?: number;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  bot_token_env: string;
  allowed_user_ids: number[];
  poll_timeout_s: number;
  edit_interval_ms: number;
  /** 2.1: approval TTL for telegram-originated turns (default 5 min). */
  approval_ttl_ms?: number;
}

export interface ChannelsRuntimeConfig {
  webhook?: WebhookChannelConfig;
  telegram?: TelegramChannelConfig;
}

export type { Logger };
