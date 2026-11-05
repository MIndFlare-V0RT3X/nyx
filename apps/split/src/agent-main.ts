// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the agent binary: one-shot turn driver over the split. The
// AGENT PROCESS hosts the loop, prompt assembly, persona, model router, and
// the remote views; it holds no credentials, no db handle, and no
// filesystem writes outside its workdir.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import pino from "pino";
import type {
  Engagement,
  SessionEvent,
  ToolCall,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
} from "@nyx/protocol";
import { configSchema, loadConfig, type NyxConfig } from "@nyx/config";
import { createAgentLoop } from "@nyx/agent";
import { createKernel } from "@nyx/kernel";
import { IpcClient } from "@nyx/ipc";
import { readTokenFile, runtimeDirPaths } from "@nyx/ipc";
import { ModelRouterImpl, ProviderRegistryImpl } from "@nyx/model";
import type { ModelProvider } from "@nyx/protocol";
import { loadPersona, PersonaRuntimeImpl } from "@nyx/persona";
import {
  injectKernelCredential,
  RemoteApprovalEngine,
  RemoteMemoryStore,
  RemotePolicyEngine,
  RemoteSessionStore,
  RemoteToolRuntime,
} from "./remote.js";
import { ReusableMockProvider, ScriptedFileMockProvider } from "./mock-provider.js";

/** The TOOLS process registry, over the socket. The agent may look, never
 *  register — tool registration belongs to the tools process. */
class RemoteToolRegistry implements ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();

  constructor(private readonly tools: IpcClient) {}

  async load(): Promise<void> {
    const defs = await this.tools.request<ToolDefinition[]>({ type: "tools.list" });
    this.defs.clear();
    for (const def of defs) this.defs.set(def.name, def);
  }

  register(): never {
    throw new Error(
      "the agent process cannot register tools (split mode: nyx-tools owns the registry)",
    );
  }

  unregister(): never {
    throw new Error(
      "the agent process cannot unregister tools (split mode: nyx-tools owns the registry)",
    );
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    const def = this.defs.get(name);
    if (def === undefined) return null;
    return {
      def,
      handler: {
        execute: async () => {
          throw new Error(`tool "${name}" executes in the tools process, not here`);
        },
      },
    };
  }
}

export interface AgentRunOptions {
  config: NyxConfig;
  /** The RUNTIME dir (sockets + tokens) — the agent never learns the data
   *  dir; nyx.db is kernel-only. */
  runtimeDir: string;
  message: string;
  personaId?: string;
  sessionId?: string;
  engagement?: Engagement | null;
  /** JSON file of MockTurn[] — the scriptable provider for tests. */
  mockScriptFile?: string;
}

export interface AgentRunResult {
  session_id: string;
  exit_code: 0 | 1;
  /** Every session event of the turn, in order (the assertion surface). */
  events: SessionEvent[];
  error?: string;
}

/**
 * Providers for the split agent: mock providers build locally (no
 * credential); openai/anthropic providers resolve their api key through the
 * kernel's credential vault — a scoped 60-second token, not the env var
 * (which does not exist in this process's environment at all).
 */
async function buildSplitProviders(
  config: NyxConfig,
  kernel: IpcClient,
  mockScriptFile?: string,
): Promise<ModelProvider[]> {
  const providers: ModelProvider[] = [];
  for (const [id, entry] of Object.entries(config.providers)) {
    if (entry.kind === "mock") {
      if (mockScriptFile !== undefined) {
        providers.push(await ScriptedFileMockProvider.fromFile(id, mockScriptFile));
      } else {
        providers.push(new ReusableMockProvider(id));
      }
      continue;
    }
    const apiKeyEnv = entry.api_key_env;
    if (entry.kind === "openai") {
      const { OpenAICompatibleProvider } = await import("@nyx/model");
      const apiKey =
        apiKeyEnv !== undefined
          ? await injectKernelCredential(kernel, apiKeyEnv, apiKeyEnv)
          : undefined;
      providers.push(
        new OpenAICompatibleProvider({
          id,
          baseUrl: entry.base_url,
          ...(apiKey !== undefined ? { apiKey } : {}),
          models: entry.models,
        }),
      );
    } else if (entry.kind === "anthropic") {
      if (apiKeyEnv === undefined) {
        throw new Error(`split agent: provider "${id}" (anthropic) has no api_key_env`);
      }
      const { AnthropicProvider } = await import("@nyx/model");
      const apiKey = await injectKernelCredential(kernel, apiKeyEnv, apiKeyEnv);
      providers.push(new AnthropicProvider({ id, apiKey, models: entry.models }));
    } else {
      throw new Error(
        `split agent: unsupported provider kind "${String((entry as { kind: string }).kind)}"`,
      );
    }
  }
  return providers;
}

