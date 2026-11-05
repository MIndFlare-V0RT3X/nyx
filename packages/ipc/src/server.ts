// SPDX-License-Identifier: AGPL-3.0-or-later
// The IPC server: a unix-socket JSON-RPC endpoint with a mandatory
// token-authenticated handshake. One server per socket file; the kernel
// process hosts one, the tools process another.
//
// Security posture: a connection that sends anything before a valid
// handshake, or presents a wrong token or protocol version, is destroyed
// with at most a denial frame — no dispatch, no reflection, no info.

import * as net from "node:net";
import { promises as fsp } from "node:fs";
import type {
  HandshakeFrame,
  HandshakeResponse,
  IpcError,
  RequestFrame,
  ResponseFrame,
} from "./protocol.js";
import { IPC_PROTOCOL_VERSION } from "./protocol.js";

export type IpcRequestHandler = (
  request: { type: string; [k: string]: unknown },
  connection: { role: HandshakeFrame["role"] },
) => Promise<unknown>;

export interface IpcServerOptions {
  /** The socket file to bind. Removed first if a stale file exists. */
  socketPath: string;
  /** The token every client must present in the handshake. A string is
   *  fixed; a function is evaluated at EVERY handshake, which is how the
   *  kernel rotates tokens (a rotated-out token dies instantly). */
  token: string | (() => string);
  /** Server version string reported in the handshake response. */
  serverVersion: string;
  /** Dispatch — resolves to the result, or throws (mapped to an error). */
  handler: IpcRequestHandler;
  /** Called after the listening socket is bound (awaited before resolve). */
  onListening?: () => Promise<void> | void;
  /** Called when a connection completes the handshake (role as handshaken). */
  onHandshake?: (role: HandshakeFrame["role"]) => void;
  /** Called when an authenticated connection closes (role as handshaken). */
  onDisconnect?: (role: HandshakeFrame["role"]) => void;
}

interface Connection {
  socket: net.Socket;
  role: HandshakeFrame["role"];
  authenticated: boolean;
  buffer: string;
  inflight: number;
}

/** Pre-handshake frame cap: the handshake is tiny; anything bigger is hostile. */
const MAX_HANDSHAKE_BYTES = 8192;
/**
 * Post-handshake frame cap (R1-9, fan-out): legitimate frames reach
 * megabytes (tool outputs up to 64 KiB carried twice, long-session
 * projections). 16 MiB bounds memory while leaving 100x headroom.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** A connection that never completes the handshake is reaped (R1-10). */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Local-socket connection cap (R1-10): the split has ~3 clients. */
const MAX_CONNECTIONS = 64;
/** Per-connection concurrent dispatch cap (R1-10). */
const MAX_INFLIGHT_PER_CONNECTION = 32;

export class IpcError_ extends Error {
  constructor(public readonly ipc: IpcError) {
    super(ipc.message);
    this.name = "IpcError";
  }
}

export class IpcServer {
  readonly #options: IpcServerOptions;
  readonly #connections = new Set<net.Socket>();
  #server: net.Server | null = null;
  #startedAt = Date.now();

  constructor(options: IpcServerOptions) {
    this.#options = options;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get uptimeMs(): number {
    return Date.now() - this.#startedAt;
  }

