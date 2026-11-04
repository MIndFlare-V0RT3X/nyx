// SPDX-License-Identifier: AGPL-3.0-or-later
// The webhook channel: a loopback-bound HTTP listener that turns POSTs into
// turns. It is the universal fallback ingress — any script or service can
// drive NYX with curl. Non-streaming by design (§4.4): the adapter waits for
// turn completion (up to reply_timeout_ms) and sends the reply exactly once,
// in the HTTP response.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ContentBlock, Logger } from "@nyx/protocol";
import type {
  ChannelAdapter,
  ChannelCapability,
  InboundMessage,
  OutboundMessage,
  WebhookChannelConfig,
} from "./types.js";
import type { ChannelManager } from "./manager.js";
import type { WebhookApprovalPresenter } from "./approvals.js";

export interface WebhookAdapterOptions {
  config: WebhookChannelConfig;
  manager: ChannelManager;
  logger?: Logger;
  now?: () => number;
  /** 2.1: approvals surface as approval_required bodies with a resolve_url. */
  approvalPresenter?: WebhookApprovalPresenter;
}

interface WebhookPayload {
  channel_user_id?: unknown;
  text?: unknown;
  thread_id?: unknown;
}

export class WebhookChannel implements ChannelAdapter {
  readonly id = "webhook";
  readonly capabilities: ChannelCapability[] = ["text"];
  private readonly opts: WebhookAdapterOptions;
  private server: http.Server | undefined;
  private messageHandlers: Array<(msg: InboundMessage) => void> = [];
  private errorHandlers: Array<(err: unknown) => void> = [];

  constructor(opts: WebhookAdapterOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(this.opts.config.port, this.opts.config.bind, resolve);
    });
    const addr = server.address() as AddressInfo;
    this.opts.logger?.info("channel.webhook.started", {
      bind: this.opts.config.bind,
      port: addr.port,
      path: this.opts.config.path,
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** Non-streaming channel: send() delivers the final reply to the pending POST. */
  async send(msg: OutboundMessage): Promise<{ message_id: string }> {
    void msg; // replies travel through the HTTP response, not a platform API
    return { message_id: `webhook:${Date.now()}` };
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

  private emitError(err: unknown): void {
    for (const h of this.errorHandlers) h(err);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.opts.config;
    if (req.method !== "POST" || req.url !== cfg.path) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    const body = await new Promise<Buffer>((resolve, reject) => {
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    }).catch((err: unknown) => {
      this.emitError(err);
      return Buffer.alloc(0);
    });

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body.toString("utf8")) as WebhookPayload;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "body must be JSON" }));
      return;
    }
    if (typeof payload.channel_user_id !== "string" || payload.channel_user_id.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "channel_user_id (string) is required" }));
      return;
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    const threadId = typeof payload.thread_id === "string" ? payload.thread_id : undefined;

    const msg: InboundMessage = {
      channel: "webhook",
      channel_user_id: payload.channel_user_id,
      ...(threadId !== undefined ? { channel_thread_id: threadId } : {}),
      content: [{ type: "text", text }],
      received_at: (this.opts.now ?? Date.now)(),
      raw: payload,
    };
    for (const h of this.messageHandlers) h(msg);

    const result = await this.opts.manager.handleInbound(msg);
    if (result.status === "rejected") {
      // Unknown user: 403, no content, no platform reply.
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unrecognized channel user" }));
      return;
    }
    if (result.status === "replied") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ session_id: result.session_id ?? null, reply: result.text }),
      );
      return;
    }

    // A turn is running: wait up to reply_timeout_ms for the reply, but if
    // the turn needs an approval, answer with the approval_required body
    // (2.1) — the client resolves via the main API's resolve_url.
    const approvalBody =
      this.opts.approvalPresenter !== undefined
        ? this.opts.approvalPresenter.waitForApproval(result.session_id)
        : new Promise<null>(() => undefined); // never resolves when no presenter
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), cfg.reply_timeout_ms).unref?.();
    });
    const settled = await Promise.race([result.handle.completion, timeout, approvalBody]);
    if (settled === "timeout") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          session_id: result.session_id,
          turn_id: result.handle.turn_id,
          note: "turn still running; reply not included",
        }),
      );
      return;
    }
    if (settled !== null && typeof settled === "object" && "resolve_url" in settled) {
      // approval_required body (2.1): the turn keeps running; the client
      // resolves via the resolve_url on the main API.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(settled));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        session_id: result.session_id,
        turn_id: result.handle.turn_id,
        reply: settled === null ? "" : settled.text,
      }),
    );
  }
}

/** Helper for tests and callers: build the text content block array. */
export function textContent(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}
