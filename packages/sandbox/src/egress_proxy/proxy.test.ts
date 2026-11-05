// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — the egress proxy mechanics, tested with REAL sockets on the
// loopback interface (the same surface a sandboxed binary would use against
// the bridge gateway). The policy is a stub here — the DECISION logic lives
// in @nyx/security's egress_policy tests; these tests prove the WIRE
// behavior: strict CONNECT parsing, deny-destroys, pin-and-splice, and the
// bypass cases (raw bytes, GET, oversized heads, connection cap, unbind).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "node:net";
import { EgressProxyServer, parseConnectAuthority, DEFAULT_MAX_CONNECTIONS } from "./proxy.js";
import type {
  EgressDecision,
  EgressDecisionProvider,
  EgressListenerContext,
  EgressConnectRequest,
} from "./types.js";
import type { Engagement } from "@nyx/protocol";

const NOW = 1_700_000_000_000;

function engagement(): Engagement {
  return {
    id: "ENG-TEST",
    operator_id: "owner",
    authorized_at: NOW - 1000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
    techniques: ["web_enumeration"],
  };
}

function listenerContext(overrides: Partial<EgressListenerContext> = {}): EgressListenerContext {
  return {
    session_id: "sess-1",
    sandbox_id: "sbx-1",
    engagement: engagement(),
    rate_class: null,
    ...overrides,
  };
}

/** A policy the test scripts per-call (allow pins to the loopback target). */
class ScriptedPolicy implements EgressDecisionProvider {
  calls: Array<EgressListenerContext & { request: EgressConnectRequest }> = [];
  private next: (ctx: EgressListenerContext, req: EgressConnectRequest) => EgressDecision;
  constructor(next: (ctx: EgressListenerContext, req: EgressConnectRequest) => EgressDecision) {
    this.next = next;
  }
  async decide(context: EgressListenerContext, request: EgressConnectRequest) {
    this.calls.push({ ...context, request });
    return this.next(context, request);
  }
}