  /** Bind the socket and start accepting. Resolves once listening. */
  async start(): Promise<void> {
    if (this.#server !== null) throw new Error("ipc server already started");
    await fsp.mkdir(this.#options.socketPath.split("/").slice(0, -1).join("/"), {
      recursive: true,
    });
    try {
      await fsp.unlink(this.#options.socketPath);
    } catch {
      /* no stale socket */
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.#onConnection(socket));
      server.once("error", reject);
      server.listen(this.#options.socketPath, () => {
        this.#server = server;
        resolve();
      });
    });
    await this.#options.onListening?.();
  }

  async stop(): Promise<void> {
    for (const socket of [...this.#connections]) socket.destroy();
    await new Promise<void>((resolve) => {
      if (this.#server === null) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    this.#server = null;
    try {
      await fsp.unlink(this.#options.socketPath);
    } catch {
      /* already gone */
    }
  }

  #onConnection(socket: net.Socket): void {
    // R1-10: the split has a handful of clients; more is a flood.
    if (this.#connections.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.#connections.add(socket);
    const connection: Connection = {
      socket,
      role: "kernel-client",
      authenticated: false,
      buffer: "",
      inflight: 0,
    };
    socket.setEncoding("utf8");
    // R1-10: a handshake that never arrives is a dead connection — reap it.
    const handshakeTimer = setTimeout(() => {
      if (!connection.authenticated) socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(handshakeTimer));
    socket.on("data", (chunk: string) => {
      connection.buffer += chunk;
      let newline = connection.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        this.#onLine(connection, line);
        if (socket.destroyed) return;
        newline = connection.buffer.indexOf("\n");
      }
      // The frame cap depends on the connection's state: the handshake is
      // tiny (8 KiB); a post-auth request frame may be megabytes (R1-9).
      const cap = connection.authenticated ? MAX_FRAME_BYTES : MAX_HANDSHAKE_BYTES;
      if (connection.buffer.length > cap) socket.destroy();
    });
    socket.once("close", () => {
      this.#connections.delete(socket);
      if (connection.authenticated) {
        this.#options.onDisconnect?.(connection.role);
      }
    });
    socket.once("error", () => {
      this.#connections.delete(socket);
      socket.destroy();
    });
  }

  #onLine(connection: Connection, line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      connection.socket.destroy();
      return;
    }
    if (!connection.authenticated) {
      this.#handleHandshake(connection, frame);
      return;
    }
    this.#handleRequest(connection, frame as RequestFrame).catch(() => {
      connection.socket.destroy();
    });
  }

  #handleHandshake(connection: Connection, frame: unknown): void {
    const candidate = frame as Partial<HandshakeFrame> | null;
    const valid =
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.auth === "string" &&
      typeof candidate.v === "number" &&
      typeof candidate.role === "string";
    if (!valid) {
      // Not even a handshake shape: destroy, say nothing.
      connection.socket.destroy();
      return;
    }
    if (candidate.v !== IPC_PROTOCOL_VERSION) {
      this.#deny(connection, {
        code: "version",
        message: `protocol version mismatch: client ${String(candidate.v)}, server ${IPC_PROTOCOL_VERSION}; the split runtime requires matching builds`,
      });
      return;
    }
    if (candidate.auth !== `Bearer ${this.#currentToken()}`) {
      this.#deny(connection, {
        code: "auth",
        message: "invalid ipc token",
      });
      return;
    }
    // R1-1 (fan-out): the role namespace is fixed — an arbitrary role
    // string is protocol garbage, not a client.
    const role = candidate.role as HandshakeFrame["role"];
    if (role !== "kernel-client" && role !== "agent" && role !== "tools") {
      this.#deny(connection, {
        code: "auth",
        message: `unknown role "${String(candidate.role)}"`,
      });
      return;
    }
    connection.role = role;
    connection.authenticated = true;
    this.#options.onHandshake?.(connection.role);
    const ok: HandshakeResponse = { ok: true, server_version: this.#options.serverVersion };
    connection.socket.write(`${JSON.stringify(ok)}\n`);
  }

  #currentToken(): string {
    const token = this.#options.token;
    return typeof token === "function" ? token() : token;
  }

  #deny(connection: Connection, error: { code: "auth" | "version"; message: string }): void {
    const denied: HandshakeResponse = { ok: false, error };
    try {
      connection.socket.write(`${JSON.stringify(denied)}\n`);
    } catch {
      /* socket already gone */
    }
    connection.socket.end();
  }

  async #handleRequest(connection: Connection, frame: RequestFrame): Promise<void> {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof (frame as RequestFrame).id !== "number" ||
      typeof (frame as RequestFrame).request !== "object" ||
      (frame as RequestFrame).request === null
    ) {
      connection.socket.destroy();
      return;
    }
    // R1-10: bound concurrent dispatch per connection — a flood cannot
    // spawn unbounded handler work.
    if (connection.inflight >= MAX_INFLIGHT_PER_CONNECTION) {
      connection.socket.destroy();
      return;
    }
    connection.inflight += 1;
    let response: string;
    try {
      const result = await this.#options.handler(
        frame.request as { type: string; [k: string]: unknown },
        { role: connection.role },
      );
      response = JSON.stringify({
        id: frame.id,
        response: { ok: true, result },
      } satisfies ResponseFrame);
    } catch (err) {
      if (err instanceof IpcError_) {
        response = JSON.stringify({
          id: frame.id,
          response: { ok: false, error: err.ipc },
        } satisfies ResponseFrame);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        response = JSON.stringify({
          id: frame.id,
          response: { ok: false, error: { code: "internal", message } },
        } satisfies ResponseFrame);
      }
    }
    connection.inflight -= 1;
    if (!connection.socket.destroyed) connection.socket.write(`${response}\n`);
  }
}
