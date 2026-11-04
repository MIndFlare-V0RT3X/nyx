// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared e2e rig: a real @nyx/server over tmpdirs with an injected scripted
// MockProvider (offline), the local dev sandbox, and the repo's real
// persona. Everything goes through the HTTP app (app.request) like an
// external client would.

import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn, mockToolTurn } from "@nyx/model";
import type { ModelProvider } from "@nyx/protocol";
import { createServer } from "@nyx/server";
import type { NyxServer } from "@nyx/server";

export const OWNER_TOKEN = "e2e-owner-token-0123456789";

export const E2E_RULES = [
  { id: "allow-r0", match: { risk: "R0" as const }, decision: "allow" as const },
  { id: "allow-r1", match: { risk: "R1" as const }, decision: "allow" as const },
  { id: "ask-r2", match: { risk: "R2" as const }, decision: "ask" as const },
  { id: "ask-r3", match: { risk: "R3" as const }, decision: "ask" as const },
  { id: "ask-r4", match: { risk: "R4" as const }, decision: "ask" as const },
];

export interface E2eRig {
  server: NyxServer;
  dataDir: string;
  sandboxRoot: string;
  headers: Record<string, string>;
  close(): Promise<void>;
}

const rigs: E2eRig[] = [];

export async function makeRig(script: ModelProvider[]): Promise<E2eRig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-e2e-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-e2e-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-e2e-mem-"));
  const config: NyxConfig = configSchema.parse({
    server: { host: "127.0.0.1", port: 8787, auth: { owner_token: OWNER_TOKEN, tokens: {} } },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: E2E_RULES },
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
  });
  const server = createServer({ config, data_dir: dataDir, providers: script });
  const rig: E2eRig = {
    server,
    dataDir,
    sandboxRoot,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    close: () => server.close(),
  };
  rigs.push(rig);
  return rig;
}

export async function cleanupRigs(): Promise<void> {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) {
    await rm(rig.dataDir, { recursive: true, force: true });
    await rm(rig.sandboxRoot, { recursive: true, force: true });
  }
}

export async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

export async function createSession(
  rig: E2eRig,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await rig.server.app.request("/v1/sessions", {
    method: "POST",
    headers: rig.headers,
    body: JSON.stringify(body),
  });
  if (res.status !== 201)
    throw new Error(`session create failed: ${res.status} ${await res.text()}`);
  const meta = (await res.json()) as { session_id: string };
  return meta.session_id;
}

export async function startTurn(rig: E2eRig, sessionId: string, text: string): Promise<string> {
  const res = await rig.server.app.request(`/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: rig.headers,
    body: JSON.stringify({ content: { text } }),
  });
  if (res.status !== 202) throw new Error(`turn start failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { turn_id: string }).turn_id;
}

/** Every stored event for a session, in seq order, via the session store. */
export async function readEvents(rig: E2eRig, sessionId: string) {
  const { openSessionStore } = await import("@nyx/session");
  const store = openSessionStore(join(rig.dataDir, "nyx.db"));
  try {
    return await store.read(sessionId, 1);
  } finally {
    store.close();
  }
}

export async function loopbackHttp(body: string): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer: http } = await import("node:http");
  const srv = http((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/e2e.txt`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

export { MockProvider, mockTextTurn, mockToolTurn };
