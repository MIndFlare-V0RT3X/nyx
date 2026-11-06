// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the IPC layer: server + client over a REAL unix socket in a
// tempdir, handshake auth, version refusal, token rotation, env scrubbing.

import { promises as fsp } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IpcClient } from "./client.js";
import { IpcServer, IpcError_ } from "./server.js";
import {
  generateIpcToken,
  readTokenFile,
  rotateTokenFile,
  runtimePaths,
  scrubEnvironment,
  writeTokenFile,
} from "./index.js";
import { IPC_PROTOCOL_VERSION } from "./protocol.js";

const tmpDirs: string[] = [];
async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-ipc-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

describe("IpcServer + IpcClient (real unix socket)", () => {
  it("connects, handshakes, serves requests, and negotiates the version", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    const server = new IpcServer({
      socketPath,
      token: "tok-1",
      serverVersion: "0.7.3-test",
      handler: async (request) => {
        if (request.type === "echo") return { echoed: request.value };
        if (request.type === "fail") {
          throw new IpcError_({ code: "not_implemented", message: "nope" });
        }
        throw new IpcError_({ code: "not_found", message: `unknown ${String(request.type)}` });
      },
    });
    await server.start();
    try {
      const client = new IpcClient({ socketPath, token: "tok-1", role: "kernel-client" });
      await client.connect();
      expect(client.serverVersion).toBe("0.7.3-test");
      const result = await client.request<{ echoed: number }>({ type: "echo", value: 42 });
      expect(result).toEqual({ echoed: 42 });
      await expect(client.request({ type: "fail" })).rejects.toMatchObject({
        name: "IpcClientError",
        ipc: { code: "not_implemented" },
      });
      await expect(client.request({ type: "nope" })).rejects.toMatchObject({
        ipc: { code: "not_found" },
      });
      await client.close();
    } finally {
      await server.stop();
    }
  });

  it("destroys a wrong-token connection (no dispatch, no info)", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    let dispatched = 0;
    const server = new IpcServer({
      socketPath,
      token: "real-token",
      serverVersion: "v",
      handler: async () => {
        dispatched += 1;
        return {};
      },
    });
    await server.start();
    try {
      const client = new IpcClient({ socketPath, token: "wrong-token", role: "kernel-client" });
      await expect(client.connect()).rejects.toMatchObject({
        name: "IpcClientError",
        ipc: { code: "auth" },
      });
      expect(dispatched).toBe(0);
      // The server side tears the socket down asynchronously after the
      // denial — give it a beat before counting connections.
      await new Promise((r) => setTimeout(r, 100));
      expect(server.connectionCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("refuses a protocol-version mismatch without dispatching", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    const server = new IpcServer({
      socketPath,
      token: "t",
      serverVersion: "v",
      handler: async () => ({}),
    });
    await server.start();
    try {
      // Hand-rolled client with the WRONG protocol version.
      const denied = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.includes("\n")) resolve(buffer.trim());
        });
        socket.once("error", reject);
        socket.on("connect", () => {
          socket.write(
            `${JSON.stringify({ v: IPC_PROTOCOL_VERSION + 999, auth: "Bearer t", role: "kernel-client" })}\n`,
          );
        });
      });
      expect(denied).toContain('"version"');
    } finally {
      await server.stop();
    }
  });

  it("destroys garbage-before-handshake connections", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    const server = new IpcServer({
      socketPath,
      token: "t",
      serverVersion: "v",
      handler: async () => ({}),
    });
    await server.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        socket.setEncoding("utf8");
        socket.once("close", () => resolve());
        socket.once("error", reject);
        socket.on("connect", () => {
          socket.write("GET /etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n\n");
        });
      });
      expect(server.connectionCount).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("supports parallel clients and cleans up on stop (socket file removed)", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    const server = new IpcServer({
      socketPath,
      token: "t",
      serverVersion: "v",
      handler: async (request) => ({ pong: request.type }),
    });
    await server.start();
    const clients = await Promise.all(
      [1, 2, 3].map(async () => {
        const client = new IpcClient({ socketPath, token: "t", role: "kernel-client" });
        await client.connect();
        return client;
      }),
    );
    expect(server.connectionCount).toBe(3);
    const results = await Promise.all(
      clients.map((c) => c.request<{ pong: string }>({ type: "health.ping" })),
    );
    expect(results.every((r) => r.pong === "health.ping")).toBe(true);
    await Promise.all(clients.map((c) => c.close()));
    await server.stop();
    await expect(fsp.stat(socketPath)).rejects.toThrow();
  });

  it("rejects in-flight requests when the server dies (no hangs)", async () => {
    const dir = await tmpdir();
    const socketPath = path.join(dir, "test.sock");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new IpcServer({
      socketPath,
      token: "t",
      serverVersion: "v",
      handler: async () => {
        await gate;
        return {};
      },
    });
    await server.start();
    const client = new IpcClient({ socketPath, token: "t", role: "kernel-client" });
    await client.connect();
    const pending = client.request({ type: "blocked" });
    // Kill the server mid-request; the client must reject, not hang.
    setTimeout(() => void server.stop(), 20);
    await expect(pending).rejects.toMatchObject({ name: "IpcClientError" });
    release?.();
  });
});

describe("token files", () => {
  it("writes 0600, reads back, and rotates atomically (old token invalid)", async () => {
    const dir = await tmpdir();
    const file = path.join(dir, "kernel.token");
    const first = generateIpcToken();
    await writeTokenFile(file, first);
    expect(await readTokenFile(file)).toBe(first);
    const { token: second } = await rotateTokenFile(file);
    expect(second).not.toBe(first);
    expect(await readTokenFile(file)).toBe(second);
    const stat = await fsp.stat(file);
    // 0600 (owner read/write only).
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("runtimePaths lays out the split-mode runtime dir", () => {
    const paths = runtimePaths("/data");
    expect(paths.runtimeDir).toBe("/data/runtime");
    expect(paths.kernelSocket).toBe("/data/runtime/kernel.sock");
    expect(paths.kernelTokenFile).toBe("/data/runtime/kernel.token");
    expect(paths.toolsSocket).toBe("/data/runtime/tools.sock");
  });
});

describe("scrubEnvironment", () => {
  it("drops credentials, keeps allowlisted names, adds overrides", () => {
    const scrubbed = scrubEnvironment(
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "sk-ant",
        NYX_ZAI_API_KEY: "sk-zai",
        NYX_OWNER_TOKEN: "owner-tok",
        HOME: "/home/attacker",
        NYX_DATA_DIR: "/data/with/nyx.db",
        SHELL: "/bin/bash",
      } as unknown as NodeJS.ProcessEnv,
      { keep: ["NYX_ENV"], set: { NYX_ENV: "development", NYX_RUNTIME_DIR: "/data/runtime" } },
    );
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      NYX_ENV: "development",
      NYX_RUNTIME_DIR: "/data/runtime",
    });
    // Secrets and data-dir pointers are structurally absent.
    for (const banned of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "NYX_ZAI_API_KEY",
      "NYX_OWNER_TOKEN",
      "HOME",
      "NYX_DATA_DIR",
      "SHELL",
    ]) {
      expect(scrubbed[banned]).toBeUndefined();
    }
  });
});
