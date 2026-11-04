// SPDX-License-Identifier: AGPL-3.0-or-later
// Channel approval presenters (2.1). The approval engine (in @nyx/policy)
// routes request() through the presenter registered for the session; the
// presenter is pure surface: it SHOWS the request and relays the operator's
// decision back through engine.resolve(). Decision authority never moves into
// an adapter — identity gates and R4 owner-only checks stay in the engine and
// the resolve route.
//
// - TelegramApprovalPresenter: an inline keyboard [✅ Allow] [❌ Deny]; the
//   button press arrives as a callback_query, routed by TelegramApprovalBridge
//   (allowed_user_ids gate → engine.resolve → answerCallbackQuery).
//   A TEXT message while an approval is pending is NOT a decision — text
//   always routes through the manager as a normal user message; only the
//   explicit button click resolves.
// - WebhookApprovalPresenter: no push channel — present() makes the request
//   available to the pending HTTP response (approval_required body with a
//   resolve_url); the external client resolves via POST /v1/approvals/:id/resolve.

import type { Logger } from "@nyx/protocol";
import type { ApprovalPresenter, ApprovalRequest } from "@nyx/policy";
import type { TelegramClient, TelegramUpdate } from "./telegram.js";

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export interface TelegramApprovalPresenterOptions {
  client: TelegramClient;
  chatId: string;
  logger?: Logger;
}

/** The body of an approval message shown on Telegram. */
export function approvalRequestText(req: ApprovalRequest): string {
  return [
    `🔒 Approval required (${req.risk})`,
    req.summary,
    `Expires: ${new Date(req.expires_at).toISOString()}`,
  ].join("\n");
}

/** The inline keyboard for an approval request. */
export function approvalKeyboard(req: ApprovalRequest): unknown {
  return {
    inline_keyboard: [
      [
        { text: "✅ Allow", callback_data: `allow:${req.approval_id}` },
        { text: "❌ Deny", callback_data: `deny:${req.approval_id}` },
      ],
    ],
  };
}

export class TelegramApprovalPresenter implements ApprovalPresenter {
  readonly id: string;
  private readonly opts: TelegramApprovalPresenterOptions;
  /** approval_id → the keyboard message id (for edits on resolution). */
  private readonly messageIds = new Map<string, number>();

  constructor(opts: TelegramApprovalPresenterOptions) {
    this.opts = opts;
    this.id = `telegram-approval:${opts.chatId}`;
  }

  async present(req: ApprovalRequest): Promise<void> {
    const sent = await this.opts.client.sendMessage(
      this.opts.chatId,
      approvalRequestText(req).slice(0, 4096),
      { reply_markup: approvalKeyboard(req) },
    );
    this.messageIds.set(req.approval_id, sent.message_id);
  }

  async withdraw(approval_id: string, reason: string): Promise<void> {
    const messageId = this.messageIds.get(approval_id);
    this.messageIds.delete(approval_id);
    if (reason === "expired") {
      // The brief's timeout surface: a fresh message plus a keyboard cleanup.
      await this.opts.client
        .sendMessage(this.opts.chatId, "⏱ approval expired — action denied")
        .catch(() => undefined);
    }
    if (messageId !== undefined) {
      await this.opts.client
        .editMessageText(this.opts.chatId, messageId, "approval withdrawn")
        .catch(() => undefined);
    }
  }

  /** Edit the keyboard message to record the operator's decision. */
  async markResolved(approval_id: string, decision: "allow" | "deny", decidedBy: string): Promise<void> {
    const messageId = this.messageIds.get(approval_id);
    this.messageIds.delete(approval_id);
    if (messageId === undefined) return;
    await this.opts.client
      .editMessageText(
        this.opts.chatId,
        messageId,
        decision === "allow" ? `✅ approved by ${decidedBy}` : `❌ denied by ${decidedBy}`,
      )
      .catch(() => undefined);
  }
}

export interface TelegramApprovalBridgeOptions {
  client: TelegramClient;
  /** Identity gate: only these Telegram user ids may resolve approvals. */
  allowedUserIds: number[];
  /** Route to the approval engine's resolve(). */
  resolve(approval_id: string, decision: "allow" | "deny", actor: string): Promise<unknown>;
  logger?: Logger;
}

/**
 * Routes Telegram callback queries to the approval engine. One per server;
 * owns the per-chat presenters so a button press finds the message to edit.
 */
