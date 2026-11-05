// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the AGENT PROCESS's remote views: SessionStore, MemoryStore,
// PolicyEngine, ApprovalEngine, and ToolRuntimeService implemented over the
// kernel/tools IPC clients. The agent holds NO credentials, NO db handle,
// NO filesystem outside its workdir — everything below is a socket call.

import type {
  ApprovalContext,
  ApprovalRecord,
  Engagement,
  MemoryEntry,
  MemorySearchOptions,
  MemoryScope,
  Projection,
  SessionEvent,
  SessionKind,
  SessionListOptions,
  SessionMeta,
  StoredEvent,
  ToolCall,
  ToolOutput,
} from "@nyx/protocol";
import type {
  ActionRequest,
  ApprovalEngine,
  MemoryStore,
  PolicyEngine,
  PolicyVerdict,
  SessionStore,
} from "@nyx/protocol";
import type { IpcClient } from "@nyx/ipc";
import { IpcClientError } from "@nyx/ipc";
import type { ToolRuntimeService } from "@nyx/agent";

/** The kernel's session store, over the socket. */
export class RemoteSessionStore implements SessionStore {
  constructor(private readonly kernel: IpcClient) {}

  async create(input: {
    owner_id: string;
    persona_id: string;
    title?: string;
    parent_id?: string;
    engagement?: Engagement | null;
    kind?: SessionKind;
  }): Promise<SessionMeta> {
    return await this.kernel.request<SessionMeta>({
      type: "session.create",
      input: {
        owner_id: input.owner_id,
        persona_id: input.persona_id,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
        engagement: input.engagement ?? null,
      },
    });
  }

  async append(session_id: string, events: SessionEvent[]): Promise<StoredEvent[]> {
    return await this.kernel.request<StoredEvent[]>({ type: "session.append", session_id, events });
  }

