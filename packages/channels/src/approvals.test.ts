// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.1.2/2.1.3 unit acceptance: the Telegram presenter shows an inline
// keyboard and edits it on resolution/withdrawal; the bridge gates callback
// queries by allowed_user_ids and routes to engine.resolve; the webhook
// presenter buffers presentations and hands the approval_required body (with
// resolve_url) to the pending HTTP request in either arrival order.

import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@nyx/policy";
import {
  TelegramApprovalBridge,
  TelegramApprovalPresenter,
  WebhookApprovalPresenter,
  approvalKeyboard,
  approvalRequestText,
} from "./approvals.js";
import type { TelegramClient, TelegramUpdate } from "./telegram.js";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approval_id: "appr_x1",
    session_id: "sess-1",
    turn_id: "turn-1",
    summary: "fs.write on /tmp/x [risk R2]",
    risk: "R2",
    action_digest: "digest-x1",
    expires_at: 1_790_000_000_000,
    ...overrides,
  };
}

interface Sent {
  method: string;
  args: Record<string, unknown>;
}

function mockClient(): { client: TelegramClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (chat_id, text, opts) => {
      sent.push({
        method: "sendMessage",
        args: { chat_id, text, ...(opts ?? {}) },
      });
      return { message_id: 700 + sent.length };
    },
    editMessageText: async (chat_id, message_id, text, opts) => {
      sent.push({
        method: "editMessageText",
        args: { chat_id, message_id, text, ...(opts ?? {}) },
      });
    },
    answerCallbackQuery: async (callback_query_id, text) => {
      sent.push({ method: "answerCallbackQuery", args: { callback_query_id, text } });
    },
  };
  return { client, sent };
}

describe("TelegramApprovalPresenter (2.1.2)", () => {
  it("present sends the summary with an [✅ Allow] [❌ Deny] inline keyboard", async () => {
    const { client, sent } = mockClient();
    const presenter = new TelegramApprovalPresenter({ client, chatId: "100" });
    await presenter.present(request());
    expect(sent).toHaveLength(1);
    const send = sent[0]!;
    expect(send.args.chat_id).toBe("100");
    expect(send.args.text).toContain("fs.write on /tmp/x [risk R2]");
    expect(send.args.text).toContain("R2");
    const markup = send.args.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard[0]!.map((b) => b.text)).toEqual(["✅ Allow", "❌ Deny"]);
    expect(markup.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
      "allow:appr_x1",
      "deny:appr_x1",
    ]);
  });

  it("withdraw on expiry sends the timeout message and cleans the keyboard", async () => {
    const { client, sent } = mockClient();
    const presenter = new TelegramApprovalPresenter({ client, chatId: "100" });
    await presenter.present(request());
    await presenter.withdraw("appr_x1", "expired");
    const methods = sent.map((s) => s.method);
    expect(methods).toContain("sendMessage");
    expect(methods).toContain("editMessageText");
    const timeoutMessage = sent.find((s) => s.args.text === "⏱ approval expired — action denied");
    expect(timeoutMessage).toBeDefined();
    const edit = sent.find((s) => s.method === "editMessageText");
    expect(edit?.args.text).toBe("approval withdrawn");
  });

  it("markResolved edits the keyboard message with the decision", async () => {
    const { client, sent } = mockClient();
    const presenter = new TelegramApprovalPresenter({ client, chatId: "100" });
    await presenter.present(request());
    await presenter.markResolved("appr_x1", "allow", "telegram:42");
    const edit = sent.find((s) => s.method === "editMessageText");
    expect(edit?.args.text).toBe("✅ approved by telegram:42");
  });

  it("helper shapes are pure", () => {
    const req = request();
    expect(approvalRequestText(req)).toContain("🔒 Approval required (R2)");
    expect(approvalKeyboard(req)).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: "allow:appr_x1" },
          { text: "❌ Deny", callback_data: "deny:appr_x1" },
        ],
      ],
    });
  });
});