/** A tiny TCP echo server: returns "pong:<bytes>" for every connection. */
async function echoServer(): Promise<{
  port: number;
  close(): Promise<void>;
  seen: string[];
}> {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      seen.push(text);
      socket.write(`pong:${text}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    seen,
  };
}

/** Issue a raw CONNECT through the proxy; resolve on 200 + first reply. */
function connectThrough(
  proxyPort: number,
  authority: string,
  payload?: string,
): Promise<{ statusLine: string; reply: string; destroyed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let buf = "";
    let statusLine = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ statusLine, reply: buf, destroyed: true });
      }
    }, 3000);
    socket.once("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ statusLine, reply: buf, destroyed: true, ...(err ? {} : {}) });
      }
    });
    socket.once("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ statusLine, reply: buf, destroyed: true });
      }
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (statusLine === "" && buf.includes("\r\n")) {
        statusLine = buf.split("\r\n")[0] ?? "";
      }
      if (buf.includes("pong:")) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ statusLine, reply: buf, destroyed: false });
      }
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    if (payload !== undefined) socket.write(payload);
    void reject; // errors resolve as destroyed outcomes instead
  });
}

describe("parseConnectAuthority", () => {
  it("accepts host:port and [v6]:port", () => {
    expect(parseConnectAuthority("api.example.com:443")).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(parseConnectAuthority("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(parseConnectAuthority("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
  });
  it("rejects everything else — no port, bad ports, userinfo, paths, spaces", () => {
    for (const bad of [
      "api.example.com", // no port
      "api.example.com:", // empty port
      "api.example.com:0",
      "api.example.com:65536",
      "api.example.com:443:80", // multiple colons
      "user:pass@api.example.com:443", // userinfo
      "api.example.com:443/path", // path — fails the charset test
      "api example.com:443", // space
      ":443", // empty host
      "[::1]", // v6 without port
      "exam ple:443",
    ]) {
      expect(parseConnectAuthority(bad)).toBeNull();
    }
  });
});

describe("EgressProxyServer — the wire behavior", () => {
  let proxy: EgressProxyServer;
  let echo: Awaited<ReturnType<typeof echoServer>>;
  let proxyPort: number;
  let policy: ScriptedPolicy;

  beforeAll(async () => {
    echo = await echoServer();
    // The default policy: allow anything, pinned to the echo server
    // (the loopback address — inside the fake engagement's 127/8 CIDR).
    policy = new ScriptedPolicy(() => ({
      decision: "allow",
      reason: "test",
      pinned_ips: ["127.0.0.1"],
    }));
    proxy = new EgressProxyServer({ policy });
    // Ephemeral port on loopback — the same shape as a bridge gateway bind.
    proxyPort = await proxy.bindListener("127.0.0.1", 0, listenerContext());
  });

  afterAll(async () => {
    await proxy.stop();
    await echo.close();
  });

  it("in-scope CONNECT: 200, then a byte-transparent tunnel to the pinned IP", async () => {
    const result = await connectThrough(proxyPort, `127.0.0.1:${echo.port}`, "hello-tunnel");
    expect(result.destroyed).toBe(false);
    expect(result.statusLine).toContain("200");
    expect(result.reply).toContain("pong:hello-tunnel");
    // The tunnel carried ONLY the payload — the CONNECT head never leaks to
    // the upstream (the proxy consumed it).
    expect(echo.seen).toContain("hello-tunnel");
    expect(echo.seen.some((s) => s.includes("CONNECT"))).toBe(false);
  });

  it("out-of-scope CONNECT (policy deny): destroyed, no response bytes", async () => {
    const savedDecide = policy.decide.bind(policy);
    policy.decide = async () => ({ decision: "deny", reason: "out of scope" });
    const result = await connectThrough(proxyPort, "192.0.2.1:443");
    policy.decide = savedDecide;
    expect(result.destroyed).toBe(true);
    expect(result.statusLine).toBe(""); // nothing was written back
  });

  it("TWO-LAYER PROOF: with the tool layer bypassed entirely (a raw socket, no runtime checks), the proxy still denies out-of-scope", async () => {
    // The scripted policy plays the REAL scope engine's verdict for an
    // out-of-scope destination — the point is that a client speaking raw TCP
    // to the proxy (no tool dispatch, no scope.check at the tool layer) is
    // still gated by the proxy's decision.
    const realPolicy = new ScriptedPolicy((_ctx, req) => {
      const allowed = req.host === "127.0.0.1";
      return allowed
        ? { decision: "allow", reason: "in scope", pinned_ips: ["127.0.0.1"] }
        : { decision: "deny", reason: `egress denied: ${req.host} is out of scope` };
    });
    const p2 = new EgressProxyServer({ policy: realPolicy });
    const port = await p2.bindListener("127.0.0.1", 0, listenerContext({ sandbox_id: "sbx-2" }));
    const denied = await connectThrough(port, "198.51.100.9:443");
    expect(denied.destroyed).toBe(true);
    expect(denied.statusLine).toBe("");
    const allowed = await connectThrough(port, `127.0.0.1:${echo.port}`, "via-raw-socket");
    expect(allowed.destroyed).toBe(false);
    expect(allowed.reply).toContain("pong:via-raw-socket");
    await p2.stop();
  });

  it("GET (not CONNECT): destroyed with no response", async () => {
    const result = await new Promise<{ destroyed: boolean; data: string }>((resolve) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let data = "";
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ destroyed: true, data });
      }, 2000);
      socket.once("data", (c) => {
        data += c.toString("utf8");
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve({ destroyed: true, data });
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve({ destroyed: true, data });
      });
      socket.write("GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    expect(result.destroyed).toBe(true);
    expect(result.data).toBe("");
  });

  it("raw garbage bytes (raw socket injection): destroyed", async () => {
    const result = await new Promise<{ destroyed: boolean; data: string }>((resolve) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      let data = "";
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ destroyed: true, data });
      }, 2000);
      socket.once("data", (c) => {
        data += c.toString("utf8");
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve({ destroyed: true, data });
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve({ destroyed: true, data });
      });
      // Not remotely HTTP: random binary.
      socket.write(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x41, 0x0d, 0x0a, 0x0d, 0x0a]));
    });
    expect(result.destroyed).toBe(true);
    expect(result.data).toBe("");
  });

  it("an oversized CONNECT head is destroyed (8 KiB cap)", async () => {
    const result = await new Promise<boolean>((resolve) => {
      const socket = net.connect(proxyPort, "127.0.0.1");
      socket.once("close", () => resolve(true));
      socket.once("error", () => resolve(true));
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(true);
      }, 2000);
      void timer;
      // A header line longer than the cap, never terminated.
      socket.write(`CONNECT ${"a".repeat(9000)}:443 HTTP/1.1\r\n`);
    });
    expect(result).toBe(true);
  });

  it("the per-listener connection cap kills excess sockets (DoS insurance)", async () => {
    const capped = new EgressProxyServer({
      policy: new ScriptedPolicy(() => ({
        decision: "allow",
        reason: "test",
        pinned_ips: ["127.0.0.1"],
      })),
      maxConnections: 1,
    });
    const port = await capped.bindListener(
      "127.0.0.1",
      0,
      listenerContext({ sandbox_id: "sbx-cap" }),
    );
    // Hold one full tunnel open…
    const held = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => held.once("connect", resolve));
    held.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    // …the next connection must die instantly (cap 1, one tunnel registered).
    const excess = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("close", () => resolve(true));
      socket.once("error", () => resolve(true));
      socket.once("connect", () => {
        socket.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1500);
    });
    expect(excess).toBe(true);
    held.destroy();
    await capped.stop();
  });

  it("unbindNetwork closes the listener: new connections refuse", async () => {
    const p3 = new EgressProxyServer({
      policy: new ScriptedPolicy(() => ({
        decision: "allow",
        reason: "test",
        pinned_ips: ["127.0.0.1"],
      })),
    });
    const port = await p3.bindListener("127.0.0.1", 0, listenerContext({ sandbox_id: "sbx-3" }));
    expect(p3.listenerCount).toBe(1);
    await p3.unbindNetwork("sbx-3");
    expect(p3.listenerCount).toBe(0);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("error", () => resolve(true)); // ECONNREFUSED
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    });
    expect(refused).toBe(true);
    await p3.stop();
    expect(DEFAULT_MAX_CONNECTIONS).toBeGreaterThan(0);
  });
});

// ── Phase 6.4 fan-out regressions (R1) ──────────────────────────────────────

describe("R1-1 — source-subnet enforcement: a listener accepts ONLY its own network", () => {
  let echoLocal: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    echoLocal = await echoServer();
  });
  afterAll(async () => {
    await echoLocal.close();
  });
  it("a connection from outside the listener's subnet is destroyed before any decision", async () => {
    let decided = 0;
    const policy = new ScriptedPolicy(() => {
      decided += 1;
      return { decision: "allow", reason: "test", pinned_ips: ["127.0.0.1"] };
    });
    const server = new EgressProxyServer({ policy });
    // Subnet that does NOT contain loopback: every local connection must die
    // at the socket layer — the policy must never even be consulted.
    const port = await server.bindListener("127.0.0.1", 0, {
      session_id: "s",
      sandbox_id: "sbx-r1",
      engagement: engagement(),
      rate_class: null,
      source_subnet: "10.99.0.0/16",
    });
    const result = await connectThrough(port, `127.0.0.1:${echoLocal.port}`, "should-not-tunnel");
    expect(result.destroyed).toBe(true);
    expect(result.statusLine).toBe("");
    expect(decided).toBe(0); // denied at the source check, not by policy
    await server.unbindNetwork("sbx-r1");

    // Subnet that DOES contain loopback: the same connection works.
    const port2 = await server.bindListener("127.0.0.1", 0, {
      session_id: "s",
      sandbox_id: "sbx-r1b",
      engagement: engagement(),
      rate_class: null,
      source_subnet: "127.0.0.0/8",
    });
    const ok = await connectThrough(port2, `127.0.0.1:${echoLocal.port}`, "in-subnet");
    expect(ok.destroyed).toBe(false);
    expect(ok.reply).toContain("pong:in-subnet");
    expect(decided).toBe(1);
    await server.unbindNetwork("sbx-r1b");
  });
});

describe("R1-4 — absolute-form HTTP requests reach plain-http targets through the proxy", () => {
  let echoLocal: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    echoLocal = await echoServer();
  });
  afterAll(async () => {
    await echoLocal.close();
  });
  it("GET http://host/path is forwarded origin-form with Connection: close and the response relays", async () => {
    const server = new EgressProxyServer({
      policy: new ScriptedPolicy(() => ({
        decision: "allow",
        reason: "test",
        pinned_ips: ["127.0.0.1"],
      })),
    });
    const port = await server.bindListener("127.0.0.1", 0, {
      session_id: "s",
      sandbox_id: "sbx-r1c",
      engagement: engagement(),
      rate_class: null,
    });
    const result = await new Promise<{ data: string; destroyed: boolean }>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      const settle = () => resolve({ data, destroyed: !data.includes("pong:") });
      const timer = setTimeout(() => {
        socket.destroy();
        settle();
      }, 3000);
      socket.once("error", () => {
        clearTimeout(timer);
        settle();
      });
      socket.once("close", () => {
        clearTimeout(timer);
        settle();
      });
      socket.on("data", (c) => {
        data += c.toString("utf8");
        // The echo target never closes (it is not an HTTP server); settle as
        // soon as the response relays.
        if (data.includes("pong:")) {
          clearTimeout(timer);
          socket.destroy();
          settle();
        }
      });
      socket.write(
        `GET http://127.0.0.1:${echoLocal.port}/probe?a=1 HTTP/1.1\r\nHost: 127.0.0.1:${echoLocal.port}\r\nUser-Agent: test\r\nConnection: keep-alive\r\n\r\n`,
      );
    });
    expect(result.destroyed).toBe(false);
    expect(result.data).toContain("pong:");
    // The upstream saw the ORIGIN form (not the absolute URL) and the proxy
    // managed the hop-by-hop Connection header.
    const seen = echoLocal.seen.join("\n");
    expect(seen).toContain(`GET /probe?a=1 HTTP/1.1`);
    expect(seen).toContain("Connection: close");
    expect(seen).not.toContain("GET http://");
    await server.unbindNetwork("sbx-r1c");
  });

  it("an out-of-scope absolute-form request is denied with no response bytes (same policy as CONNECT)", async () => {
    const realPolicy = new ScriptedPolicy((_ctx, req) =>
      req.host === "127.0.0.1"
        ? { decision: "allow", reason: "in scope", pinned_ips: ["127.0.0.1"] }
        : { decision: "deny", reason: `egress denied: ${req.host} is out of scope` },
    );
    const server = new EgressProxyServer({ policy: realPolicy });
    const port = await server.bindListener("127.0.0.1", 0, {
      session_id: "s",
      sandbox_id: "sbx-r1d",
      engagement: engagement(),
      rate_class: null,
    });
    const result = await new Promise<{ data: string; destroyed: boolean }>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let data = "";
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ data, destroyed: true });
      }, 3000);
      socket.once("error", () => {
        clearTimeout(timer);
        resolve({ data, destroyed: true });
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolve({ data, destroyed: true });
      });
      socket.on("data", (c) => {
        data += c.toString("utf8");
      });
      socket.write("GET http://outsider.test/x HTTP/1.1\r\nHost: outsider.test\r\n\r\n");
    });
    expect(result.destroyed).toBe(true);
    expect(result.data).toBe("");
    await server.unbindNetwork("sbx-r1d");
  });
});
