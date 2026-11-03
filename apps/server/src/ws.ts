// SPDX-License-Identifier: AGPL-3.0-or-later
// The WebSocket multiplexing channel (`/v1/ws`). One connection may subscribe
// to many sessions; every stored event from store.stream(session_id,
// from_seq) is forwarded while subscribed, plus `approvals` pushes when a
// pending approval appears. Auth is the ?token= query parameter — browsers
// cannot set WS headers, and the default bind is loopback (documented).
//
// Cleanup note: store.stream is pull-driven. When a subscription stops, its
// pump exits but the store generator finishes only at its next suspension
// point — it stops for good when the next event for that session arrives or
// when the store closes (server shutdown), which is why every server test
// closes its stores.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { toSerializedError, type ApprovalRecord, type Logger, type SessionStore } from "@nyx/protocol";
import { authenticate, type ResolvedAuth } from "./auth.js";

export const WS_PATH = "/v1/ws";

const ClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("subscribe"),
      session_id: z.string().min(1),
      from_seq: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal("unsubscribe"), session_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);

export interface WebSocketDeps {
  auth: ResolvedAuth;
  store: SessionStore;
  /** Current pending approvals for a session (pushed to new subscribers). */
  pendingApprovals(session_id: string): Promise<ApprovalRecord[]>;
  logger: Logger;
}

export interface WebSocketHub {
  /** Fan an approvals frame out to every connection subscribed to the session. */
  broadcastApprovals(session_id: string, records: ApprovalRecord[]): void;
  close(): Promise<void>;
}

interface Subscription {
  stop(): void;
}

interface ConnectionState {
  ws: WebSocket;
  subscriptions: Map<string, Subscription>;
}

type RawEvent = { type: "event"; event: unknown } | { type: "approvals"; session_id: string; records: ApprovalRecord[] } | { type: "pong" } | { type: "error"; message: string };

function send(conn: ConnectionState, frame: RawEvent): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
}

/**
 * Attach the WS endpoint to a running @hono/node-server HTTP server: a
 * `noServer` ws.WebSocketServer plus an "upgrade" hook that verifies the
 * path and the ?token= auth BEFORE accepting the socket.
 */
export function injectWebSocketServer(server: Server, deps: WebSocketDeps): WebSocketHub {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<ConnectionState>();
  let closed = false;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed) {
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const actor = authenticate(url.searchParams.get("token") ?? "", deps.auth);
    if (actor === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws);
    });
  });

  function handleConnection(ws: WebSocket): void {
    const conn: ConnectionState = { ws, subscriptions: new Map() };
    connections.add(conn);
    const log = deps.logger.child({ component: "ws" });

    ws.on("message", (data) => {
      if (closed) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send(conn, { type: "error", message: "frames must be JSON text messages" });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        send(conn, {
          type: "error",
          message: `invalid frame: ${parsed.error.issues.map((i) => `${i.path.join(".") || "frame"} ${i.message}`).join("; ")}`,
        });
        return;
      }
      const msg = parsed.data;
      if (msg.type === "ping") {
        send(conn, { type: "pong" });
        return;
      }
      if (msg.type === "unsubscribe") {
        conn.subscriptions.get(msg.session_id)?.stop();
        return;
      }
      // subscribe: the session must exist; then replay + live-tail from from_seq.
      void deps.store
        .meta(msg.session_id)
        .then((meta) => {
          if (meta === null) {
            send(conn, { type: "error", message: `unknown session ${msg.session_id}` });
            return;
          }
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          // A re-subscribe replaces the previous pump for that session.
          conn.subscriptions.get(msg.session_id)?.stop();
          void pump(conn, msg.session_id, msg.from_seq ?? 0);
          // Push the current pending approvals so a late subscriber can
          // render an approval prompt immediately.
          void deps
            .pendingApprovals(msg.session_id)
            .then(
              (records) => {
                if (records.length > 0) {
                  send(conn, { type: "approvals", session_id: msg.session_id, records });
                }
              },
              (err) => log.warn("ws.pending_approvals_failed", { error: toSerializedError(err) }),
            );
        })
        .catch((err) => log.warn("ws.subscribe_failed", { error: toSerializedError(err) }));
    });

    ws.on("close", () => {
      for (const sub of conn.subscriptions.values()) sub.stop();
      conn.subscriptions.clear();
      connections.delete(conn);
    });
    ws.on("error", () => {
      // the close handler above performs the cleanup
    });
  }

  async function pump(conn: ConnectionState, session_id: string, fromSeq: number): Promise<void> {
    const iterator = deps.store.stream(session_id, fromSeq)[Symbol.asyncIterator]();
    let stopped = false;
    let resolveStop: () => void = () => undefined;
    const stopPromise = new Promise<"stop">((resolve) => {
      resolveStop = resolve;
    });
    const subscription: Subscription = {
      stop: () => {
        stopped = true;
        resolveStop();
      },
    };
    conn.subscriptions.set(session_id, subscription);
    let pending = iterator.next();
    // Abandoned-next guard: if this pump stops while a poll is outstanding,
    // a later rejection (store close) must not surface as unhandled.
    pending.catch(() => undefined);
    try {
      while (!stopped && conn.ws.readyState === WebSocket.OPEN) {
        const winner = await Promise.race([
          pending.then((result) => ({ kind: "next" as const, result })),
          stopPromise.then(() => ({ kind: "stop" as const })),
        ]);
        if (winner.kind === "stop") return;
        if (winner.result.done) return;
        send(conn, { type: "event", event: winner.result.value });
        pending = iterator.next();
        pending.catch(() => undefined);
      }
    } catch {
      // the store closed (server shutdown) mid-stream: the pump simply ends
    } finally {
      if (conn.subscriptions.get(session_id) === subscription) {
        conn.subscriptions.delete(session_id);
      }
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }

  return {
    broadcastApprovals(session_id, records) {
      const frame: RawEvent = { type: "approvals", session_id, records };
      for (const conn of connections) {
        if (conn.subscriptions.has(session_id)) send(conn, frame);
      }
    },
    async close() {
      closed = true;
      for (const conn of connections) {
        for (const sub of conn.subscriptions.values()) sub.stop();
        conn.subscriptions.clear();
        conn.ws.terminate();
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
