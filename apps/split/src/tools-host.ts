// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the TOOLS PROCESS host: tool registry, tool runtime, sandbox
// provider. It holds NO credentials (a tool needing one gets a scoped
// 60-second token from the kernel via credential.inject), and it never
// touches nyx.db: policy/approvals are RPCs to the kernel, and tool events
// ride back to the agent inside the tool.execute response (the agent owns
// event ordering and appends through the kernel).
//
// The agent process calls in over the tools socket; the tools process is a
// CLIENT of the kernel socket for policy/approvals.

import { join } from "node:path";
import type {
  ApprovalContext,
  ApprovalRecord,
  Engagement,
  PolicyVerdict,
  SessionEvent,
  ToolCall,
  ToolOutput,
  ToolSchema,
} from "@nyx/protocol";
import type { ActionRequest } from "@nyx/protocol";
import type { NyxConfig } from "@nyx/config";
import type { IpcClient } from "@nyx/ipc";
import { IpcError_, type IpcRequestHandler } from "@nyx/ipc";
import {
  createToolRuntime,
  registerBuiltinTools,
  ToolRegistryImpl,
  ToolRouterImpl,
  type ToolRuntime,
} from "@nyx/tools";
import type { PolicyEngine, ApprovalEngine, Sandbox } from "@nyx/protocol";
import { LocalSandboxProvider, DockerSandboxProvider } from "@nyx/sandbox";
import type { Logger } from "pino";

/** The kernel-side policy, executed over the socket (tools hold no rules). */
class RemotePolicyEngine implements PolicyEngine {
  constructor(private readonly kernel: IpcClient) {}
  async evaluate(req: ActionRequest): Promise<PolicyVerdict> {
    return await this.kernel.request<PolicyVerdict>({ type: "policy.evaluate", action: req });
  }
}

/** The kernel-side approval engine, executed over the socket. */
class RemoteApprovalEngine implements ApprovalEngine {
  constructor(private readonly kernel: IpcClient) {}
  async request(v: PolicyVerdict, ctx: ApprovalContext): Promise<"allow" | "deny"> {
    return await this.kernel.request<"allow" | "deny">({
      type: "approval.request",
      verdict: v,
      context: ctx,
    });
  }
  async resolve(
    id: string,
    decision: "allow" | "deny",
    decided_by: string,
  ): Promise<ApprovalRecord> {
    return await this.kernel.request<ApprovalRecord>({
      type: "approval.resolve",
      id,
      decision,
      decided_by,
    });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    // Not in the split vocabulary (the agent surface resolves by id via the
    // kernel directly); present for interface completeness.
    void id;
    throw new IpcError_({
      code: "not_implemented",
      message: "approval.get is not exposed in split mode",
    });
  }
  async pending(session_id: string): Promise<ApprovalRecord[]> {
    return await this.kernel.request<ApprovalRecord[]>({
      type: "approval.pending",
      session_id,
    });
  }
  async consume(id: string, action_digest: string): Promise<ApprovalRecord> {
    throw new IpcError_({
      code: "not_implemented",
      message: `approval.consume(${id}, ${action_digest}) is not exposed in split mode`,
    });
  }
}

export interface ToolsHostOptions {
  config: NyxConfig;
  dataDir: string;
  /** A connected, authenticated kernel IPC client. */
  kernel: IpcClient;
  logger: Logger;
}

export interface ToolsHost {
  handler: IpcRequestHandler;
  runtime: ToolRuntime;
  close(): Promise<void>;
}

