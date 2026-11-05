// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — the docker-gated egress-proxy end-to-end acceptance
// (docs/EGRESS-PROXY.md §"Bypass coverage"). These tests need a docker
// daemon and skip otherwise (same convention as docker.test.ts). Everything
// runs against the loopback interface: the "target" is a local HTTP server,
// the engagement authorizes 127.0.0.0/8 + one hostname, and the in-container
// tools speak to the proxy exactly as a sandboxed binary would.

import { execFile } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engagement, Sandbox as ProtocolSandbox } from "@nyx/protocol";
import type { ResolvedAddress } from "@nyx/scope";
import { DockerSandboxProvider, EgressProxyServer, checkDocker } from "@nyx/sandbox";
import type { SandboxEgressBinding } from "@nyx/sandbox";
import { createEgressBinder, createEgressPolicy } from "./egress_policy.js";
import { SecurityRateLimiter } from "./rate_limiter.js";

const dockerAvailable = (await checkDocker()) && !process.env.NYX_SKIP_DOCKER;
const dIt = (name: string, fn: () => Promise<void>, timeout = 180_000): void => {
  if (dockerAvailable) it(name, fn, timeout);
  else it.skip(name, fn, timeout);
};

function engagement(): Engagement {
  const now = Date.now();
  return {
    id: "ENG-DOCKER-E2E",
    operator_id: "owner",
    authorized_at: now - 1000,
    expires_at: now + 3_600_000,
    targets: {
      cidrs: ["127.0.0.0/8"],
      domains: ["in-scope.test"],
    },
    techniques: ["web_enumeration"],
    rate_limits: { default: { requests_per_second: 50 } },
  };
}

/** Resolves in-scope.test to the loopback; everything else fails to resolve. */
const loopbackResolver = {
  resolve: async (hostname: string, port: number) => {
    if (hostname !== "in-scope.test") {
      throw new Error(`test resolver refuses ${hostname}`);
    }
    const ips: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];
    return { hostname, port, ips, pinned_until: Date.now() + 30_000 };
  },
};

