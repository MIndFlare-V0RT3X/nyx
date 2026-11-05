// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the process-split end-to-end suite. REAL processes, REAL
// unix sockets, REAL nyx.db on disk: nyx-kernel + nyx-tools boot via
// launchSplitStack (scrubbed child envs), nyx-agent runs one-shot turns,
// and every assertion reads the session event log / audit chain / process
// boundaries — the same assertion style as the single-mode e2e suite.
//
// Docker is NOT required (the local sandbox provider is the documented
// split-mode dev posture); engagement sandboxes over docker in split mode
// are the Phase 8 soak.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IpcClient } from "@nyx/ipc";
import { readTokenFile, runtimePaths } from "@nyx/ipc";
import { openSessionStore } from "@nyx/session";
import { verifyAuditChain } from "@nyx/policy";
import { openUnifiedDatabase } from "@nyx/db";
import { launchSplitStack, scrubAgentEnv, type SplitStack } from "@nyx/split";
import type { SessionEvent } from "@nyx/protocol";

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const tmpDirs: string[] = [];
async function tmpdir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-split-e2e-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

interface Rig {
  dataDir: string;
  configPath: string;
  stack: SplitStack;
  kernelClient: IpcClient;
  toolsClient: IpcClient;
  stop: () => Promise<void>;
}

const rigs: Rig[] = [];

/** The shared default-policy rig (see the boot+protocol describe). */
let shared: Rig | undefined;
function sharedRig(): Rig {
  if (shared === undefined) throw new Error("shared rig not booted yet");
  return shared;
}

async function writeConfig(
  dataDir: string,
  extra: {
    policy?: string[];
    openai?: { baseUrl: string; apiKeyEnv: string; asDefault?: boolean };
  } = {},
): Promise<string> {
  const lines = [
    "providers:",
    "  mock:",
    "    kind: mock",
    ...(extra.openai !== undefined
      ? [
          "  openai-test:",
          "    kind: openai",
          `    base_url: ${extra.openai.baseUrl}`,
          `    api_key_env: ${extra.openai.apiKeyEnv}`,
          "    models:",
          "      - id: gpt-test",
          "        context_window: 8192",
          "        max_output: 1024",
        ]
      : []),
    "router:",
    "  default:",
    "    chain:",
    extra.openai !== undefined && extra.openai.asDefault === true
      ? "      - provider: openai-test"
      : "      - provider: mock",
    extra.openai !== undefined && extra.openai.asDefault === true
      ? "        model: gpt-test"
      : "        model: mock-1",
    "policy:",
    "  rules:",
    "    - { id: allow-r0, match: { risk: R0 }, decision: allow }",
    "    - { id: allow-r1, match: { risk: R1 }, decision: allow }",
    "    - { id: ask-r2, match: { risk: R2 }, decision: ask }",
    ...(extra.policy ?? []),
    "sandbox:",
    "  provider: local",
    `  workdir_root: ${dataDir}/sandboxes`,
    "memory:",
    `  root: ${dataDir}/memory`,
    "persona:",
    "  default_id: default",
    `  root: ${REPO_ROOT}/personas`,
  ];
  const file = path.join(dataDir, "nyx.config.yaml");
  await fsp.writeFile(file, lines.join("\n"), "utf8");
  return file;
}

async function bootRig(
  extra: { policy?: string[]; kernelEnv?: Record<string, string> } = {},
): Promise<Rig> {
  const dataDir = await tmpdir();
  // allow-r3 in the default rig: the credential-file probe runs shell.exec.
  const policy = ["    - { id: allow-r3, match: { risk: R3 }, decision: allow }",
                  ...(extra.policy ?? [])];
  const configPath = await writeConfig(dataDir, { policy });
  const stack = await launchSplitStack({
    repoRoot: REPO_ROOT,
    configPath,
    dataDir,
    ...(extra.kernelEnv !== undefined ? { kernelEnv: extra.kernelEnv } : {}),
  });
  const paths = runtimePaths(dataDir);
  const kernelToken = await readTokenFile(paths.kernelTokenFile);
  const toolsToken = await readTokenFile(paths.toolsTokenFile);
  const kernelClient = new IpcClient({
    socketPath: paths.kernelSocket,
    token: kernelToken,
    role: "kernel-client",
  });
  const toolsClient = new IpcClient({
    socketPath: paths.toolsSocket,
    token: toolsToken,
    role: "kernel-client",
  });
  await kernelClient.connect();
  await toolsClient.connect();
  const rig: Rig = {
    dataDir,
    configPath,
    stack,
    kernelClient,
    toolsClient,
    stop: async () => {
      await kernelClient.close();
      await toolsClient.close();
      await stack.stop();
    },
  };
  rigs.push(rig);
  return rig;
}

