// SPDX-License-Identifier: AGPL-3.0-or-later
// Hand-rolled SSE consumer. `EventSource` cannot send an Authorization header,
// so the stream is consumed with fetch + ReadableStream: records are parsed
// incrementally (parseSSEChunk), events are deduped by seq, and a dropped
// connection is resumed from the last seen seq with 1s/2s/5s backoff.

import { toApiError } from "./api.js";
import type { StoredEvent } from "./types.js";

export interface SSEFrame {
  id?: string;
  event?: string;
  data?: string;
}

const FRAME_TERMINATOR = "\n\n";

/**
 * Incremental SSE parser: extracts every complete record from `buffer` and
 * returns the unfinished tail. Tolerates CRLF and lone-CR line endings and
 * ignores comment lines (`: ping`). Multiple `data:` lines join with "\n"
 * (WHATWG server-sent events).
 */
export function parseSSEChunk(buffer: string): { frames: SSEFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n|\r/g, "\n");
  const frames: SSEFrame[] = [];
  let start = 0;
  for (;;) {
    const end = normalized.indexOf(FRAME_TERMINATOR, start);
    if (end === -1) break;
    const frame = parseRecord(normalized.slice(start, end));
    if (frame !== null) frames.push(frame);
    start = end + FRAME_TERMINATOR.length;
  }
  return { frames, rest: normalized.slice(start) };
}

function parseRecord(record: string): SSEFrame | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of record.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (id === undefined && event === undefined && dataLines.length === 0) return null;
  return { ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}) };
}

export interface ConnectSSEOptions {
  baseUrl: string;
  token: string;
  sessionId: string;
  /** Last seq the caller already has; the stream resumes strictly after it. */
  fromSeq: number;
  onEvent: (event: StoredEvent) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
}

export interface SSEConnection {
  close: () => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000];
/** The server's SSE event name; anything else on the wire is not for us. */
const SSE_EVENT_NAME = "nyx";

export function connectSSE(opts: ConnectSSEOptions): SSEConnection {
  const controller = new AbortController();
  let closed = false;
  let lastSeq = opts.fromSeq;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const deliver = (frame: SSEFrame): void => {
    if (frame.data !== undefined && (frame.event === undefined || frame.event === SSE_EVENT_NAME)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch (err) {
        opts.onError?.(new Error(`malformed SSE data: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const event = parsed as StoredEvent;
      if (typeof event?.seq !== "number" || typeof event?.type !== "string") {
        opts.onError?.(new Error("SSE event missing seq or type"));
        return;
      }
      if (event.seq <= lastSeq) return; // duplicate replay after a reconnect
      lastSeq = event.seq;
      opts.onEvent(event);
      return;
    }
    // id-only record (or a foreign event): still advance the resume cursor.
    const idSeq = Number(frame.id);
    if (frame.id !== undefined && Number.isFinite(idSeq) && idSeq > lastSeq) lastSeq = idSeq;
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!closed) {
      try {
        const url = `${opts.baseUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/events?from_seq=${lastSeq}`;
        const res = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...(opts.token !== "" ? { Authorization: `Bearer ${opts.token}` } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok) throw await toApiError(res);
        if (res.body === null) throw new Error("SSE response has no body");
        attempt = 0;
        opts.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSSEChunk(buffer);
          buffer = rest;
          for (const frame of frames) deliver(frame);
        }
        buffer += decoder.decode();
        // EOF without close(): the server dropped the connection — resume.
        throw new Error("SSE stream ended");
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        opts.onError?.(err);
      }
      if (closed) return;
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
      attempt += 1;
    }
  };

  void run();

  return {
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