export async function runSplitTurn(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { config, message } = opts;
  const paths = runtimeDirPaths(opts.runtimeDir);

  const kernelToken = await readTokenFile(paths.kernelTokenFile);
  const toolsToken = await readTokenFile(paths.toolsTokenFile);
  const kernel = new IpcClient({
    socketPath: paths.kernelSocket,
    token: kernelToken,
    role: "agent",
    timeoutMs: 180_000,
  });
  const tools = new IpcClient({
    socketPath: paths.toolsSocket,
    token: toolsToken,
    role: "agent",
    timeoutMs: 180_000,
  });
  await kernel.connect();
  await tools.connect();

  const logger = pino({ level: "warn" });

  const session = new RemoteSessionStore(kernel);
  const memory = new RemoteMemoryStore(kernel);
  const policy = new RemotePolicyEngine(kernel);
  const approvals = new RemoteApprovalEngine(kernel);
  const toolRegistry = new RemoteToolRegistry(tools);
  await toolRegistry.load();

  const registry = new ProviderRegistryImpl();
  for (const provider of await buildSplitProviders(config, kernel, opts.mockScriptFile)) {
    registry.register(provider);
  }
  const router = new ModelRouterImpl(
    registry,
    {
      default: config.router.default,
      rules: config.router.rules.map((rule) => ({
        task: rule.match.task,
        chain: rule.chain,
      })),
    },
    logger.child({ component: "router" }),
    config.router.budgets,
  );

  const personaId = opts.personaId ?? config.persona.default_id;
  const loaded = await loadPersona(config.persona.root, personaId);
  const persona = new PersonaRuntimeImpl(loaded);

  const hostKernel = createKernel();
  hostKernel.services.set("tools.runtime", new RemoteToolRuntime(tools, kernel));

  const loop = createAgentLoop();

  let sessionId = opts.sessionId;
  if (sessionId === undefined) {
    const meta = await session.create({
      owner_id: config.owner_id,
      persona_id: personaId,
      ...(opts.engagement !== null && opts.engagement !== undefined
        ? { engagement: opts.engagement }
        : {}),
    });
    sessionId = meta.session_id;
  }
  const meta = await session.meta(sessionId);
  if (meta === null) throw new Error(`session ${sessionId} not found`);

  await mkdir(join(config.sandbox.workdir_root, sessionId), { recursive: true }).catch(
    () => undefined,
  );

  const turnId = `turn-${nanoid(12)}`;
  const controller = new AbortController();
  const events: SessionEvent[] = [];

  try {
    for await (const event of loop.run(
      {
        session_id: sessionId,
        turn_id: turnId,
        user_message: { role: "user", content: [{ type: "text", text: message }] },
      },
      {
        kernel: hostKernel,
        session,
        model: router,
        tools: toolRegistry,
        tool_router: {
          select: (call: ToolCall, available: ToolDefinition[]) =>
            available.find((d) => d.name === call.name) ?? null,
        },
        policy,
        approvals,
        sandbox: {
          id: `remote-${sessionId}`,
          workdir: "/workspace",
          exec: async () => {
            throw new Error("the agent-process sandbox is remote: tools execute in nyx-tools");
          },
          readFile: async () => {
            throw new Error("the agent-process sandbox is remote: tools execute in nyx-tools");
          },
          writeFile: async () => {
            throw new Error("the agent-process sandbox is remote: tools execute in nyx-tools");
          },
          list: async () => {
            throw new Error("the agent-process sandbox is remote: tools execute in nyx-tools");
          },
          destroy: async () => undefined,
        },
        memory,
        persona,
        signal: controller.signal,
        logger,
      },
    )) {
      events.push(event);
    }
    await kernel.close();
    await tools.close();
    return { session_id: sessionId, exit_code: 0, events };
  } catch (err) {
    await kernel.close().catch(() => undefined);
    await tools.close().catch(() => undefined);
    return {
      session_id: sessionId,
      exit_code: 1,
      events,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Load the split agent's config (non-secret; env vars stay kernel-side). */
export async function loadSplitConfig(path?: string): Promise<NyxConfig> {
  if (path !== undefined) return await loadConfig(path);
  return configSchema.parse({
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: [] },
  });
}

// ── the bin entry ───────────────────────────────────────────────────────────

interface AgentArgs {
  configPath: string;
  runtimeDir: string;
  message: string;
  personaId?: string;
  sessionId?: string;
  mockScriptFile?: string;
}

function parseAgentArgs(argv: string[]): AgentArgs {
  const args: AgentArgs = {
    configPath: process.env.NYX_CONFIG_PATH ?? "nyx.config.yaml",
    runtimeDir: process.env.NYX_RUNTIME_DIR ?? "",
    message: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--config" && next !== undefined) {
      args.configPath = next;
      i += 1;
    } else if (arg === "--runtime-dir" && next !== undefined) {
      args.runtimeDir = next;
      i += 1;
    } else if (arg === "--message" && next !== undefined) {
      args.message = next;
      i += 1;
    } else if (arg === "--persona" && next !== undefined) {
      args.personaId = next;
      i += 1;
    } else if (arg === "--session" && next !== undefined) {
      args.sessionId = next;
      i += 1;
    } else if (arg === "--mock-script" && next !== undefined) {
      args.mockScriptFile = next;
      i += 1;
    }
  }
  if (args.runtimeDir.length === 0 || args.message.length === 0) {
    process.stderr.write("nyx-agent: --runtime-dir <dir> and --message <text> are required\n");
    process.exit(2);
  }
  return args;
}

export async function agentMain(argv: string[] = process.argv): Promise<void> {
  const args = parseAgentArgs(argv);
  const config = await loadConfig(args.configPath);
  const result = await runSplitTurn({
    config,
    runtimeDir: args.runtimeDir,
    message: args.message,
    ...(args.personaId !== undefined ? { personaId: args.personaId } : {}),
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(args.mockScriptFile !== undefined ? { mockScriptFile: args.mockScriptFile } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exit_code;
}

// The bin entry runs when invoked as a script (not when imported by tests).
if (process.argv[1] !== undefined && process.argv[1].endsWith("agent-main.js")) {
  agentMain().catch((err: unknown) => {
    process.stderr.write(
      `nyx-agent: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
