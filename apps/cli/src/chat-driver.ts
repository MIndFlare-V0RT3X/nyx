// SPDX-License-Identifier: AGPL-3.0-or-later
// The headless chat driver: owns the ChatState, drives turns through the
// local runtime, resolves approvals, and notifies subscribers. The Ink view
// subscribes to exactly this object; the tests drive exactly this object —
// one code path for terminal and harness (ink 5.x ships no testing-library,
// so the TUI is tested through this driver without a terminal).

import { nanoid } from "nanoid";
import type { ApprovalRecord, SessionEvent, SessionMeta } from "@nyx/protocol";
import type { LocalRuntime } from "./local.js";
import {
  applyApprovalRecord,
  applyEventToChat,
  handleApprovalKey,
  initialChatState,
  moveApprovalSelection,
  submitChatInput,
  type ChatState,
} from "./chat-state.js";

export interface ChatDriverDeps {
  runtime: LocalRuntime;
  session: SessionMeta;
}

export interface ChatDriver {
  getState(): ChatState;
  subscribe(fn: () => void): () => void;
  /** The raw input-box buffer. */
  setInput(text: string): void;
  /** Submit the current input line (slash commands handled locally). */
  submit(): void;
  /** Submit an explicit line — the headless harness path. */
  submitLine(line: string): void;
  /** y/n on the selected approval. */
  approvalKey(key: "y" | "n"): void;
  /** Cycle the approval-modal selection. */
  moveSelection(delta: 1 | -1): void;
  /** Approval-lifecycle wake-up (wired to the runtime's engine callbacks). */
  onApprovalEvent(event: SessionEvent, record: ApprovalRecord): void;
  /** Stop: aborts an in-flight turn and marks the session exited. */
  requestExit(): void;
  /** Resolves when no turn is in flight. */
  idle(): Promise<void>;
}

export function createChatDriver(deps: ChatDriverDeps): ChatDriver {
  const { runtime } = deps;
  let state = initialChatState(deps.session);
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const update = (next: ChatState): void => {
    state = next;
    notify();
  };

  const driveTurn = (text: string): Promise<void> => {
    const turn_id = nanoid(12);
    update({ ...state, running: true, notice: null });
    const turn = runtime
      .runTurn(
        { session_id: state.session_id, turn_id, content: [{ type: "text", text }] },
        (event) => {
          update(applyEventToChat(state, event));
        },
      )
      .then((result) => {
        // Surface-level failures (missing persona, broken service) never
        // reach the event stream; render them as the turn's error line.
        if (result.error !== null) {
          update(applyEventToChat(state, {
            type: "turn.failed",
            session_id: state.session_id,
            turn_id,
            error: result.error,
            ts: Date.now(),
          }));
        }
      })
      .finally(() => {
        update({ ...state, running: false });
      });
    inFlight = turn;
    return turn;
  };

  const doSubmit = (line: string): void => {
    if (state.exit_requested) return;
    if (state.running) {
      update({ ...state, input: "", notice: "a turn is already running — wait for it to finish" });
      return;
    }
    const result = submitChatInput(state, line);
    update(result.state);
    if (result.action === "exit") {
      runtime.abortSession(state.session_id);
      return;
    }
    if (result.action === "send") {
      void driveTurn(result.text);
    }
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setInput: (text) => update({ ...state, input: text }),
    submit: () => doSubmit(state.input),
    submitLine: (line) => doSubmit(line),
    approvalKey(key) {
      const result = handleApprovalKey(state, key);
      if (result.resolve === undefined) {
        update(result.state);
        return;
      }
      update(result.state);
      void runtime
        .resolveApproval(result.resolve.id, result.resolve.decision)
        .catch((err) => {
          update({
            ...state,
            notice: `approval ${result.resolve?.id ?? "?"} could not be resolved: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        });
    },
    moveSelection: (delta) => update(moveApprovalSelection(state, delta)),
    onApprovalEvent(event, record) {
      if (event.type === "approval.requested") {
        update(applyApprovalRecord(state, record));
        return;
      }
      if (event.type === "approval.resolved") {
        update(applyEventToChat(state, event));
      }
    },
    requestExit() {
      update({ ...state, exit_requested: true, input: "", notice: null });
      runtime.abortSession(state.session_id);
    },
    async idle() {
      while (inFlight !== undefined) {
        const current = inFlight;
        await current.catch(() => undefined);
        // A submit during the await replaced inFlight — keep waiting for it.
        if (inFlight === current) return;
      }
    },
  };
}
