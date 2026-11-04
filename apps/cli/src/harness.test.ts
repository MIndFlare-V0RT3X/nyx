// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared test harness for the @nyx/cli suite. This file is a HELPER, not a
// suite: it is named *.test.ts so the root eslint config's package-boundary
// exemption for test files applies (the harness needs the real @nyx/* wiring),
// and it registers no tests, so vitest must not run it (see vitest.config.ts).
//
// Real components everywhere: a real config (configSchema.parse) over tmpdirs,
// the real createLocalRuntime wiring, real scripted MockProviders, real
// persona fixtures, a real loopback HTTP server for web.fetch tests.

import { afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn, type MockTurn } from "@nyx/model";
import type { ModelProvider } from "@nyx/protocol";
import { createLocalRuntime, type LocalRuntime } from "./local.js";
import { StringLineWriter } from "./run.js";

export const RULES = [
  { id: "allow-r0", match: { risk: "R0" as const }, decision: "allow" as const },
  { id: "allow-r1", match: { risk: "R1" as const }, decision: "allow" as const },
  { id: "ask-r2", match: { risk: "R2" as const }, decision: "ask" as const },
  { id: "ask-r3", match: { risk: "R3" as const }, decision: "ask" as const },
  { id: "ask-r4", match: { risk: "R4" as const }, decision: "ask" as const },
];

export const PERSONA_YAML = `schema: 1
id: default
name: Test
voice:
  register: close
  verbosity: terse
cognition:
  planning: auto
contract:
  precedence: operator_over_defaults
  honesty:
    never_fabricate: true
    evidence_required: true
    no_completion_without_verification: true
  scope:
    enforce_engagement: true
    deny_out_of_scope: true
    one_line_reason: true
  escalate: []
  always: []
capabilities:
  domains: []
  tools_allow: ["*"]
  tools_deny: []
memory:
  scopes: [session]
`;

/** Write a minimal valid persona directory (persona.yaml + the four md files). */
export async function writePersonaFixture(root: string, id = "default"): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "persona.yaml"), PERSONA_YAML.replace("id: default", `id: ${id}`));
  await writeFile(join(dir, "SOUL.md"), "test soul\n");
  await writeFile(join(dir, "CONTRACT.md"), "test contract\n");
  await writeFile(join(dir, "USER.md"), "test user\n");
  await writeFile(join(dir, "MEMORY.md"), "test memory\n");
  return dir;
}

export interface RigDirs {
  data: string;
  sandboxRoot: string;
  memoryRoot: string;
  personasRoot: string;
}

export interface Rig {
  dirs: RigDirs;
  config: NyxConfig;
  /** A fresh runtime over the rig's config (callers must close()). */
  runtime(
    providers?: ModelProvider[],
    opts?: { approval_mode?: "interactive" | "auto-deny" },
  ): LocalRuntime;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

export function buildConfig(dirs: RigDirs, overrides: Record<string, unknown> = {}): NyxConfig {
  return configSchema.parse({
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: RULES },
    sandbox: { provider: "local", workdir_root: dirs.sandboxRoot },
    memory: { root: dirs.memoryRoot },
    persona: { default_id: "default", root: dirs.personasRoot },
    logging: { level: "warn" },
    ...(overrides as object),
  });
}

export async function makeRig(overrides: Record<string, unknown> = {}): Promise<Rig> {
  const dirs: RigDirs = {
    data: await mkdtemp(join(tmpdir(), "nyx-cli-data-")),
    sandboxRoot: await mkdtemp(join(tmpdir(), "nyx-cli-sbx-")),
    memoryRoot: await mkdtemp(join(tmpdir(), "nyx-cli-mem-")),
    personasRoot: await mkdtemp(join(tmpdir(), "nyx-cli-persona-")),
  };
  await writePersonaFixture(dirs.personasRoot);
  const config = buildConfig(dirs, overrides);
  const rig: Rig = {
    dirs,
    config,
    runtime(providers, opts) {
      return createLocalRuntime({
        config,
        data_dir: dirs.data,
        ...(providers !== undefined ? { providers } : {}),
        approval_mode: opts?.approval_mode ?? "interactive",
      });
    },
    async close() {
      // Nothing to tear down beyond the dirs — runtimes are closed by their
      // tests; sandboxes intentionally persist (see local.ts close()).
    },
  };
  rigs.push(rig);
  return rig;
}

afterAll(async () => {
  for (const rig of rigs) await rig.close();
});

/** A scripted provider speaking the router's "mock" id. */
export function scriptedMock(script: MockTurn[]): MockProvider {
  return new MockProvider("mock", script);
}

/** A provider that answers mockTextTurn(text) forever. */
export function repeatingMock(text: string): ModelProvider {
  return {
    id: "mock",
    listModels: () => new MockProvider("mock", []).listModels(),
    async *complete(req) {
      yield* new MockProvider("mock", [mockTextTurn(text)]).complete(req);
    },
  };
}

/** Await a condition, polling at 25ms, up to `ms` (default 8s). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Spin a loopback HTTP server; returns { url, close }. */
export async function loopbackServer(
  body: string,
  contentType = "text/plain",
): Promise<{ url: string; close(): Promise<void> }> {
  const server: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/target.txt`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An engagement authorizing exactly the loopback interface. */
export function loopbackEngagement(): {
  id: string;
  title: string;
  operator_id: string;
  authorized_at: number;
  expires_at: number;
  targets: { cidrs: string[]; domains: string[] };
} {
  return {
    id: "ENG-TEST-1",
    title: "test engagement",
    operator_id: "owner",
    authorized_at: Date.now(),
    expires_at: Date.now() + 60 * 60 * 1000,
    targets: { cidrs: ["127.0.0.1/32"], domains: [] },
  };
}

/** Capturing stdout/stderr pair for runOneShot assertions. */
export function captureOutput(): { stdout: StringLineWriter; stderr: StringLineWriter } {
  return { stdout: new StringLineWriter(), stderr: new StringLineWriter() };
}

/** Find the first sandbox workdir under root that contains relPath. */
export async function findSandboxFile(root: string, relPath: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(root)) {
    const candidate = join(root, name, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