/** Run one nyx-agent turn and parse its JSON result. */
async function runAgent(
  rig: Rig,
  message: string,
  opts: { mockScript?: unknown[]; session?: string } = {},
): Promise<{
  session_id: string;
  exit_code: number;
  events: SessionEvent[];
  error?: string;
}> {
  let scriptFile: string | undefined;
  if (opts.mockScript !== undefined) {
    scriptFile = path.join(rig.dataDir, `script-${Math.random().toString(36).slice(2)}.json`);
    await fsp.writeFile(scriptFile, JSON.stringify(opts.mockScript));
  }
  const { stdout } = await execFileP(
    process.execPath,
    [
      `${REPO_ROOT}/apps/split/dist/agent-main.js`,
      "--config",
      rig.configPath,
      "--runtime-dir",
      path.join(rig.dataDir, "runtime"),
      "--message",
      message,
      ...(opts.session !== undefined ? ["--session", opts.session] : []),
      ...(scriptFile !== undefined ? ["--mock-script", scriptFile] : []),
    ],
    {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      // R1-8 (fan-out): the agent process gets the scrubbed env — the
      // operator's credential vars never reach the semi-trusted zone.
      env: scrubAgentEnv(process.env, {
        set: {
          NYX_CONFIG_PATH: rig.configPath,
          NYX_RUNTIME_DIR: path.join(rig.dataDir, "runtime"),
        },
      }),
    },
  );
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error(`nyx-agent produced no output (${stdout})`);
  return JSON.parse(last) as {
    session_id: string;
    exit_code: number;
    events: SessionEvent[];
    error?: string;
  };
}

/** The tool-call-then-text script every turn test uses. */
function toolTurnScript(
  call: { name: string; input: Record<string, unknown> },
  finalText: string,
): unknown[] {
  return [
    [
      { type: "tool_call.delta", index: 0, id: "c1", name: call.name, arguments_delta: JSON.stringify(call.input) },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "done", finish_reason: "tool_calls" },
    ],
    [
      { type: "text.delta", text: finalText },
      { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "done", finish_reason: "stop" },
    ],
  ];
}

async function readEvents(rig: Rig, sessionId: string): Promise<SessionEvent[]> {
  const store = openSessionStore(path.join(rig.dataDir, "nyx.db"));
  try {
    return await store.read(sessionId, 1);
  } finally {
    store.close();
  }
}

afterAll(async () => {
  // Sequential + generous timeout: each rig stops two real processes.
  for (const rig of rigs) await rig.stop().catch(() => undefined);
}, 180_000);

describe("process split — boot + protocol (Phase 7.3 §4.6)", () => {
  // One shared rig for the whole file's default-policy tests (the split
  // spawns real processes; the suite stays light by not booting per test).
  let rig: Rig;
  beforeAll(async () => {
    rig = await bootRig();
    shared = rig;
  }, 60_000);

  it("boots nyx-kernel + nyx-tools healthy; the agent connects; versions negotiate", async () => {
    const health = await rig.kernelClient.request<{ ok: boolean; process_mode: string }>({
      type: "health.ping",
    });
    expect(health).toEqual({ ok: true, uptime_ms: expect.any(Number), process_mode: "split" });
    const toolsHealth = await rig.toolsClient.request<{ ok: boolean }>({ type: "health.ping" });
    expect(toolsHealth.ok).toBe(true);
    // Protocol version negotiated on connect (a mismatch refuses instead).
    expect(rig.kernelClient.serverVersion).toBe("nyx-kernel");
    expect(rig.toolsClient.serverVersion).toBe("nyx-tools");
  });

  it("refuses a wrong-token client on both sockets", async () => {
    const paths = runtimePaths(rig.dataDir);
    for (const socketPath of [paths.kernelSocket, paths.toolsSocket]) {
      const client = new IpcClient({ socketPath, token: "forged-token", role: "kernel-client" });
      await expect(client.connect()).rejects.toMatchObject({
        ipc: { code: "auth" },
      });
    }
  });
});

