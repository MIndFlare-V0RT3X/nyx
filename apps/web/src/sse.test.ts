// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { connectSSE, parseSSEChunk } from "./sse.js";
import type { StoredEvent } from "./types.js";

describe("parseSSEChunk", () => {
  it("parses a complete frame with id, event and data", () => {
    const { frames, rest } = parseSSEChunk(
      'id: 42\nevent: nyx\ndata: {"type":"turn.started","seq":42}\n\n',
    );
    expect(frames).toEqual([
      { id: "42", event: "nyx", data: '{"type":"turn.started","seq":42}' },
    ]);
    expect(rest).toBe("");
  });

  it("parses multiple frames in one chunk", () => {
    const { frames, rest } = parseSSEChunk("id: 1\ndata: a\n\nid: 2\ndata: b\n\n");
    expect(frames).toEqual([
      { id: "1", data: "a" },
      { id: "2", data: "b" },
    ]);
    expect(rest).toBe("");
  });

  it("keeps an incomplete frame as rest (split across chunks)", () => {
    const first = parseSSEChunk("id: 7\nevent: nyx\ndata: {\"seq\":7");
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe('id: 7\nevent: nyx\ndata: {"seq":7');

    const second = parseSSEChunk(first.rest + '}\n\n');
    expect(second.frames).toEqual([{ id: "7", event: "nyx", data: '{"seq":7}' }]);
    expect(second.rest).toBe("");
  });

  it("keeps a frame whose terminator is split across chunks", () => {
    const first = parseSSEChunk("data: hello\n");
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe("data: hello\n");
    const second = parseSSEChunk(first.rest + "\ndata: world\n\n");
    expect(second.frames).toEqual([{ data: "hello" }, { data: "world" }]);
  });

  it("ignores comment lines (heartbeat pings)", () => {
    expect(parseSSEChunk(": ping\n\n").frames).toEqual([]);
    expect(parseSSEChunk(": hb\n\nid: 5\ndata: x\n\n: ping\n\n").frames).toEqual([{ id: "5", data: "x" }]);
    // A comment inside a record does not break the record.
    expect(parseSSEChunk(": keepalive\ndata: y\n\n").frames).toEqual([{ data: "y" }]);
  });

  it("joins multi-line data fields with newlines", () => {
    const { frames } = parseSSEChunk("id: 3\ndata: line1\ndata: line2\ndata: line3\n\n");
    expect(frames).toEqual([{ id: "3", data: "line1\nline2\nline3" }]);
  });

  it("tolerates CRLF line endings", () => {
    const { frames, rest } = parseSSEChunk("id: 9\r\nevent: nyx\r\ndata: crlf\r\n\r\n");
    expect(frames).toEqual([{ id: "9", event: "nyx", data: "crlf" }]);
    expect(rest).toBe("");
  });

  it("tolerates lone CR line endings and split CRLF terminators", () => {
    // WHATWG: a lone \r is a line ending; \r\r is one empty line → one
    // dispatch. Within a frame the last id: wins and data: lines join.
    const { frames } = parseSSEChunk("id: 1\rdata: lone\rid: 2\rdata: two\r\r");
    expect(frames).toEqual([{ id: "2", data: "lone\ntwo" }]);
    // A blank line between records still dispatches two frames in CR mode.
    const two = parseSSEChunk("id: 1\rdata: lone\r\rid: 2\rdata: two\r\r");
    expect(two.frames).toEqual([
      { id: "1", data: "lone" },
      { id: "2", data: "two" },
    ]);
    // CR at the end of one chunk, LF at the start of the next.
    const first = parseSSEChunk("data: split\r");
    expect(first.frames).toEqual([]);
    const second = parseSSEChunk(first.rest + "\n\n");
    expect(second.frames).toEqual([{ data: "split" }]);
  });

  it("accepts field values without a space after the colon", () => {
    const { frames } = parseSSEChunk("id:42\ndata:x\n\n");
    expect(frames).toEqual([{ id: "42", data: "x" }]);
  });

  it("strips exactly one leading space from values and ignores unknown fields", () => {
    const { frames } = parseSSEChunk("data:   keep\nretry: 1000\n\n");
    expect(frames).toEqual([{ data: "  keep" }]);
  });

  it("emits id-only records so the resume cursor can advance", () => {
    expect(parseSSEChunk("id: 11\n\n").frames).toEqual([{ id: "11" }]);
  });
});

