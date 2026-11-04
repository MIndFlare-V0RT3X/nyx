// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, normalizeBaseUrl } from "./api.js";
import type { SessionMeta } from "./types.js";

const meta: SessionMeta = {
  session_id: "s1",
  parent_id: null,
  owner_id: "owner",
  persona_id: "default",
  title: "Test",
  created_at: 1,
  updated_at: 2,
  engagement: null,
};

function envelopeResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createClient error mapping", () => {
  it("maps the error envelope to a typed ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        envelopeResponse(
          400,
          "validation_failed",
          "invalid engagement targets: bad cidr 10.0.0.0/08",
        ),
      ),
    );
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });
    const err = await client.createSession({ title: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.code).toBe("validation_failed");
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe("invalid engagement targets: bad cidr 10.0.0.0/08");
  });

  it("maps 401, 403, 404 and 409 envelopes with their status codes", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "validation_failed", "missing or invalid bearer token"],
      [403, "approval_denied", "R4 approvals may only be resolved by the owner"],
      [404, "not_found", "session s1 not found"],
      [409, "validation_failed", "a turn is already in progress for this session"],
    ];
    for (const [status, code, message] of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => envelopeResponse(status, code, message)),
      );
      const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });
      const err = (await client.getSession("s1").catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe(message);
    }
  });

  it("falls back to a generic code for non-envelope bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>boom</html>", { status: 500 })),
    );
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });
    const err = (await client.listSessions().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(500);
    expect(err.message).toBe("HTTP 500");
  });

  it("wraps network failures as code network with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });
    const err = (await client.listSessions().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
    expect(err.message).toBe("fetch failed");
  });
});

describe("createClient requests", () => {
  it("sends the bearer token and parses a successful listSessions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([meta]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "http://127.0.0.1:8787/", token: "tok" });

    const sessions = await client.listSessions({ limit: 10 });
    expect(sessions).toEqual([meta]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions?limit=10");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("omits the bearer header when the token is empty", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: "ok", version: "0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "", token: "" });

    await client.getHealth();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/health");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("posts a session with the engagement in the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(meta), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });

    const engagement = {
      id: "ENG-1",
      operator_id: "owner",
      authorized_at: 100,
      expires_at: 200,
      targets: { cidrs: ["10.0.0.0/8"], domains: ["example.com"] },
    };
    const created = await client.createSession({ title: "T", persona_id: "default", engagement });
    expect(created.session_id).toBe("s1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "T",
      persona_id: "default",
      engagement,
    });
  });

  it("posts a turn with the text shorthand and parses the 202 body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ turn_id: "t1", session_id: "s1" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });

    const accepted = await client.postTurn("s1", { text: "hello" });
    expect(accepted).toEqual({ turn_id: "t1", session_id: "s1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/s1/turns");
    expect(JSON.parse(init.body as string)).toEqual({ content: { text: "hello" } });
  });

  it("resolves an approval with the decision in the body", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });

    await client.resolveApproval("a1", "deny");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/approvals/a1");
    expect(JSON.parse(init.body as string)).toEqual({ decision: "deny" });
  });

  it("lists approvals with the session_id query parameter", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient({ baseUrl: "http://127.0.0.1:8787", token: "tok" });

    await client.listApprovals("s1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/v1/approvals?session_id=s1");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and trims whitespace", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeBaseUrl("  http://x.y/  ")).toBe("http://x.y");
    expect(normalizeBaseUrl("")).toBe("");
  });
});
