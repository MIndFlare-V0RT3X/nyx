// SPDX-License-Identifier: AGPL-3.0-or-later
// The live session view: projection bootstrap + SSE folding, streaming
// timeline, approval panel, composer, usage footer.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "../api.js";
import {
  foldApprovals,
  foldEvent,
  initialViewState,
  stateFromProjection,
  type SessionEventViewState,
} from "../events.js";
import { connectSSE } from "../sse.js";
import { MessageBubble } from "../components/MessageBubble.js";
import { ApprovalPanel } from "../components/ApprovalPanel.js";
import { UsageFooter } from "../components/UsageFooter.js";
import type { ApprovalRecord, StoredEvent } from "../types.js";

type Action =
  | { type: "seed"; state: SessionEventViewState }
  | { type: "event"; event: StoredEvent }
  | { type: "approvals"; records: ApprovalRecord[] };

function reducer(state: SessionEventViewState, action: Action): SessionEventViewState {
  switch (action.type) {
    case "seed":
      return action.state;
    case "event":
      return foldEvent(state, action.event);
    case "approvals":
      return foldApprovals(state, action.records);
  }
}

export function SessionView(props: {
  client: ApiClient;
  sessionId: string;
  onBack(): void;
}): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialViewState());
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef(0);

  // Bootstrap: the projection snapshot seeds the view state, and its
  // last_seq becomes the SSE resume cursor.
  const detail = useQuery({
    queryKey: ["session", props.sessionId, props.client.baseUrl, props.client.token],
    queryFn: () => props.client.getSession(props.sessionId),
  });

  useEffect(() => {
    if (!detail.isSuccess) return;
    const seeded = stateFromProjection(props.sessionId, detail.data.projection);
    lastSeqRef.current = seeded.lastSeq;
    dispatch({ type: "seed", state: seeded });
    setReady(true);
  }, [detail.isSuccess, detail.data, props.sessionId]);

  // Live tail: fold SSE events; reconnects resume from the highest folded seq.
  useEffect(() => {
    if (!ready) return;
    const connection = connectSSE({
      baseUrl: props.client.baseUrl,
      token: props.client.token,
      sessionId: props.sessionId,
      fromSeq: lastSeqRef.current,
      onEvent: (event) => {
        if (event.seq > lastSeqRef.current) lastSeqRef.current = event.seq;
        dispatch({ type: "event", event });
      },
    });
    return () => connection.close();
  }, [ready, props.client.baseUrl, props.client.token, props.sessionId]);

  // Initial pending approvals (new ones arrive as SSE events).
  useEffect(() => {
    if (!ready) return;
    void props.client
      .listApprovals(props.sessionId)
      .then((records) => dispatch({ type: "approvals", records }))
      .catch(() => undefined);
  }, [ready, props.client, props.sessionId]);

  const pendingApprovals = useMemo(
    () => state.pendingApprovals.map((id) => state.approvals[id]).filter((a) => a !== undefined),
    [state.pendingApprovals, state.approvals],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.items.length, state.turnActive]);

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await props.client.postTurn(props.sessionId, { text });
      setDraft("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, sending, props.client, props.sessionId]);

  return (
    <section className="session-view">
      <header className="session-head">
        <button className="ghost" onClick={props.onBack}>
          ← sessions
        </button>
        <span className="mono dim">{props.sessionId}</span>
        {detail.data !== undefined && detail.data.session.engagement !== null && (
          <span className="badge scope">{detail.data.session.engagement.id}</span>
        )}
      </header>

      <div className="timeline">
        {state.items.map((item) => {
          switch (item.kind) {
            case "message":
              return (
                <MessageBubble
                  key={item.id}
                  role={item.role}
                  content={item.content}
                  toolCards={state.toolCards}
                />
              );
            case "streaming":
              return (
                <div key={item.id} className="bubble assistant streaming">
                  {item.reasoning !== "" && <p className="dim reasoning-live">thinking…</p>}
                  <p className="msg-text">{item.text}</p>
                </div>
              );
            case "tool": {
              const card = state.toolCards[item.callId];
              return (
                <div key={item.id} className={`toolcard slim ${card?.status ?? "pending"}`}>
                  <span className="tool-name">⚙ {card?.name ?? item.callId}</span>
                  <span className={`status status-${card?.status ?? "pending"}`}>
                    {card?.status ?? "pending"}
                  </span>
                </div>
              );
            }
            case "denial":
              return (
                <p key={item.id} className="denial-line">
                  denied ({item.reason}): {item.detail}
                </p>
              );
            case "approval": {
              const approval = state.approvals[item.approvalId];
              if (approval === undefined) return null;
              return (
                <p key={item.id} className="approval-line">
                  approval {approval.risk} — {approval.decision}
                  {approval.decidedBy !== null && <> by {approval.decidedBy}</>}
                </p>
              );
            }
            case "turn-error":
              return (
                <p key={item.id} className="inline-error">
                  turn failed: {item.error.message}
                </p>
              );
            default:
              return null;
          }
        })}
        <div ref={bottomRef} />
      </div>

      <ApprovalPanel
        client={props.client}
        approvals={pendingApprovals}
        onResolved={() => undefined}
      />
      <UsageFooter usage={state.usage} turnActive={state.turnActive} />

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          placeholder={state.turnActive ? "turn in progress…" : "message…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={sending || draft.trim() === ""}>
          send
        </button>
      </form>
      {sendError !== null && <p className="inline-error">{sendError}</p>}
    </section>
  );
}