describe("egress proxy — docker end-to-end (Phase 6.1 §2.5)", () => {
  let target: http.Server;
  let targetPort: number;
  let proxy: EgressProxyServer;
  let sandbox: ProtocolSandbox;
  let tmpRoot: string;
  let binder: SandboxEgressBinding;

  beforeAll(async () => {
    if (!dockerAvailable) return;
    // The in-scope "target web server" on the host loopback.
    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`egress-ok ${req.url ?? "/"}`);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetPort = (target.address() as net.AddressInfo).port;

    const limiter = new SecurityRateLimiter();
    proxy = new EgressProxyServer({
      policy: createEgressPolicy({ resolver: loopbackResolver, limiter }),
    });
    // Pick a free base port (the binder derives class ports from it).
    let bound = false;
    for (let base = 21000 + Math.floor(Math.random() * 20000); base < 65000; base += 13) {
      const candidate = createEgressBinder(proxy, { basePort: base });
      try {
        await candidate.bindNetwork("probe", "127.0.0.1", {
          session_id: "probe",
          sandbox_id: "probe",
          engagement: engagement(),
        });
        await candidate.unbindNetwork("probe");
        binder = candidate;
        bound = true;
        break;
      } catch {
        /* port taken — try the next base */
      }
    }
    if (!bound || binder === undefined) throw new Error("no free egress base port");

    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-egress-e2e-"));
    const provider = new DockerSandboxProvider({ egress: binder });
    sandbox = await provider.provision({
      provider: "docker",
      workdir: tmpRoot,
      network: "allowlist",
      egress: { session_id: "sess-e2e", engagement: engagement() },
    });
  });

  afterAll(async () => {
    if (!dockerAvailable) return;
    try {
      await sandbox?.destroy();
    } catch {
      /* best-effort */
    }
    await proxy?.stop();
    if (target !== undefined) {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
    if (tmpRoot !== undefined) await fsp.rm(tmpRoot, { recursive: true, force: true });
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("docker", ["network", "prune", "-f", "--filter", "label=org.nyx.egress=true"], (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      /* best-effort cleanup */
    }
  });

  dIt("the sandbox reports its egress wiring (gateway + class ports)", async () => {
    expect(sandbox.egress).toBeDefined();
    if (sandbox.egress !== undefined) {
      expect(net.isIP(sandbox.egress.gateway)).toBeGreaterThan(0);
      expect(sandbox.egress.portFor(null)).toBeGreaterThan(0);
    }
  });

  dIt("NAMESPACE ESCAPE: a direct connection to an external IP has no route", async () => {
    const r = await sandbox.exec("nc -w 3 8.8.8.8 53 < /dev/null; echo EXIT:$?", {
      timeout_ms: 30_000,
    });
    expect(r.stdout).toContain("EXIT:");
    expect(r.stdout).not.toContain("EXIT:0");
  });

  dIt("in-scope: the container reaches the authorized target THROUGH the proxy", async () => {
    const r = await sandbox.exec(
      `wget -q -T 20 -O - http://in-scope.test:${targetPort}/probe || echo WGET-FAILED:$?`,
      { timeout_ms: 60_000 },
    );
    expect(r.stdout).toContain("egress-ok /probe");
    expect(r.stdout).not.toContain("WGET-FAILED");
  });

  dIt("out-of-scope hostname: the proxy denies — the fetch fails", async () => {
    const r = await sandbox.exec(
      `wget -q -T 10 -O - http://out-of-scope.test:${targetPort}/x 2>&1 || echo DENIED:$?`,
      { timeout_ms: 40_000 },
    );
    expect(r.stdout).not.toContain("egress-ok");
    expect(r.stdout).toContain("DENIED:");
  });

  dIt("DoH THROUGH THE PROXY: a CONNECT to an out-of-scope IP literal (e.g. a DoH endpoint) is destroyed", async () => {
    const gw = sandbox.egress?.gateway;
    const port = sandbox.egress?.portFor(null);
    if (gw === undefined || port === undefined) throw new Error("no egress wiring");
    const r = await sandbox.exec(
      `printf 'CONNECT 8.8.8.8:443 HTTP/1.1\\r\\nHost: 8.8.8.8\\r\\n\\r\\n' | nc -w 5 ${gw} ${port}; echo NC-DONE`,
      { timeout_ms: 40_000 },
    );
    // The proxy must NOT establish the tunnel: no 200, connection destroyed.
    expect(r.stdout).not.toContain("200");
    expect(r.stdout).toContain("NC-DONE");
  });

  dIt("RAW SOCKET INJECTION: garbage to the proxy listener is destroyed without a response", async () => {
    const gw = sandbox.egress?.gateway;
    const port = sandbox.egress?.portFor(null);
    if (gw === undefined || port === undefined) throw new Error("no egress wiring");
    const r = await sandbox.exec(
      `head -c 64 /dev/urandom | nc -w 3 ${gw} ${port}; echo RAW-DONE`,
      { timeout_ms: 30_000 },
    );
    expect(r.stdout).not.toContain("200");
    expect(r.stdout).toContain("RAW-DONE");
  });

  dIt("PROXY DOWN: a binder that fails aborts the provision (no proxy, no tools)", async () => {
    const failing: SandboxEgressBinding = {
      bindNetwork: async () => {
        throw new Error("proxy bind failed (test)");
      },
      unbindNetwork: async () => undefined,
    };
    const provider = new DockerSandboxProvider({ egress: failing });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-egress-e2e-fail-"));
    await expect(
      provider.provision({
        provider: "docker",
        workdir: dir,
        network: "allowlist",
        egress: { session_id: "s", engagement: engagement() },
      }),
    ).rejects.toThrow();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
