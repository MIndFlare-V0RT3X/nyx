// SPDX-License-Identifier: AGPL-3.0-or-later
// The IPC client: connect to the unix socket, complete the token handshake,
// then issue id-correlated requests. One client per process per socket.

import * as net from "node:net";
import type {
  HandshakeResponse,
  IpcError,
  IpcResponse,
  RequestFrame,
  ResponseFrame,
} from "./protocol.js";
import { IPC_PROTOCOL_VERSION } from "./protocol.js";

export class IpcClientError extends Error {
  constructor(public readonly ipc: IpcError) {
    super(ipc.message);
    this.name = "IpcClientError";
  }
}

export interface IpcClientOptions {
  socketPath: string;
  token: string;
  role: "kernel-client" | "agent" | "tools";
  /** Request deadline (default 120s — tool calls can be long). */
  timeoutMs?: number;
}

export class IpcClient {
  readonly #options: IpcClientOptions;
  #socket: net.Socket | null = null;
  #buffer = "";
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (r: IpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  #serverVersion = "";

  constructor(options: IpcClientOptions) {
    this.#options = options;
  }

  /** The server's version string, available after connect(). */
  get serverVersion(): string {
    return this.#serverVersion;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  /**
   * Connect + handshake. Resolves only after the server accepts the token
   * and protocol version; rejects (IpcClientError) on refusal, or on socket
   * errors before the handshake.
   */
  async connect(): Promise<void> {
    if (this.#socket !== null) throw new Error("ipc client already connected");
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ path: this.#options.socketPath });
      s.once("error", (err: Error) => {
        s.destroy();
        reject(err);
      });
      s.once("connect", () => {
        s.removeListener("error", reject);
        resolve(s);
      });
    });
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#onLine(line);
        if (socket.destroyed) return;
        newline = this.#buffer.indexOf("\n");
      }
      if (this.#buffer.length > 8192) socket.destroy();
    });
    socket.once("error", () => socket.destroy());
    return new Promise<void>((resolve, reject) => {
      this.#handshakeResolve = resolve;
      this.#handshakeReject = reject;
      socket.once("close", () => {
        if (this.#handshakeReject !== null) {
          const rejectHandshake = this.#handshakeReject;
          this.#handshakeResolve = null;
          this.#handshakeReject = null;
          rejectHandshake(
            new IpcClientError({
              code: "ipc_closed",
              message: "ipc socket closed before the handshake completed",
            }),
          );
        }
        // Drain any in-flight requests: the socket is gone, they can never
        // resolve — reject them instead of hanging until their timeouts.
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        for (const entry of pending) {
          clearTimeout(entry.timer);
          entry.reject(
            new IpcClientError({
              code: "ipc_closed",
              message: "ipc socket closed before response",
            }),
          );
        }
      });
      socket.write(
        `${JSON.stringify({
          v: IPC_PROTOCOL_VERSION,
          auth: `Bearer ${this.#options.token}`,
          role: this.#options.role,
        })}\n`,
      );
    });
  }

  #handshakeResolve: (() => void) | null = null;
  #handshakeReject: ((e: Error) => void) | null = null;

  #onLine(line: string): void {
    if (line.trim().length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#socket?.destroy();
      return;
    }
    if (this.#handshakeResolve !== null) {
      const handshake = frame as HandshakeResponse;
      const resolve = this.#handshakeResolve;
      const reject = this.#handshakeReject;
      this.#handshakeResolve = null;
      this.#handshakeReject = null;
      if (!handshake.ok) {
        this.#socket?.destroy();
        reject?.(
          new IpcClientError({ code: handshake.error.code, message: handshake.error.message }),
        );
        return;
      }
      this.#serverVersion = handshake.server_version;
      resolve?.();
      return;
    }
    const response = frame as ResponseFrame;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return; // stale response after a timeout
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response.response);
  }

  /** Issue one request; resolves with the result, rejects with IpcClientError. */
  async request<T = unknown>(request: { type: string; [k: string]: unknown }): Promise<T> {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) {
      throw new IpcClientError({ code: "ipc_closed", message: "ipc socket is not connected" });
    }
    const id = this.#nextId++;
    const frame: RequestFrame = { id, request: request as RequestFrame["request"] };
    const timeoutMs = this.#options.timeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new IpcClientError({
            code: "ipc_timeout",
            message: `ipc request "${request.type}" timed out after ${timeoutMs}ms`,
          }),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (response) => {
          if (response.ok) {
            resolve(response.result as T);
          } else {
            reject(new IpcClientError(response.error));
          }
        },
        reject,
        timer,
      });
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket === null) return;
    this.#socket = null;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 2000).unref();
    });
  }
}
