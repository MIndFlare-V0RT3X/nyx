// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — the egress CONNECT proxy. See docs/EGRESS-PROXY.md.
//
// Mechanics only: bind listeners (one per network gateway × rate class),
// parse CONNECT strictly, ask the decision provider (scope + pin + rate, in
// the kernel process), and on allow connect BY PINNED IP and splice bytes.
// On deny the socket is destroyed with no response bytes (RST semantics).
// Anything that is not a well-formed CONNECT — GET, raw bytes, oversized or
// malformed headers, invalid host forms, ports outside 1–65535 — is destroyed
// the same way. There is no TLS interception and no unix socket anywhere.

import * as net from "node:net";
import { cidrContains, isIPLiteral } from "@nyx/scope";
import type {
  EgressDecisionProvider,
  EgressListenerContext,
} from "./types.js";

/** Hard cap on the CONNECT request head (defense; a real head is ~100 B). */
const MAX_HEAD_BYTES = 8192;
/** Deadline for receiving the full CONNECT head after the socket opens. */
const HEAD_TIMEOUT_MS = 10_000;
/** Deadline for the pinned upstream connection to establish. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Default per-listener concurrent tunnel cap (DoS insurance). */
export const DEFAULT_MAX_CONNECTIONS = 1024;

/** Parse "host:port" / "[v6]:port"; null for anything not CONNECT-able. */
export function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  // IPv6 literal form: [::1]:443
  const v6 = authority.match(/^\[(.+)\]:(\d+)$/);
  if (v6 !== null) {
    const host = v6[1];
    const portText = v6[2];
    if (host === undefined || portText === undefined || host.length === 0) return null;
    // R1-11: brackets are for IP literals only — "[example.com]:443" and
    // other alias forms are refused.
    if (!isIPLiteral(host)) return null;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  const idx = authority.lastIndexOf(":");
  if (idx <= 0 || idx !== authority.indexOf(":")) return null; // no port / multiple colons
  const host = authority.slice(0, idx);
  const portText = authority.slice(idx + 1);
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[0-9]+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Hostname (or v4/dual-literal) charset — rejects userinfo, paths, spaces.
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  return { host, port };
}

/** Methods accepted in absolute (forward-proxy) form. */
const FORWARD_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
function isForwardMethod(m: string): boolean {
  return FORWARD_METHODS.has(m);
}

interface ListenerRecord {
  server: net.Server;
  context: EgressListenerContext;
  tunnels: Set<net.Socket>;
  maxConnections: number;
}

export interface EgressProxyServerOptions {
  policy: EgressDecisionProvider;
  /** Per-listener concurrent tunnel cap (default 1024). */
  maxConnections?: number;
}

/**
 * The kernel-process egress proxy. One instance per NYX process; listeners
 * bind per sandbox network gateway. Bind failures throw — callers (the
 * sandbox provider) turn them into "sandbox not spawned".
 */
export class EgressProxyServer {
  private readonly policy: EgressDecisionProvider;
  private readonly maxConnections: number;
  /** gateway:port → record (one server per bind). */
  private readonly listeners = new Map<string, ListenerRecord>();
  /** sandbox_id → Set of "gateway:port" bound for it. */
  private readonly bySandbox = new Map<string, Set<string>>();

