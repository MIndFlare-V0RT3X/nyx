// SPDX-License-Identifier: AGPL-3.0-or-later
// Full-stack channel integration: the server with channels.webhook enabled
// starts the adapter on start(), a POST creates a session, runs a turn
// through the SAME lane/loop/policy machinery, and returns the reply; an
// unknown user is 403 + audited; /new and /fork work end to end.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as tcpProbe } from "node:net";
import { configSchema } from "@nyx/config";
import type { NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn } from "@nyx/model";
import { createServer as createNyxServer } from "./server.js";
import Database from "better-sqlite3";

const OWNER_TOKEN = "owner-token-channels";

interface Rig {
  server: ReturnType<typeof createNyxServer>;
  started: { close(): Promise<void> };
  dataDir: string;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

afterAll(async () => {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) {
    await rm(rig.dataDir, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = tcpProbe();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolvePort(port));
    });
  });
}

interface WebhookJson {
  session_id?: string;
  turn_id?: string;
  reply?: string;
  note?: string;
  error?: string;
}

describe("channels (webhook, full stack)", () => {
  it("POST → session created → turn runs → reply returned; second POST attaches; unknown user 403 + audited; /new and /fork work", async () => {
    const port = await freePort();
    const apiPort = await freePort();
    const provider = new MockProvider("mock", [
      mockTextTurn("CHANNEL-REPLY-1"),
      mockTextTurn("CHANNEL-REPLY-2"),
    ]);
    const dataDir = await mkdtemp(join(tmpdir(), "nyx-channels-data-"));
    const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-channels-sbx-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-channels-mem-"));
    const config: NyxConfig = configSchema.parse({
      server: { host: "127.0.0.1", port: apiPort, auth: { owner_token: OWNER_TOKEN } },
      providers: { mock: { kind: "mock" } },
      router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
      sandbox: { provider: "local", workdir_root: sandboxRoot },
      memory: { root: memoryRoot },
      persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
      channels: {
        webhook: {
          enabled: true,
          path: "/webhook",
          bind: "127.0.0.1",
          port,
          allowed_owners: ["owner:primary"],
          reply_timeout_ms: 10_000,
        },
      },
    });
    const server = createNyxServer({ config, data_dir: dataDir, providers: [provider] });
    const started = await server.start();
    rigs.push({
      server,
      started,
      dataDir,
      close: async () => {
        await server.close();
        await started.close();
      },
    });

    const url = `http://127.0.0.1:${port}/webhook`;
    const post = (body: unknown): Promise<{ status: number; json: WebhookJson }> =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, json: (await res.json()) as WebhookJson }));

    // Valid: session created, turn runs, reply delivered exactly once (in the
    // HTTP response — the webhook channel is non-streaming by design).
    const first = await post({ channel_user_id: "owner:primary", text: "hello channels" });
    expect(first.status).toBe(200);
    expect(first.json.reply).toContain("CHANNEL-REPLY-1");
    expect(typeof first.json.session_id).toBe("string");

    // Second POST attaches to the same session.
    const second = await post({ channel_user_id: "owner:primary", text: "again" });
    expect(second.status).toBe(200);
    expect(second.json.session_id).toBe(first.json.session_id);
    expect(second.json.reply).toContain("CHANNEL-REPLY-2");

    // Unknown user: 403, audited into the hash chain, nothing ran.
    const bad = await post({ channel_user_id: "owner:intruder", text: "let me in" });
    expect(bad.status).toBe(403);
    const auditDb = new Database(join(dataDir, "nyx.db"));
    try {
      const rows = auditDb
        .prepare(
          "SELECT action, payload_json FROM audit WHERE action = 'channel.identity.rejected'",
        )
        .all() as Array<{ action: string; payload_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload_json).toContain("owner:intruder");
      const { verifyAuditChain } = await import("@nyx/policy");
      expect(verifyAuditChain(auditDb).ok).toBe(true);
    } finally {
      auditDb.close();
    }

    // /new starts a fresh session via the real store.
    const cmd = await post({ channel_user_id: "owner:primary", text: "/new" });
    expect(cmd.status).toBe(200);
    expect(cmd.json.reply).toContain("new session started");
    expect(cmd.json.session_id).not.toBe(first.json.session_id);

    // /fork forks the current session at the last event.
    const fork = await post({ channel_user_id: "owner:primary", text: "/fork" });
    expect(fork.status).toBe(200);
    expect(fork.json.reply).toContain("forked at the last event");
    expect(fork.json.session_id).not.toBe(cmd.json.session_id);
  });
});