export async function startToolsHost(opts: ToolsHostOptions): Promise<ToolsHost> {
  const { config, logger } = opts;

  const registry = new ToolRegistryImpl();
  registerBuiltinTools(registry);
  // Phase 7 split scope: the registry carries the builtins. The security
  // tools (FindingStore-backed) and subagent tools migrate with the Phase 8
  // soak; security skills run through the single-process surfaces.

  const runtime = createToolRuntime({
    registry,
    router: new ToolRouterImpl(),
    policy: new RemotePolicyEngine(opts.kernel),
    approvals: new RemoteApprovalEngine(opts.kernel),
  });

  // Sandbox: local provider (the documented dev posture for split mode) or
  // docker WITHOUT the egress binder — engagement sandboxes (network
  // "allowlist") refuse at provision with the standing "no proxy, no
  // tools" error until the Phase 8 soak wires the kernel-hosted binder.
  const provider =
    config.sandbox.provider === "local"
      ? new LocalSandboxProvider({ root: config.sandbox.workdir_root })
      : new DockerSandboxProvider({ image: config.sandbox.image });

  /** R1-7: the session's engagement, from the kernel's session.meta — the
   *  authoritative record, cached per session. */
  const sessionEngagements = new Map<string, Engagement | null>();
  const engagementFor = async (session_id: string): Promise<Engagement | null> => {
    if (sessionEngagements.has(session_id)) {
      return sessionEngagements.get(session_id) ?? null;
    }
    const meta = await opts.kernel.request<{ engagement: Engagement | null } | null>({
      type: "session.meta",
      session_id,
    });
    const engagement = meta?.engagement ?? null;
    sessionEngagements.set(session_id, engagement);
    return engagement;
  };

  const sessionSandboxes = new Map<string, Sandbox>();
  const sandboxFor = async (session_id: string): Promise<Sandbox> => {
    const cached = sessionSandboxes.get(session_id);
    if (cached !== undefined) return cached;
    const sandbox = await provider.provision({
      provider: config.sandbox.provider,
      workdir: join(config.sandbox.workdir_root, session_id),
      image: config.sandbox.image,
      network: "none",
    });
    sessionSandboxes.set(session_id, sandbox);
    return sandbox;
  };

  const startedAt = Date.now();

  const handler: IpcRequestHandler = async (request) => {
    switch (request.type) {
      case "health.ping":
        return { ok: true, uptime_ms: Date.now() - startedAt, process_mode: "split" };

      case "tools.specs":
        return runtime.specsForModel();

      case "tools.list":
        // Full definitions — the agent's loop builds the model's tools
        // catalog from them (name, description, input_schema).
        return registry.list();

      case "tool.execute": {
        const call = request.call as ToolCall;
        const context = request.context as {
          session_id: string;
          turn_id: string;
          engagement: Engagement | null;
          workdir_root: string;
        };
        // R1-7 (fan-out): the engagement is resolved from the KERNEL's own
        // session record — the request's copy is untrusted agent input and
        // is IGNORED for scope decisions.
        const engagement = await engagementFor(context.session_id);
        const events: SessionEvent[] = [];
        const sandbox = await sandboxFor(context.session_id);
        const output = await runtime.execute(
          call,
          {
            session_id: context.session_id,
            turn_id: context.turn_id,
            engagement,
            sandbox,
            signal: new AbortController().signal,
            logger,
            emit: (event) => {
              events.push(event);
            },
          },
          request.force_ask === true ? { force_ask: true } : undefined,
        );
        const result: { events: SessionEvent[]; output: ToolOutput | null } = {
          events,
          output,
        };
        return result;
      }

      case "env.probe": {
        // A boundary probe for the split e2e: which of the named env vars
        // exist in THIS process. Values are never returned — presence only.
        const keys = request.keys as string[];
        const present: string[] = [];
        const absent: string[] = [];
        for (const key of keys) {
          if (process.env[key] !== undefined) present.push(key);
          else absent.push(key);
        }
        return { present, absent };
      }

      default:
        throw new IpcError_({
          code: "not_found",
          message: `unknown tools request "${String(request.type)}"`,
        });
    }
  };

  return {
    handler,
    runtime,
    close: async () => {
      for (const sandbox of [...sessionSandboxes.values()]) {
        await sandbox.destroy().catch(() => undefined);
      }
      sessionSandboxes.clear();
    },
  };
}

export type { ToolSchema, ToolOutput };