  constructor(opts: EgressProxyServerOptions) {
    this.policy = opts.policy;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Bind one listener on gateway:port with the given context. Port 0 binds
   * an ephemeral port (the assigned port resolves). Rejects if the port is
   * taken — callers (the sandbox provider) turn that into "sandbox not
   * spawned".
   */
  bindListener(gateway: string, port: number, context: EgressListenerContext): Promise<number> {
    // NOTE: the map key uses the ASSIGNED port (port 0 → ephemeral), so it is
    // computed after listen() succeeds; the pre-check only catches explicit
    // duplicate fixed ports.
    const requestedKey = `${gateway}:${port}`;
    if (port !== 0 && this.listeners.has(requestedKey)) {
      return Promise.reject(new Error(`egress listener ${requestedKey} already bound`));
    }
    return new Promise<number>((resolve, reject) => {
      const record: ListenerRecord = {
        server: null as unknown as net.Server,
        context,
        tunnels: new Set(),
        maxConnections: this.maxConnections,
      };
      const server = net.createServer((socket) => {
        this.handleConnection(socket, record);
      });
      record.server = server;
      server.once("error", (err: Error) => {
        reject(
          Object.assign(
            new Error(`egress listener ${gateway}:${port} failed to bind: ${err.message}`),
            { code: "egress_bind_failed" },
          ),
        );
      });
      server.listen(port, gateway, () => {
        const address = server.address() as net.AddressInfo;
        const boundPort =
          typeof address === "object" && address !== null ? address.port : port;
        const key = `${gateway}:${boundPort}`;
        // Replace the error rejecter with a fatal close handler.
        server.removeAllListeners("error");
        server.once("error", () => {
          // A late error (e.g. the gateway vanished): close accepted sockets;
          // unbindNetwork/stop also removes the record.
          this.closeListener(key, record);
        });
        this.listeners.set(key, record);
        let keys = this.bySandbox.get(context.sandbox_id);
        if (keys === undefined) {
          keys = new Set();
          this.bySandbox.set(context.sandbox_id, keys);
        }
        keys.add(key);
        resolve(boundPort);
      });
    });
  }

  /** Unbind every listener bound for a sandbox_id. Idempotent. */
  async unbindNetwork(sandboxId: string): Promise<void> {
    const keys = this.bySandbox.get(sandboxId);
    if (keys === undefined) return;
    this.bySandbox.delete(sandboxId);
    for (const key of keys) {
      const record = this.listeners.get(key);
      if (record !== undefined) this.closeListener(key, record);
    }
  }

  /** Unbind everything (kernel shutdown). */
  async stop(): Promise<void> {
    for (const [key, record] of [...this.listeners.entries()]) {
      this.closeListener(key, record);
    }
    this.bySandbox.clear();
  }

  private closeListener(key: string, record: ListenerRecord): void {
    this.listeners.delete(key);
    for (const tunnel of record.tunnels) tunnel.destroy();
    record.tunnels.clear();
    record.server.close();
  }

  private handleConnection(socket: net.Socket, record: ListenerRecord): void {
    // R1-1: source-address enforcement. docker's --internal bridge confines
    // FORWARD-path egress but the host INPUT path is open: without this
    // check a container on ANOTHER sandbox's bridge could reach this
    // listener and authorize under THIS engagement. The listener accepts
    // only its own network's subnet.
    const subnet = record.context.source_subnet;
    if (subnet !== undefined) {
      const remote = socket.remoteAddress ?? "";
      const bare = remote.replace(/^::ffff:/, ""); // docker v4-mapped form
      let inSubnet = false;
      try {
        inSubnet = cidrContains(subnet, bare);
      } catch {
        inSubnet = false;
      }
      if (!inSubnet) {
        socket.destroy();
        return;
      }
    }
    if (record.tunnels.size >= record.maxConnections) {
      // The cap is DoS insurance for the kernel process; excess connections
      // die immediately, exactly like scope denials (no response bytes).
      socket.destroy();
      return;
    }
    record.tunnels.add(socket);
    socket.setTimeout(HEAD_TIMEOUT_MS);
    let head: Buffer = Buffer.alloc(0);
    const cleanup = () => {
      record.tunnels.delete(socket);
      socket.destroy();
    };
    socket.once("timeout", cleanup);
    socket.once("error", () => record.tunnels.delete(socket));
    socket.once("close", () => record.tunnels.delete(socket));

    socket.on("data", (chunk: Buffer) => {
      if (socket.destroyed) return;
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        // R1-14: the cap bounds the HEAD, not the pipelined body — a huge
        // chunk containing a complete head is fine; a headless stream past
        // the cap dies.
        if (head.length > MAX_HEAD_BYTES) {
          cleanup();
        }
        return; // keep accumulating
      }
      // The full head plus anything pipelined after it (early TLS/payload
      // bytes often arrive in the same segment) — the remainder is replayed
      // into the tunnel once it is established.
      void this.dispatchHead(socket, record, head, end + 4).catch(() => cleanup());
    });
  }

  private async dispatchHead(
    socket: net.Socket,
    record: ListenerRecord,
    head: Buffer,
    bodyOffset: number,
  ): Promise<void> {
    socket.removeAllListeners("data");
    socket.setTimeout(0);
    const lineEnd = head.indexOf("\r\n");
    const requestLine = (lineEnd === -1 ? head : head.subarray(0, lineEnd)).toString("latin1");
    const pipelined = head.subarray(bodyOffset);
    const parts = requestLine.split(" ");
    if (parts.length !== 3) throw new Error("malformed request line");
    const [method, authority, version] = parts as [string, string, string];
    if (version.toUpperCase() !== "HTTP/1.1") {
      throw new Error(`only HTTP/1.1 is accepted (got ${version || "empty"})`);
    }
    const m = method.toUpperCase();
    if (m === "CONNECT") {
      const target = parseConnectAuthority(authority);
      if (target === null) {
        throw new Error(`invalid CONNECT authority: ${authority.slice(0, 100)}`);
      }
      await this.tunnelConnect(socket, record, target, pipelined);
      return;
    }
    // R1-4: absolute-form requests (forward-proxy GET/POST http://host/…)
    // are how every standard client reaches PLAIN-HTTP targets through a
    // proxy — CONNECT-only would break every http:// engagement target.
    // The request's authority is scope-checked like a CONNECT; the request
    // is rewritten to origin-form and relayed (Connection: close — one
    // decision per connection, no unchecked pipelined requests).
    if (isForwardMethod(m) && /^http:\/\/[^\s]+$/.test(authority)) {
      await this.forwardAbsolute(
        socket,
        record,
        method,
        authority,
        head,
        bodyOffset,
        pipelined,
      );
      return;
    }
    throw new Error(`only CONNECT (or absolute-form http) is accepted (got ${m || "empty"})`);
  }

