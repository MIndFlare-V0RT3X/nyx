// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the KERNEL PROCESS host: config, credential vault, policy
// engine, approval engine, audit chain, SQLite (sessions + tasks), memory
// store — and the request handlers that expose them over the token-
// authenticated kernel socket. This is the trusted zone; everything else in
// the split talks to it through @nyx/ipc.
//
// Scope note (Phase 7): the kernel socket carries the request vocabulary
// the split runtime exercises — sessions (create/append/read/meta/
// projection), policy.evaluate, approval.request/resolve/pending,
// credential.inject, audit.write, memory.write/list/search,
// task.claim/complete. Channel adapters, heartbeat, and the lane queue
// remain single-mode surfaces (Phase 8 soak migrates them); the egress
// proxy stays kernel-hosted in the architecture but no split consumer
// binds it yet (engagement sandboxes in split mode refuse at provision
// with the documented "no proxy, no tools" error).

import { join } from "node:path";
import type {
  ActionRequest,
  ApprovalContext,
  ApprovalRecord,
  Engagement,
  MemoryEntry,
  PolicyVerdict,
  Projection,
  SessionEvent,
  SessionMeta,
  StoredEvent,
} from "@nyx/protocol";
import type { NyxConfig } from "@nyx/config";
import { openUnifiedDatabase, type UnifiedDb } from "@nyx/db";
import { openSessionStore } from "@nyx/session";
import type { SessionStore } from "@nyx/protocol";
import {
  appendAudit,
  openApprovalEngine,
  PolicyEngineImpl,
  assertEngagementOwnership,
  verifyAuditChain,
} from "@nyx/policy";
import type { ApprovalEngineImpl } from "@nyx/policy";
import { MemoryStoreImpl } from "@nyx/memory";
import { createTaskManager, type TaskManager } from "@nyx/tasks";
import { IpcError_, type IpcRequestHandler } from "@nyx/ipc";
import { CredentialVault } from "./credential-vault.js";