describe("connectSSE", () => {
  const originalFetch = globalThis.fetch;

  function sseResponse(chunks: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
  }

  function storedEvent(seq: number, type: string): string {
    return JSON.stringify({ type, session_id: "s1", turn_id: "t1", seq, ts: seq });
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers events in order, ignores pings, and closes cleanly", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return sseResponse([
        ": ping\n\n",
        `id: 1\nevent: nyx\ndata: ${storedEvent(1, "turn.started")}\n\n`,
        `id: 2\nevent: nyx\ndata: ${storedEvent(2, "text.delta")}\n\n`,
      ]);
    }) as typeof fetch;

    const events: StoredEvent[] = [];
    let opened = 0;
    const connection = connectSSE({
      baseUrl: "http://127.0.0.1:8787",
      token: "secret-token",
      sessionId: "s1",
      fromSeq: 0,
      onEvent: (e) => events.push(e),
      onOpen: () => (opened += 1),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    connection.close();

    expect(opened).toBe(1);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(calls[0]).toBe("http://127.0.0.1:8787/v1/sessions/s1/events?from_seq=0");
  });

  it("sends the bearer token header", async () => {
    let authorization: string | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      authorization = headers?.["Authorization"];
      return sseResponse([]);
    }) as typeof fetch;

    const connection = connectSSE({
      baseUrl: "",
      token: "tok",
      sessionId: "s1",
      fromSeq: 0,
      onEvent: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    connection.close();
    expect(authorization).toBe("Bearer tok");
  });

  it("reconnects from the last seen seq after the stream drops", async () => {
    const urls: string[] = [];
    let call = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      call += 1;
      urls.push(String(input));
      if (call === 1) {
        return sseResponse([`id: 5\nevent: nyx\ndata: ${storedEvent(5, "turn.started")}\n\n`]);
      }
      return sseResponse([`id: 6\nevent: nyx\ndata: ${storedEvent(6, "turn.completed")}\n\n`]);
    }) as typeof fetch;

    const events: StoredEvent[] = [];
    const connection = connectSSE({
      baseUrl: "http://127.0.0.1:8787",
      token: "",
      sessionId: "s1",
      fromSeq: 4,
      onEvent: (e) => events.push(e),
    });

    // First connection delivers seq 5 and EOFs; backoff is 1s, then seq 6 arrives.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    connection.close();

    expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.completed"]);
    expect(urls).toEqual([
      "http://127.0.0.1:8787/v1/sessions/s1/events?from_seq=4",
      "http://127.0.0.1:8787/v1/sessions/s1/events?from_seq=5",
    ]);
  });

  it("skips duplicate events replayed at or below the resume cursor", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        `id: 3\nevent: nyx\ndata: ${storedEvent(3, "text.delta")}\n\n`,
        `id: 3\nevent: nyx\ndata: ${storedEvent(3, "text.delta")}\n\n`,
        `id: 4\nevent: nyx\ndata: ${storedEvent(4, "text.delta")}\n\n`,
      ])) as typeof fetch;

    const events: StoredEvent[] = [];
    const connection = connectSSE({
      baseUrl: "http://127.0.0.1:8787",
      token: "",
      sessionId: "s1",
      fromSeq: 2,
      onEvent: (e) => events.push(e),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    connection.close();
    expect(events.map((e) => e.seq)).toEqual([3, 4]);
  });
});