describe("TelegramApprovalBridge (2.1.2)", () => {
  function query(overrides: Partial<NonNullable<TelegramUpdate["callback_query"]>> = {}) {
    return {
      id: "cq-1",
      data: "allow:appr_x1",
      from: { id: 42 },
      message: { message_id: 701, chat: { id: 100 } },
      ...overrides,
    };
  }

  it("an allowed user's button routes to engine.resolve and answers", async () => {
    const { client, sent } = mockClient();
    const resolutions: Array<{ id: string; decision: string; actor: string }> = [];
    const bridge = new TelegramApprovalBridge({
      client,
      allowedUserIds: [42],
      resolve: async (id, decision, actor) => {
        resolutions.push({ id, decision, actor });
      },
    });
    const presenter = bridge.presenterFor("100");
    await presenter.present(request());

    await bridge.handleCallbackQuery(query());
    expect(resolutions).toEqual([{ id: "appr_x1", decision: "allow", actor: "telegram:42" }]);
    expect(sent.some((s) => s.method === "answerCallbackQuery" && s.args.text === "approved ✅")).toBe(
      true,
    );
    // The keyboard message got its resolution edit.
    expect(sent.some((s) => s.method === "editMessageText" && s.args.text === "✅ approved by telegram:42")).toBe(
      true,
    );
  });

  it("an unrecognized user is rejected without resolving", async () => {
    const { client, sent } = mockClient();
    const resolutions: unknown[] = [];
    const bridge = new TelegramApprovalBridge({
      client,
      allowedUserIds: [42],
      resolve: async () => {
        resolutions.push("called");
      },
    });
    await bridge.handleCallbackQuery(query({ from: { id: 999 } }));
    expect(resolutions).toEqual([]);
    expect(sent.some((s) => s.args.text === "unrecognized user")).toBe(true);
  });

  it("malformed callback data and resolve failures are answered, never thrown", async () => {
    const { client, sent } = mockClient();
    const bridge = new TelegramApprovalBridge({
      client,
      allowedUserIds: [42],
      resolve: async () => {
        throw new Error("already resolved");
      },
    });
    await bridge.handleCallbackQuery(query({ data: "bogus" }));
    expect(sent.some((s) => s.args.text === "not an approval button")).toBe(true);

    await bridge.handleCallbackQuery(query({ data: "deny:appr_x1" }));
    expect(
      sent.some((s) => s.method === "answerCallbackQuery" && String(s.args.text).startsWith("failed:")),
    ).toBe(true);
  });
});

describe("WebhookApprovalPresenter (2.1.3)", () => {
  it("present-then-wait: the body (with resolve_url) is handed to the late waiter", async () => {
    const presenter = new WebhookApprovalPresenter();
    await presenter.present(request());
    const body = await presenter.waitForApproval("sess-1");
    expect(body).toEqual({
      status: "approval_required",
      approval_id: "appr_x1",
      session_id: "sess-1",
      turn_id: "turn-1",
      summary: "fs.write on /tmp/x [risk R2]",
      risk: "R2",
      expires_at: 1_790_000_000_000,
      resolve_url: "/v1/approvals/appr_x1/resolve",
    });
  });

  it("wait-then-present: a pending waiter resolves on present", async () => {
    const presenter = new WebhookApprovalPresenter();
    const waiting = presenter.waitForApproval("sess-2");
    await presenter.present(request({ approval_id: "appr_x2", session_id: "sess-2" }));
    const body = await waiting;
    expect(body.approval_id).toBe("appr_x2");
    expect(body.resolve_url).toBe("/v1/approvals/appr_x2/resolve");
  });

  it("withdraw clears a buffered presentation (no stale approval_required)", async () => {
    const presenter = new WebhookApprovalPresenter();
    await presenter.present(request({ session_id: "sess-3" }));
    await presenter.withdraw("appr_x1", "expired");
    // A late waiter must not receive the withdrawn request: it stays pending
    // (the adapter's reply-time race answers instead).
    const waiting = presenter.waitForApproval("sess-3");
    const raced = await Promise.race([
      waiting.then(() => "resolved"),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 25)),
    ]);
    expect(raced).toBe("pending");
  });
});