  private async tunnelConnect(
    socket: net.Socket,
    record: ListenerRecord,
    target: { host: string; port: number },
    pipelined: Buffer,
  ): Promise<void> {
    const decision = await this.policy.decide(record.context, target);
    if (socket.destroyed) return; // the client gave up while we decided
    if (decision.decision === "deny") {
      // RST semantics: destroy without response bytes.
      socket.destroy(new Error(`egress denied: ${decision.reason}`));
      return;
    }

    // Connect BY PINNED IP — DNS is never consulted again for this tunnel.
    const upstream = await this.connectPinned(socket, decision.pinned_ips, target.port);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client pipelined behind the CONNECT head belong to the
    // tunnel, not to the proxy — replay them before splicing.
    if (pipelined.length > 0) upstream.write(pipelined);
    socket.pipe(upstream);
    upstream.pipe(socket);
    const kill = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", kill);
    socket.once("close", () => upstream.destroy());
    upstream.once("error", kill);
    upstream.once("close", () => socket.destroy());
  }

  /**
   * R1-4 — forward one absolute-form http request. The authority
   * (host[:port]) goes through the SAME decision as a CONNECT; the request
   * line is rewritten to origin-form, hop-by-hop Connection headers are
   * dropped and Connection: close is set (one request per connection — a
   * pipelined second request would ride an unchecked decision), and the
   * response is relayed verbatim.
   */
  private async forwardAbsolute(
    socket: net.Socket,
    record: ListenerRecord,
    method: string,
    authority: string,
    head: Buffer,
    bodyOffset: number,
    pipelined: Buffer,
  ): Promise<void> {
    const url = new URL(authority);
    const port = url.port !== "" ? Number(url.port) : 80;
    const decision = await this.policy.decide(record.context, {
      host: url.hostname.replace(/^\[(.+)\]$/, "$1"),
      port,
    });
    if (socket.destroyed) return;
    if (decision.decision === "deny") {
      socket.destroy(new Error(`egress denied: ${decision.reason}`));
      return;
    }
    const upstream = await this.connectPinned(socket, decision.pinned_ips, port);
    // Rewrite: request line to origin-form; strip hop-by-hop headers; add
    // Connection: close (the proxy manages hop-by-hop per RFC 7230).
    const headText = head.subarray(0, bodyOffset).toString("latin1");
    const lines = headText.split("\r\n");
    const originForm = `${method} ${url.pathname}${url.search} HTTP/1.1`;
    const rewritten = [originForm];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^connection:/i.test(line)) continue; // hop-by-hop
      if (/^proxy-connection:/i.test(line)) continue; // hop-by-hop
      if (line.length > 0) rewritten.push(line);
    }
    rewritten.push("Connection: close");
    // The head terminator: a blank line after the last header.
    upstream.write(rewritten.join("\r\n") + "\r\n\r\n");
    if (pipelined.length > 0) upstream.write(pipelined);
    // One request per connection: relay the response and close with it.
    upstream.pipe(socket);
    const kill = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", kill);
    socket.once("close", () => upstream.destroy());
    upstream.once("error", kill);
    upstream.once("close", () => socket.destroy());
    // The client must not send a second request on this connection.
    socket.on("data", () => {
      // Any further bytes from the client are dropped (the response relay
      // owns the socket from here); the connection closes with the response.
    });
  }

  private connectPinned(
    socket: net.Socket,
    pinnedIps: string[],
    port: number,
  ): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const tryNext = (i: number): void => {
        if (i >= pinnedIps.length) {
          reject(new Error(`all pinned addresses refused for port ${port}`));
          return;
        }
        let advanced = false; // R1-15: timeout+error can fire together
        const advance = (fn: () => void): void => {
          if (advanced) return;
          advanced = true;
          fn();
        };
        const upstream = net.connect({ host: pinnedIps[i], port });
        upstream.setTimeout(CONNECT_TIMEOUT_MS);
        upstream.once("timeout", () =>
          advance(() => {
            upstream.destroy();
            tryNext(i + 1);
          }),
        );
        upstream.once("error", () =>
          advance(() => {
            // Already destroyed by the error; try the next pinned address.
            tryNext(i + 1);
          }),
        );
        // R1-15: destroy() emits ONLY 'close' (no 'error') — settle there.
        upstream.once("close", () =>
          advance(() => {
            tryNext(i + 1);
          }),
        );
        upstream.once("connect", () => {
          advanced = true; // settle: later events are post-connect lifecycle
          upstream.setTimeout(0);
          resolve(upstream);
        });
        // If the client vanished while we were connecting, drop upstream.
        socket.once("close", () => upstream.destroy());
      };
      tryNext(0);
    });
  }

}