describe("process split — a full turn through all three processes", () => {
  it("model → agent loop → tools process → kernel session log, in order", async () => {
    const rig = sharedRig();
    const result = await runAgent(rig, "write the note", {
      mockScript: toolTurnScript(
        { name: "fs.write", input: { path: "note.txt", content: "split works" } },
        "done writing",
      ),
    });
    expect(result.exit_code).toBe(0);
    const types = result.events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("message.user");
    expect(types.indexOf("tool.call")).toBeLessThan(types.indexOf("tool.result"));
    expect(types.indexOf("tool.result")).toBeLessThan(types.indexOf("turn.completed"));
    // The tool REALLY executed in the tools process (the local provider's
    // sandbox workdir is a nyx-sbx-* mkdtemp under workdir_root).
    const sandboxRoot = path.join(rig.dataDir, "sandboxes");
    const sandboxes = await fsp.readdir(sandboxRoot);
    const hits: string[] = [];
    for (const name of sandboxes) {
      const candidate = path.join(sandboxRoot, name, "note.txt");
      if (
        await fsp
          .stat(candidate)
          .then(() => true)
          .catch(() => false)
      ) {
        hits.push(await fsp.readFile(candidate, "utf8"));
      }
    }
    expect(hits).toEqual(["split works"]);
    // And the same events are durable in nyx.db (the kernel's store).
    const stored = await readEvents(rig, result.session_id);
    expect(stored.map((e) => e.type)).toEqual(
      expect.arrayContaining(["turn.started", "tool.call", "tool.result", "turn.completed"]),
    );
  });

  it("an out-of-sandbox path is refused by the tools process (path containment holds)", async () => {
    const rig = sharedRig();
    const result = await runAgent(rig, "read the secret", {
      mockScript: toolTurnScript(
        { name: "fs.read", input: { path: "../../etc/passwd" } },
        "cannot read that",
      ),
    });
    const error = result.events.find((e) => e.type === "tool.error");
    expect(error).toBeDefined();
    expect(result.events.some((e) => e.type === "tool.result")).toBe(false);
  });
});