export interface KernelHostOptions {
  config: NyxConfig;
  dataDir: string;
  /** Env for the credential vault (default process.env, read once). */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface KernelHost {
  /** The socket request dispatcher. */
  handler: IpcRequestHandler;
  /** Direct handles for the process binary (health, shutdown, audit verify). */
  close(): Promise<void>;
  verifyAudit(): { ok: boolean; checked: number; first_bad_id?: number };
  uptimeMs(): number;
}

export async function startKernelHost(opts: KernelHostOptions): Promise<KernelHost> {
  const { config, dataDir } = opts;
  const now = opts.now ?? Date.now;
  const startedAt = Date.now();

  // ── The trusted data plane: one nyx.db, one session store, one audit chain.
  const unified: UnifiedDb = openUnifiedDatabase(join(dataDir, "nyx.db"));
  const auditSink = (entry: { actor: string; action: string; payload: unknown }): void => {
    appendAudit(unified.db, entry, { now });
  };

  const approvalHandle: ReturnType<typeof openApprovalEngine> = openApprovalEngine(unified.db, {
    onCreated: (rec) => {
      void store
        .append(rec.session_id, [
          {
            type: "approval.requested",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            action_digest: rec.action_digest,
            summary: rec.summary,
            risk: rec.risk,
            ts: now(),
          } satisfies SessionEvent,
        ])
        .catch(() => undefined);
    },
    onResolved: (rec) => {
      void store
        .append(rec.session_id, [
          {
            type: "approval.resolved",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            decision: rec.decision === "pending" ? "deny" : rec.decision,
            decided_by: rec.decided_by ?? "system",
            ts: now(),
          } satisfies SessionEvent,
        ])
        .catch(() => undefined);
    },
  });
  const approvals: ApprovalEngineImpl = approvalHandle.engine;

  const store: SessionStore = openSessionStore(join(dataDir, "nyx.db"), {
    db: unified.db,
    onEventsCommitted: (stored) => {
      for (const storedEvent of stored) approvalHandle.auditEvent(storedEvent, storedEvent.seq);
    },
  });

  const policy = new PolicyEngineImpl(config.policy.rules);
  const memory = new MemoryStoreImpl(config.memory.root, {
    episode_expiry_days: config.memory.episode_expiry_days,
  });
  const vault = new CredentialVault({ env: opts.env, audit: auditSink, now });
  const tasks: TaskManager = createTaskManager({ db: unified.db, store, now });

  // R1-2 (fan-out): credential.inject may resolve ONLY the provider
  // api_key_env names the operator configured — not arbitrary environment
  // (NYX_OWNER_TOKEN, anything else in the kernel's env).
  const credentialNames = new Set(
    Object.values(config.providers)
      .map((entry) => (entry as { api_key_env?: string }).api_key_env)
      .filter((name): name is string => name !== undefined),
  );

  // R1-1 (fan-out): per-role authorization. The socket authenticates
  // possession of the token; the ROLE is the authorization unit. The
  // untrusted tools process gets exactly what it needs (policy, approvals,
  // session meta); the semi-trusted agent gets the session/policy/memory
  // surface; only kernel-side clients (operators, the e2e drivers, the
  // future channel adapters) reach the privileged verbs.
  const ROLE_GATES: Record<string, ReadonlySet<string>> = {
    "kernel-client": new Set(["*"]),
    agent: new Set([
      "health.ping",
      "session.create",
      "session.append",
      "session.read",
      "session.meta",
      "session.projection",
      "policy.evaluate",
      "approval.request",
      "approval.pending",
      "credential.inject",
      "memory.write",
      "memory.list",
      "memory.search",
    ]),
    tools: new Set([
      "health.ping",
      "policy.evaluate",
      "approval.request",
      "approval.pending",
      "session.meta", // R1-7: the tools process resolves the session's
      // ENGAGEMENT from the kernel's own record — never from the request.
    ]),
  };

  const handler: IpcRequestHandler = async (request, connection) => {
    const allowed = ROLE_GATES[connection.role] ?? new Set<string>();
    if (!allowed.has("*") && !allowed.has(request.type as string)) {
      throw new IpcError_({
        code: "auth",
        message:
          `role "${connection.role}" may not call "${String(request.type)}" ` +
          "(the kernel socket authenticates the token; the role is the authorization)",
      });
    }
    switch (request.type) {
      case "health.ping":
        return { ok: true, uptime_ms: Date.now() - startedAt, process_mode: "split" };

      case "session.create": {
        const input = request.input as {
          owner_id: string;
          persona_id: string;
          title?: string;
          parent_id?: string;
          engagement?: Engagement | null;
        };
        if (input.engagement !== null && input.engagement !== undefined) {
          // An engagement authorizes its own operator's sessions — nothing
          // else (same refusal as the single-mode surfaces).
          assertEngagementOwnership(input.engagement, config.owner_id);
        }
        return await store.create({
          owner_id: input.owner_id,
          persona_id: input.persona_id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
          engagement: input.engagement ?? null,
        });
      }

      case "session.append":
        return await store.append(request.session_id as string, request.events as SessionEvent[]);

      case "session.read":
        return await store.read(
          request.session_id as string,
          request.from_seq as number | undefined,
          request.limit as number | undefined,
        );

      case "session.meta":
        return await store.meta(request.session_id as string);

      case "session.projection":
        return await store.projection(request.session_id as string);

      case "policy.evaluate":
        return await policy.evaluate(request.action as ActionRequest);

      case "approval.request":
        return await approvals.request(
          request.verdict as PolicyVerdict,
          request.context as ApprovalContext,
        );

      case "approval.resolve":
        return await approvals.resolve(
          request.id as string,
          request.decision as "allow" | "deny",
          request.decided_by as string,
        );

      case "approval.pending":
        return await approvals.pending(request.session_id as string);

      case "credential.inject": {
        const name = request.name as string;
        if (!credentialNames.has(name)) {
          throw new IpcError_({
            code: "auth",
            message:
              `credential "${name}" is not a configured provider api_key_env — ` +
              "the vault resolves provider keys only (R1-2)",
          });
        }
        const credential = vault.inject(
          name,
          request.target_env as string,
          `ipc:${connection.role}`,
        );
        return {
          token: credential.token,
          target_env: credential.target_env,
          expires_at: credential.expires_at,
          scopes: credential.scopes,
        };
      }

      case "audit.write": {
        // R1-3 (fan-out): the actor is the CONNECTION's identity, stamped
        // by the kernel — a client cannot forge "system:security" rows.
        // The caller's requested actor survives only as payload metadata.
        const entry = request.entry as { actor: string; action: string; payload: unknown };
        appendAudit(
          unified.db,
          {
            actor: `ipc:${connection.role}`,
            action: entry.action,
            payload: {
              ...(typeof entry.payload === "object" && entry.payload !== null
                ? (entry.payload as Record<string, unknown>)
                : { value: entry.payload }),
              ...(entry.actor !== `ipc:${connection.role}` ? { requested_actor: entry.actor } : {}),
            },
          },
          { now },
        );
        return { ok: true };
      }

      case "memory.write":
        return await memory.write(
          request.entry as Omit<MemoryEntry, "id" | "created_at" | "updated_at">,
        );

      case "memory.list": {
        const scopes = request.scopes as string[] | undefined;
        const entries = await memory.list({
          ...(scopes !== undefined ? { scope: scopes as MemoryEntry["scope"][] } : {}),
          ...(request.limit !== undefined ? { limit: request.limit as number } : {}),
        });
        return entries;
      }

      case "memory.search":
        return await memory.search(request.query as string, {
          ...(request.limit !== undefined ? { limit: request.limit as number } : {}),
        });

      case "task.claim": {
        // One candidate at a time, claimed atomically under a lease —
        // the same primitive the single-mode worker pool uses.
        const workerId = request.worker_id as string;
        const candidates = tasks.sql.candidates(now());
        for (const id of candidates) {
          const claim = tasks.sql.claim(id, workerId, 300_000, now());
          if (claim.claimed && claim.task !== undefined) return claim.task;
        }
        return null;
      }

      case "task.complete": {
        // The worker's settle verb: running → completed under MY lease,
        // the result recorded on the row (guardedSettle's exact SQL path).
        const taskId = request.task_id as string;
        const workerId = request.worker_id as string;
        const fresh = tasks.sql.get(taskId);
        if (fresh === null) {
          throw new IpcError_({ code: "not_found", message: `task ${taskId} not found` });
        }
        return tasks.sql.settleRunning(
          taskId,
          workerId,
          "completed",
          {
            attempts: fresh.attempts,
            result: (request.result ?? null) as never,
            next_attempt_at: null,
          },
          now(),
        );
      }

      default:
        throw new IpcError_({
          code: "not_found",
          message: `unknown kernel request "${String(request.type)}"`,
        });
    }
  };

  return {
    handler,
    verifyAudit: () => verifyAuditChain(unified.db),
    uptimeMs: () => Date.now() - startedAt,
    close: async () => {
      await memory.compact?.().catch(() => undefined);
      store.close();
      approvalHandle.close();
      unified.close();
    },
  };
}

export type { SessionMeta, StoredEvent, Projection, ApprovalRecord };
