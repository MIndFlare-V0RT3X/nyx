// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed fetch client for the NYX REST surface. Every error from the server is
// normalized into an ApiError carrying the error envelope's {code, message}
// plus the HTTP status; network failures get code "network" and status 0.

import type { ApprovalRecord, ContentBlock, Engagement, Projection, SessionMeta } from "./types.js";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ApiClientOptions {
  /** Server base, e.g. "http://127.0.0.1:8787"; "" means same origin. */
  baseUrl: string;
  /** Bearer token; sent only when non-empty. */
  token: string;
}

export interface CreateSessionInput {
  title?: string;
  persona_id?: string;
  engagement?: Engagement;
}

export interface SessionDetail {
  session: SessionMeta;
  projection: Projection;
}

export interface TurnAccepted {
  turn_id: string;
  session_id: string;
}

export interface ModelInfo {
  id: string;
  context_window: number;
  max_output: number;
  supports: Array<
    "tools" | "vision" | "reasoning" | "reasoning_retained" | "json_schema" | "streaming_tools"
  >;
}

export interface HealthInfo {
  status: string;
  version: string;
  node?: string;
  sandbox?: { provider?: string; healthy?: boolean };
  providers?: Array<{ id: string; models: number }>;
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly token: string;
  listSessions(opts?: { limit?: number; owner_id?: string }): Promise<SessionMeta[]>;
  createSession(input: CreateSessionInput): Promise<SessionMeta>;
  getSession(id: string): Promise<SessionDetail>;
  forkSession(id: string, atSeq: number): Promise<SessionMeta>;
  postTurn(
    id: string,
    content: { text: string } | ContentBlock[],
    task?: string,
  ): Promise<TurnAccepted>;
  listApprovals(sessionId: string): Promise<ApprovalRecord[]>;
  resolveApproval(id: string, decision: "allow" | "deny"): Promise<ApprovalRecord>;
  listModels(): Promise<ModelInfo[]>;
  getHealth(): Promise<HealthInfo>;
}

export function createClient(options: ApiClientOptions): ApiClient {
  const base = normalizeBaseUrl(options.baseUrl);
  const token = options.token;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token !== "" ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError("network", err instanceof Error ? err.message : String(err), 0);
    }
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as T;
  }

  const query = (params: Record<string, string | number | undefined>): string => {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
    return entries.length === 0
      ? ""
      : `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`;
  };

  return {
    baseUrl: base,
    token,
    listSessions: (opts) =>
      request<SessionMeta[]>(
        "GET",
        `/v1/sessions${query({ limit: opts?.limit, owner_id: opts?.owner_id })}`,
      ),
    createSession: (input) => request<SessionMeta>("POST", "/v1/sessions", input),
    getSession: (id) => request<SessionDetail>("GET", `/v1/sessions/${encodeURIComponent(id)}`),
    forkSession: (id, atSeq) =>
      request<SessionMeta>("POST", `/v1/sessions/${encodeURIComponent(id)}/fork`, {
        at_seq: atSeq,
      }),
    postTurn: (id, content, task) =>
      request<TurnAccepted>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/turns`,
        task === undefined ? { content } : { content, task },
      ),
    listApprovals: (sessionId) =>
      request<ApprovalRecord[]>("GET", `/v1/approvals${query({ session_id: sessionId })}`),
    resolveApproval: (id, decision) =>
      request<ApprovalRecord>("POST", `/v1/approvals/${encodeURIComponent(id)}`, { decision }),
    listModels: () => request<ModelInfo[]>("GET", "/v1/models"),
    getHealth: () => request<HealthInfo>("GET", "/v1/health"),
  };
}

/** Normalizes the user-supplied base URL: no trailing slash, "" allowed. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/** Parses an error response body into an ApiError, tolerating non-JSON bodies. */
export async function toApiError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `HTTP ${res.status}`;
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const envelope = (body as { error?: unknown }).error;
      if (typeof envelope === "object" && envelope !== null) {
        const { code: c, message: m } = envelope as { code?: unknown; message?: unknown };
        if (typeof c === "string") code = c;
        if (typeof m === "string") message = m;
      }
    }
  } catch {
    // Non-JSON body — keep the HTTP fallback above.
  }
  return new ApiError(code, message, res.status);
}