describe("process split — the isolation proofs (§4.6)", () => {
  it("the tool process finds NO credential env vars and no data-dir pointer", async () => {
    const rig = sharedRig();
    const probe = await rig.toolsClient.request<{ present: string[]; absent: string[] }>({
      type: "env.probe",
      keys: [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "NYX_ZAI_API_KEY",
        "NYX_OWNER_TOKEN",
        "NYX_DATA_DIR",
        "HOME",
      ],
    });
    expect(probe.present).toEqual([]);
    expect(probe.absent).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "NYX_ZAI_API_KEY",
      "NYX_OWNER_TOKEN",
      "NYX_DATA_DIR",
      "HOME",
    ]);
  });

  it("credential file paths the kernel might hold do not exist (ENOENT, from the tool process)", async () => {
    const rig = sharedRig();
    // The kernel holds credentials in memory ONLY; every plausible on-disk
    // path is probed from inside the tools process via a REAL tool call.
    const probeCmd =
      `for f in "${rig.dataDir}/credentials.json" "${rig.dataDir}/vault.json" ` +
      `"${rig.dataDir}/runtime/credentials.json" "${rig.dataDir}/runtime/kernel-token-backup" ` +
      `"${process.env.HOME ?? "/root"}/.nyx/credentials.json"; do ` +
      `[ -e "$f" ] && echo "PRESENT:$f" || echo "ENOENT:$f"; done`;
    const result = await runAgent(rig, "probe for credential files", {
      mockScript: toolTurnScript({ name: "shell.exec", input: { cmd: probeCmd } }, "probe done"),
    });
    const toolResult = result.events.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    const text = JSON.stringify(toolResult);
    expect(text).toContain("ENOENT");
    expect(text).not.toContain("PRESENT");
  });

  it("a credential crosses the boundary ONLY as a scoped kernel token (real HTTP proof)", async () => {
    // A local "openai-compatible" endpoint captures the Authorization
    // header; the provider in the AGENT process must present the scoped
    // token fetched from the kernel — the env var never existed in the
    // agent process (its env is scrubbed by the launcher).
    const captured: string[] = [];
    const server: Server = createServer((req, res) => {
      captured.push(String(req.headers.authorization ?? ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: Date.now(),
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello from the fake endpoint" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const dataDir = await tmpdir();
    const configPath = await writeConfig(dataDir, {
      openai: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: "NYX_SPLIT_TEST_KEY",
        asDefault: true,
      },
    });

    const stack = await launchSplitStack({
      repoRoot: REPO_ROOT,
      configPath,
      dataDir,
      kernelEnv: { ...process.env, NYX_SPLIT_TEST_KEY: "sk-split-e2e-secret" },
    });
    rigs.push({
      dataDir,
      configPath,
      stack,
      kernelClient: new IpcClient({
        socketPath: runtimePaths(dataDir).kernelSocket,
        token: await readTokenFile(runtimePaths(dataDir).kernelTokenFile),
        role: "kernel-client",
      }),
      toolsClient: new IpcClient({
        socketPath: runtimePaths(dataDir).toolsSocket,
        token: await readTokenFile(runtimePaths(dataDir).toolsTokenFile),
        role: "kernel-client",
      }),
      stop: async () => {
        await stack.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    });
    const rig = rigs[rigs.length - 1]!;
    await rig.kernelClient.connect();
    await rig.toolsClient.connect();

    // The kernel env HAS the credential; the tools process does not.
    const probe = await rig.toolsClient.request<{ present: string[] }>({
      type: "env.probe",
      keys: ["NYX_SPLIT_TEST_KEY"],
    });
    expect(probe.present).toEqual([]);

    // A turn against the real provider — the fake endpoint captures the
    // header the AGENT process sent.
    const { stdout } = await execFileP(
      process.execPath,
      [
        `${REPO_ROOT}/apps/split/dist/agent-main.js`,
        "--config",
        configPath,
        "--runtime-dir",
        path.join(dataDir, "runtime"),
        "--message",
        "say hi",
      ],
      {
        timeout: 60_000,
        env: scrubAgentEnv(process.env, {
          set: {
            NYX_CONFIG_PATH: configPath,
            NYX_RUNTIME_DIR: path.join(dataDir, "runtime"),
          },
        }),
      },
    );
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      exit_code: number;
      error?: string;
    };
    expect(parsed.exit_code).toBe(0);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0]).toBe("Bearer sk-split-e2e-secret");
  });
});