export class TelegramApprovalBridge {
  private readonly opts: TelegramApprovalBridgeOptions;
  private readonly presenters = new Map<string, TelegramApprovalPresenter>();

  constructor(opts: TelegramApprovalBridgeOptions) {
    this.opts = opts;
  }

  /** The presenter for a chat (cached; the host registers it per session). */
  presenterFor(chatId: string): TelegramApprovalPresenter {
    let presenter = this.presenters.get(chatId);
    if (presenter === undefined) {
      presenter = new TelegramApprovalPresenter({
        client: this.opts.client,
        chatId,
        ...(this.opts.logger !== undefined ? { logger: this.opts.logger } : {}),
      });
      this.presenters.set(chatId, presenter);
    }
    return presenter;
  }

  /** Handle one callback_query update: gate → resolve → answer. */
  async handleCallbackQuery(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const data = typeof query.data === "string" ? query.data : "";
    const match = /^(allow|deny):(.+)$/.exec(data);
    const answer = (text: string): Promise<void> =>
      this.opts.client.answerCallbackQuery(query.id, text).catch(() => undefined);

    if (match === null) {
      await answer("not an approval button");
      return;
    }
    const fromId = query.from?.id;
    if (fromId === undefined || !this.opts.allowedUserIds.includes(fromId)) {
      this.opts.logger?.warn("channel.telegram.callback_rejected", { from: fromId });
      await answer("unrecognized user");
      return;
    }
    const decision = match[1] as "allow" | "deny";
    const approvalId = match[2]!;
    const actor = `telegram:${fromId}`;
    try {
      await this.opts.resolve(approvalId, decision, actor);
      const chatId = query.message !== undefined ? String(query.message.chat.id) : undefined;
      const presenter = chatId !== undefined ? this.presenters.get(chatId) : undefined;
      if (presenter !== undefined) {
        await presenter.markResolved(approvalId, decision, actor);
      }
      await answer(decision === "allow" ? "approved ✅" : "denied ❌");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn("channel.telegram.resolve_failed", { approval_id: approvalId, error: message });
      await answer(`failed: ${message.slice(0, 180)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookApprovalBody {
  status: "approval_required";
  approval_id: string;
  session_id: string;
  turn_id: string;
  summary: string;
  risk: string;
  expires_at: number;
  resolve_url: string;
}

/**
 * The webhook channel has no push channel: present() makes the request
 * available to the pending HTTP response (which then answers
 * approval_required with a resolve_url), and resolves immediately — the turn
 * keeps waiting on engine.resolve() with the channel TTL. Presentations that
 * arrive before the adapter asks (fast turns) are buffered per session.
 */
export class WebhookApprovalPresenter implements ApprovalPresenter {
  readonly id = "webhook-approval";
  private readonly waiters = new Map<string, (body: WebhookApprovalBody) => void>();
  private readonly buffered = new Map<string, ApprovalRequest>();
  private readonly sessionOf = new Map<string, string>();

  /** The webhook adapter races this against turn completion / reply timeout. */
  waitForApproval(session_id: string): Promise<WebhookApprovalBody> {
    const buffered = this.buffered.get(session_id);
    if (buffered !== undefined) {
      this.buffered.delete(session_id);
      return Promise.resolve(this.bodyFor(buffered));
    }
    return new Promise<WebhookApprovalBody>((resolve) => {
      this.waiters.set(session_id, resolve);
    });
  }

  async present(req: ApprovalRequest): Promise<void> {
    this.sessionOf.set(req.approval_id, req.session_id);
    const waiter = this.waiters.get(req.session_id);
    if (waiter !== undefined) {
      this.waiters.delete(req.session_id);
      waiter(this.bodyFor(req));
      return;
    }
    this.buffered.set(req.session_id, req);
  }

  async withdraw(approval_id: string, _reason: string): Promise<void> {
    void _reason;
    const session = this.sessionOf.get(approval_id);
    this.sessionOf.delete(approval_id);
    if (session !== undefined) this.buffered.delete(session);
    // No push channel: the resolve route reports expiry; a still-pending HTTP
    // request falls through to its normal timeout response.
  }

  private bodyFor(req: ApprovalRequest): WebhookApprovalBody {
    return {
      status: "approval_required",
      approval_id: req.approval_id,
      session_id: req.session_id,
      turn_id: req.turn_id,
      summary: req.summary,
      risk: req.risk,
      expires_at: req.expires_at,
      resolve_url: `/v1/approvals/${req.approval_id}/resolve`,
    };
  }
}
