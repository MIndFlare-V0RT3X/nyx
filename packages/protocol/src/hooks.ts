// SPDX-License-Identifier: AGPL-3.0-or-later
// The four-hook surface — the entire editable behavioral surface of the
// harness. A hook never executes an environment action: it returns a
// structured effect and the kernel interprets it.

import type { ActionRequest } from "./policy.js";
import type { RecoveryHint, SerializedError } from "./util.js";
import type { ToolOutput } from "./tools.js";
import type { RunContext } from "./agent.js";
import type { PromptSection } from "./util.js";
import type { Message } from "./content.js";

export type ActionDecision =
  | { kind: "allow" }
  | { kind: "rewrite"; action: ActionRequest; reason: string }
  | { kind: "veto"; reason: string }
  | { kind: "ask"; summary: string };

export interface InitContext {
  session_id: string;
  turn_id: string;
  sections: PromptSection[];
  messages: Message[];
  facts: Record<string, unknown>;
}

export interface HookMap {
  "context.initialize": (ctx: InitContext) => Promise<Partial<InitContext> | void>;
  "action.before": (action: ActionRequest, ctx: RunContext) => Promise<ActionDecision | void>;
  "action.after": (result: ToolOutput, action: ActionRequest, ctx: RunContext) => Promise<void>;
  "feedback.recover": (error: SerializedError, ctx: RunContext) => Promise<RecoveryHint | null>;
}

export type HookName = keyof HookMap;

/**
 * Priority-ordered hook bus. `on` returns an unsubscribe function. `emit`
 * returns every hook's result in priority order (highest priority first);
 * void results are preserved as undefined entries.
 */
export interface HookBus {
  on<K extends HookName>(
    name: K,
    fn: HookMap[K],
    opts?: { priority?: number; plugin?: string },
  ): () => void;
  emit<K extends HookName>(
    name: K,
    ...args: Parameters<HookMap[K]>
  ): Promise<Array<Awaited<ReturnType<HookMap[K]>>>>;
}