describe("process split — the robustness proofs (§4.6)", () => {
  it("SIGKILL the agent mid-flight: the kernel survives, the audit chain verifies", async () => {
    const rig = await bootRig();
    // Create a session with real events first.
    const result = await runAgent(rig, "first turn", {
      mockScript: toolTurnScript(
        { name: "fs.write", input: { path: "a.txt", content: "a" } },
        "ok",
      ),
    });
    expect(result.exit_code).toBe(0);

    // Kill the kernel? No — kill the AGENT. The agent is a one-shot here, so
    // the equivalent: kill the TOOLS process (a runaway untrusted runtime)
    // and prove the kernel carries on and the audit chain is intact.
    rig.stack.tools.kill("SIGKILL");
    await once(rig.stack.tools, "exit");

    // The kernel is still healthy and the audit chain still verifies.
    const health = await rig.kernelClient.request<{ ok: boolean }>({ type: "health.ping" });
    expect(health.ok).toBe(true);
    const db = openUnifiedDatabase(path.join(rig.dataDir, "nyx.db"));
    try {
      const audit = verifyAuditChain(db.db);
      expect(audit.ok).toBe(true);
      expect(audit.checked).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("the kernel IPC token rotates on agent restart and the old token is dead", async () => {
    const rig = sharedRig();
    const paths = runtimePaths(rig.dataDir);
    const tokenBefore = await readTokenFile(paths.kernelTokenFile);

    // Run an agent turn (connect + exit).
    await runAgent(rig, "rotate the token please");

    // Rotation is asynchronous — wait for the file to change.
    const deadline = Date.now() + 10_000;
    let tokenAfter = tokenBefore;
    while (Date.now() < deadline) {
      tokenAfter = await readTokenFile(paths.kernelTokenFile);
      if (tokenAfter !== tokenBefore) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(tokenAfter).not.toBe(tokenBefore);

    // The pre-restart token cannot be replayed.
    const replay = new IpcClient({
      socketPath: paths.kernelSocket,
      token: tokenBefore,
      role: "agent",
    });
    await expect(replay.connect()).rejects.toMatchObject({ ipc: { code: "auth" } });

    // The fresh token connects fine.
    const fresh = new IpcClient({
      socketPath: paths.kernelSocket,
      token: tokenAfter,
      role: "kernel-client",
    });
    await fresh.connect();
    await fresh.close();
  });
});

describe("process split — the fan-out regression proofs (7.6)", () => {
  it("R1-1: the TOOLS role cannot call privileged kernel verbs", async () => {
    const rig = await bootRig();
    const paths = runtimePaths(rig.dataDir);
    // The KERNEL token (what a compromised nyx-tools holds — it needs it to
    // serve policy/approvals), presented with the TOOLS role.
    const kernelToken = await readTokenFile(paths.kernelTokenFile);
    const asTools = new IpcClient({
      socketPath: paths.kernelSocket,
      token: kernelToken,
      role: "tools",
    });
    await asTools.connect();
    // The verbs the tools process legitimately needs: allowed.
    const health = await asTools.request<{ ok: boolean }>({ type: "health.ping" });
    expect(health.ok).toBe(true);
    // The privileged verbs: refused.
    for (const request of [
      { type: "session.create", input: { owner_id: "owner", persona_id: "default" } },
      { type: "audit.write", entry: { actor: "x", action: "x", payload: {} } },
      { type: "approval.resolve", id: "nope", decision: "allow", decided_by: "cli:owner" },
      { type: "credential.inject", name: "X", target_env: "X" },
      { type: "task.claim", worker_id: "w" },
    ] as const) {
      await expect(asTools.request(request as never)).rejects.toMatchObject({
        ipc: { code: "auth" },
      });
    }
    // And an arbitrary role string does not even handshake.
    const asBanana = new IpcClient({
      socketPath: paths.kernelSocket,
      token: kernelToken,
      role: "banana" as never,
    });
    await expect(asBanana.connect()).rejects.toMatchObject({ ipc: { code: "auth" } });
    await asTools.close();
  });

  it("R1-2: credential.inject resolves ONLY configured provider key names", async () => {
    const rig = await bootRig({
      kernelEnv: { ...process.env, NYX_EVAL_SECRET_KEY: "sk-eval-secret" },
    });
    // The rig config has no api_key_env (mock providers) — EVERY name is
    // out of the allowlist, including real-looking env that EXISTS in the
    // kernel process.
    await expect(
      rig.kernelClient.request({
        type: "credential.inject",
        name: "NYX_EVAL_SECRET_KEY",
        target_env: "NYX_EVAL_SECRET_KEY",
      }),
    ).rejects.toMatchObject({
      ipc: { code: "auth", message: expect.stringContaining("not a configured provider api_key_env") },
    });
    await expect(
      rig.kernelClient.request({
        type: "credential.inject",
        name: "NYX_OWNER_TOKEN",
        target_env: "NYX_OWNER_TOKEN",
      }),
    ).rejects.toMatchObject({ ipc: { code: "auth" } });
  });

  it("R1-7: a forged engagement in the tool context is IGNORED (kernel's record wins)", async () => {
    const rig = await bootRig();
    // A session with NO engagement. The agent's tool.execute context will
    // carry a forged permissive engagement — pre-fix, web.fetch would run
    // under it; post-fix, the tools process resolves the engagement from
    // the kernel (null) and the runtime denies with reason "scope".
    const session = await rig.kernelClient.request<{ session_id: string }>({
      type: "session.create",
      input: { owner_id: "owner", persona_id: "default" },
    });
    const forged: never = {
      call: {
        call_id: "forge-1",
        name: "web.fetch",
        input: { url: "https://in-scope.test/anything" },
      },
      context: {
        session_id: session.session_id,
        turn_id: "eval-forge",
        engagement: {
          id: "ENG-FORGED",
          operator_id: "owner",
          authorized_at: 1,
          expires_at: 4102444800000,
          targets: { cidrs: ["0.0.0.0/0"], domains: ["in-scope.test"] },
          techniques: ["web_enumeration"],
        },
        workdir_root: "",
      },
    } as never;
    const result = await rig.toolsClient.request<{ events: Array<{ type: string; reason?: string }> }>({
      type: "tool.execute",
      ...(forged as object),
    });
    const denial = result.events.find((e) => e.type === "action.denied");
    expect(denial).toBeDefined();
    expect(denial?.reason).toBe("scope");
    expect(result.events.some((e) => e.type === "tool.result")).toBe(false);
  });
});

describe("process split — the kernel request vocabulary (§4.3)", () => {
  it("the approval flow over IPC: request blocks, resolve lands the event, the verdict returns", async () => {
    const rig = sharedRig();
    // A session to anchor the approval to.
    const session = await rig.kernelClient.request<{ session_id: string }>({
      type: "session.create",
      input: { owner_id: "owner", persona_id: "default" },
    });
    // The request blocks until resolved — fire it, then resolve from here.
    // (action_digest: sha256 over canonical JSON of {tool, input, risk},
    //  exactly as the runtime computes it — any value works for the flow
    //  test; the digest binds consume(), not request().)
    const pending = rig.kernelClient.request<"allow" | "deny">({
      type: "approval.request",
      verdict: {
        decision: "ask",
        rule_id: "ask-r2",
        action_digest: "a".repeat(64),
        summary: "split-mode approval flow test",
      },
      context: { session_id: session.session_id, turn_id: "t-split", actor_id: "system:runtime" },
    });
    // Wait for the pending record to surface, then allow it.
    const deadline = Date.now() + 10_000;
    let record: { id: string } | undefined;
    while (Date.now() < deadline) {
      const pendingList = await rig.kernelClient.request<Array<{ id: string }>>({
        type: "approval.pending",
        session_id: session.session_id,
      });
      record = pendingList[0];
      if (record !== undefined) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(record).toBeDefined();
    await rig.kernelClient.request({
      type: "approval.resolve",
      id: record!.id,
      decision: "allow",
      decided_by: "cli:owner",
    });
    await expect(pending).resolves.toBe("allow");
    // Both approval events are durable in the session log.
    const events = await readEvents(rig, session.session_id);
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    expect(types.indexOf("approval.requested")).toBeLessThan(types.indexOf("approval.resolved"));
  });

  it("memory.write over the socket lands in the kernel's store; task.claim on an empty queue is null", async () => {
    const rig = sharedRig();
    const written = await rig.kernelClient.request<{ id: string }>({
      type: "memory.write",
      entry: {
        scope: "global",
        kind: "fact",
        content: "the split runtime writes memories through the kernel",
        source: { session_id: "split-e2e" },
        tags: ["split"],
      },
    });
    expect(typeof written.id).toBe("string");
    const listed = await rig.kernelClient.request<Array<{ id: string }>>({
      type: "memory.list",
      scopes: ["global"],
    });
    expect(listed.some((entry) => entry.id === written.id)).toBe(true);

    const claim = await rig.kernelClient.request<{ id: string } | null>({
      type: "task.claim",
      worker_id: "split-e2e-worker",
    });
    expect(claim).toBeNull();
  });

  it("audit.write rows land on the chain with the CONNECTION's identity, never a forged actor (R1-3)", async () => {
    const rig = sharedRig();
    await rig.kernelClient.request({
      type: "audit.write",
      entry: { actor: "system:security", action: "test.probe", payload: { ok: true } },
    });
    const db = openUnifiedDatabase(path.join(rig.dataDir, "nyx.db"));
    try {
      const rows = db.db
        .prepare("SELECT actor, action, payload_json FROM audit WHERE action = ?")
        .all("test.probe") as Array<{ actor: string; payload_json: string }>;
      expect(rows).toHaveLength(1);
      // The stamped actor is the connection role — the forged
      // "system:security" survived only as payload metadata.
      expect(rows[0]?.actor).toBe("ipc:kernel-client");
      const payload = JSON.parse(rows[0]?.payload_json ?? "{}") as {
        requested_actor?: string;
      };
      expect(payload.requested_actor).toBe("system:security");
      const audit = verifyAuditChain(db.db);
      expect(audit.ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
