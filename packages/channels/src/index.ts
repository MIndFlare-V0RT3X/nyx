// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/channels — platform adapters (webhook, Telegram) plus the manager
// that owns identity, session mapping, and command handling for every
// inbound channel message.

export type {
  ChannelAdapter,
  ChannelCapability,
  ChannelTurnHandle,
  ChannelTurnRunner,
  ChannelsRuntimeConfig,
  InboundMessage,
  OutboundMessage,
  TelegramChannelConfig,
  WebhookChannelConfig,
} from "./types.js";
export { ChannelManager, inboundText, replyTextFromEvents } from "./manager.js";
export type { ChannelManagerDeps, HandleResult } from "./manager.js";
export { ChannelSessionStore, channelKey, ensureChannelSessionsTable } from "./sessions-store.js";
export { WebhookChannel, textContent } from "./webhook.js";
export { createHttpTelegramClient, TelegramChannel } from "./telegram.js";
export type { TelegramAdapterOptions, TelegramClient, TelegramUpdate } from "./telegram.js";

// ── 2.1: channel approval presenters ──
export {
  TelegramApprovalBridge,
  TelegramApprovalPresenter,
  WebhookApprovalPresenter,
  approvalKeyboard,
  approvalRequestText,
} from "./approvals.js";
export type {
  TelegramApprovalBridgeOptions,
  TelegramApprovalPresenterOptions,
  WebhookApprovalBody,
} from "./approvals.js";