  async read(session_id: string, from_seq?: number, limit?: number): Promise<StoredEvent[]> {
    return await this.kernel.request<StoredEvent[]>({
      type: "session.read",
      session_id,
      ...(from_seq !== undefined ? { from_seq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  stream(session_id: string, from_seq?: number): AsyncIterable<StoredEvent> {
    void session_id;
    void from_seq;
    const failure = new Error("session.stream is not exposed in split mode (Phase 8 surface)");
    return {
      [Symbol.asyncIterator](): AsyncIterator<StoredEvent> {
        return {
          next(): Promise<IteratorResult<StoredEvent>> {
            return Promise.reject(failure);
          },
        };
      },
    };
  }

  async fork(session_id: string, at_seq: number): Promise<SessionMeta> {
    void session_id;
    void at_seq;
    throw new Error("session.fork is not exposed in split mode (Phase 8 surface)");
  }

  async meta(session_id: string): Promise<SessionMeta | null> {
    return await this.kernel.request<SessionMeta | null>({ type: "session.meta", session_id });
  }

  async list(opts?: SessionListOptions): Promise<SessionMeta[]> {
    void opts;
    throw new Error("session.list is not exposed in split mode");
  }

  async projection(session_id: string): Promise<Projection> {
    return await this.kernel.request<Projection>({ type: "session.projection", session_id });
  }

  async rebuildProjections(): Promise<void> {
    throw new Error("session.rebuildProjections is not exposed in split mode");
  }

  async archiveSession(session_id: string): Promise<SessionMeta> {
    void session_id;
    throw new Error("session.archiveSession is not exposed in split mode");
  }

  close(): void {
    /* the kernel owns the store; nothing to close here */
  }
}

/** The kernel's memory store, over the socket. */
export class RemoteMemoryStore implements MemoryStore {
  constructor(private readonly kernel: IpcClient) {}

  async write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry> {
    return await this.kernel.request<MemoryEntry>({ type: "memory.write", entry });
  }

  async search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<Array<MemoryEntry & { score: number }>> {
    return await this.kernel.request<Array<MemoryEntry & { score: number }>>({
      type: "memory.search",
      query,
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entries = await this.kernel.request<Array<MemoryEntry & { score: number }>>({
      type: "memory.search",
      query: id,
      limit: 1000,
    });
    return entries.find((e) => e.id === id) ?? null;
  }

  async list(opts?: {
    scope?: MemoryScope[];
    kind?: MemoryEntry["kind"];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    return await this.kernel.request<MemoryEntry[]>({
      type: "memory.list",
      ...(opts?.scope !== undefined ? { scopes: opts.scope } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async compact(): Promise<{ merged: number; dropped: number }> {
    /* the kernel compacts on its own lifecycle */
    return { merged: 0, dropped: 0 };
  }
}

/** The kernel's policy engine, over the socket. */
export class RemotePolicyEngine implements PolicyEngine {
  constructor(private readonly kernel: IpcClient) {}
  async evaluate(req: ActionRequest): Promise<PolicyVerdict> {
    return await this.kernel.request({ type: "policy.evaluate", action: req });
  }
}

/** The kernel's approval engine, over the socket (request/resolve/pending). */
export class RemoteApprovalEngine implements ApprovalEngine {
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
    void id;
    throw new Error("approval.get is not exposed in split mode");
  }

  async pending(session_id: string): Promise<ApprovalRecord[]> {
    return await this.kernel.request<ApprovalRecord[]>({
      type: "approval.pending",
      session_id,
    });
  }

  async consume(id: string, action_digest: string): Promise<ApprovalRecord> {
    throw new Error(`approval.consume(${id}, ${action_digest}) is not exposed in split mode`);
  }

  withdrawSession?(session_id: string, reason: string): number {
    // Split mode: the agent drains the kernel's pending list and resolves
    // each deny through approval.resolve itself.
    void reason;
    return 0;
  }
}

/** The loop's ToolRuntimeService: execute over the tools socket, events
 *  replayed into the caller's pump in order (the agent owns event order). */
export class RemoteToolRuntime implements ToolRuntimeService {
  constructor(
    private readonly tools: IpcClient,
    private readonly kernel: IpcClient,
  ) {}

  async execute(
    call: ToolCall,
    ctx: {
      session_id: string;
      turn_id: string;
      engagement: Engagement | null;
      emit: (e: SessionEvent) => void;
    },
    opts?: { force_ask?: boolean },
  ): Promise<ToolOutput> {
    const result = await this.tools.request<{ events: SessionEvent[]; output: ToolOutput | null }>({
      type: "tool.execute",
      call: { call_id: call.call_id, name: call.name, input: call.input as Record<string, unknown> },
      context: {
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        engagement: ctx.engagement,
        workdir_root: "",
      },
      ...(opts?.force_ask === true ? { force_ask: true } : {}),
    });
    // R1-6 (fan-out): the tools process is UNTRUSTED — its event list is
    // validated, not replayed verbatim: the event must belong to THIS turn,
    // be a tool-lifecycle event, and carry THIS call's id. Anything else is
    // an injection attempt and fails the turn loudly.
    const allowed = new Set(["tool.call", "tool.result", "tool.error", "action.denied"]);
    for (const event of result.events) {
      const record = event as unknown as Record<string, unknown>;
      if (
        !allowed.has(event.type) ||
        record.session_id !== ctx.session_id ||
        record.turn_id !== ctx.turn_id ||
        record.call_id !== call.call_id
      ) {
        throw new IpcClientError({
          code: "internal",
          message:
            `tools process returned an invalid event for call "${call.call_id}" ` +
            `(type "${event.type}", session/turn/call mismatch) — refusing to append`,
        });
      }
    }
    for (const event of result.events) ctx.emit(event);
    if (result.output === null) {
      throw new IpcClientError({
        code: "internal",
        message: `tool "${call.name}" produced no output`,
      });
    }
    return result.output;
  }
}

/**
 * Resolve a provider api_key_env through the kernel's credential vault:
 * the agent process holds a scoped 60-second token, never the durable env
 * var (which is not even present in this process's environment).
 */
export async function injectKernelCredential(
  kernel: IpcClient,
  name: string,
  targetEnv: string,
): Promise<string> {
  const credential = await kernel.request<{ token: string; expires_at: number }>({
    type: "credential.inject",
    name,
    target_env: targetEnv,
  });
  return credential.token;
}
