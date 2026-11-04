// SPDX-License-Identifier: AGPL-3.0-or-later
// The agent loop: the single dependency-injected turn engine every surface
// (server, CLI, SDK) drives. No service is constructed inside the loop —
// everything arrives through RunContext, and tool execution is delegated to
// the kernel's "tools.runtime" service. Every event the turn produces is
// appended to the session store BEFORE it is yielded: the store is the source
// of truth, the iterator is a live ordered view of it.
//
// The numbered comments below mirror the loop-sequence contract 1:1; that
// sequence is the e2e contract shared with every surface.

import { mergeUsage, SECTION_ORDER, toSerializedError } from "@nyx/protocol";
import type {
  ActionDecision,
  ActionRequest,
  AgentLoop,
  CompletionRequest,
  ContentBlock,
  InitContext,
  Logger,
  Message,
  PromptSection,
  RecoveryHint,
  RunContext,
  RunInput,
  SerializedError,
  SessionEvent,
  ToolCall,
  ToolOutput,
  Usage,
} from "@nyx/protocol";
import { elideMessages, estimateTokens } from "./compaction.js";
import { AgentError } from "./errors.js";
import { denialToolOutput, wrapToolOutput } from "./tool-runtime.js";
import type { ToolRuntimeExecuteContext, ToolRuntimeService } from "./tool-runtime.js";

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_COMPACTION_BUDGET_TOKENS = 100_000;
/** Elision stops once the estimate fits this fraction of the budget. */
const ELISION_TARGET_FRACTION = 0.8;
const TOOL_RUNTIME_SERVICE = "tools.runtime";

/** Tool calls accumulated from tool_call.delta chunks, keyed by stream index. */
interface AccumulatedCall {
  call_id?: string;
  name?: string;
  args: string;
}

interface StreamResult {
  text: string;
  toolCalls: Array<{ call_id: string; name: string; input: unknown }>;
  finishReason: "stop" | "tool_calls" | "length";
}

export class AgentLoopImpl implements AgentLoop {
  async *run(input: RunInput, ctx: RunContext): AsyncGenerator<SessionEvent, void, unknown> {
    // -- loop start: resolve the tool runtime (typed failure, no events) --
    const runtime = ctx.kernel.services.get<ToolRuntimeService>(TOOL_RUNTIME_SERVICE);
    if (runtime === undefined) {
      throw new AgentError(
        "not_implemented",
        `no "${TOOL_RUNTIME_SERVICE}" service registered on the kernel: surfaces must register the tool runtime (@nyx/tools ToolRuntime) as kernel service "${TOOL_RUNTIME_SERVICE}" before driving the agent loop`,
      );
    }

    // -- event pump: append-before-yield; the runtime's emit routes in here too --
    const queue: SessionEvent[] = [];
    const emit = (e: SessionEvent): void => {
      queue.push(e);
    };
    async function* flush(): AsyncGenerator<SessionEvent, void, unknown> {
      while (queue.length > 0) {
        const e = queue.shift()!;
        await ctx.session.append(input.session_id, [e]);
        yield e;
      }
    }

    // -- 1. pre-aborted turn: fail before anything else happens --
    if (ctx.signal.aborted) {
      emit({
        type: "turn.failed",
        session_id: input.session_id,
        turn_id: input.turn_id,
        error: {
          name: "AbortError",
          message: `turn ${input.turn_id} aborted before start`,
          code: "aborted",
        },
        ts: Date.now(),
      });
      yield* flush();
      return;
    }

    // -- 2. the session must exist (typed failure, no events) --
    const meta = await ctx.session.meta(input.session_id);
    if (meta === null) {
      throw new AgentError("not_found", `session ${input.session_id} not found`);
    }

    // Usage accumulated across every model call of this turn (including a
    // failed attempt's partial usage — those tokens were spent).
    const usageAcc: { value: Usage } = { value: mergeUsage() };
    const emitCompleted = (): void => {
      ctx.model.recordUsage(input.session_id, usageAcc.value);
      emit({
        type: "turn.completed",
        session_id: input.session_id,
        turn_id: input.turn_id,
        usage: usageAcc.value,
        ts: Date.now(),
      });
    };
    const emitFailed = (error: SerializedError): void => {
      ctx.model.recordUsage(input.session_id, usageAcc.value);
      emit({
        type: "turn.failed",
        session_id: input.session_id,
        turn_id: input.turn_id,
        error,
        ts: Date.now(),
      });
    };

    try {
      // -- 3. init context: persona sections, pre-turn history, catalogs --
      const projection = await ctx.session.projection(input.session_id);
      const memories = await ctx.memory.list({ limit: 50 });
      const sections = ctx.persona.buildSystemPrompt({
        session_facts: {
          date: new Date().toISOString(),
          sandbox_id: ctx.sandbox.id,
          engagement: meta.engagement,
        },
        memory_catalog: memories.map((m) => ({
          id: m.id,
          title: (m.content.split("\n")[0] ?? "").slice(0, 80),
          path: "",
        })),
        skills_catalog: [],
        tools_catalog: ctx.tools
          .list()
          .map((d) => ({ name: d.name, risk: d.risk, description: d.description })),
      });
      const initCtx: InitContext = {
        session_id: input.session_id,
        turn_id: input.turn_id,
        sections,
        // History only: the projection is read BEFORE this turn's user message
        // is appended, so it cannot contain any of this turn's events.
        messages: projection.messages,
        facts: {},
      };

      // -- 4. context.initialize hooks: merge every non-void partial, in result order --
      const initResults = await ctx.kernel.hooks.emit("context.initialize", initCtx);
      for (const partial of initResults) {
        if (partial === undefined || partial === null) continue;
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(partial)) {
          if (value !== undefined) patch[key] = value;
        }
        Object.assign(initCtx, patch);
      }

      // -- 5. the turn opens on the record --
      emit({
        type: "turn.started",
        session_id: input.session_id,
        turn_id: input.turn_id,
        ts: Date.now(),
      });
      yield* flush();
      emit({
        type: "message.user",
        session_id: input.session_id,
        turn_id: input.turn_id,
        content: input.user_message.content,
        ts: Date.now(),
      });
      yield* flush();

      // -- 6. model message list: one system block per section (SECTION_ORDER),
      //       then the (possibly hook-rewritten) history, then the user message --
      const messages: Message[] = [];
      for (const id of SECTION_ORDER) {
        for (const section of initCtx.sections) {
          if (section.id === id) messages.push(sectionMessage(section));
        }
      }
      messages.push(...initCtx.messages);
      messages.push({ role: "user", content: input.user_message.content });

      // -- 7. compaction (rule-based elision) + router budget check --
      const budget = ctx.options?.compaction_budget_tokens ?? DEFAULT_COMPACTION_BUDGET_TOKENS;
      const budgetStatus = ctx.model.checkBudget(input.session_id);
      const estimateTriggered = estimateTokens(messages) > budget;
      const routerTriggered = budgetStatus.exceeded && budgetStatus.on_exceed !== "abort";
      if (estimateTriggered || routerTriggered) {
        emit({
          type: "compaction.started",
          session_id: input.session_id,
          turn_id: input.turn_id,
          strategy: "rule-elision",
          ts: Date.now(),
        });
        yield* flush();
        const elision = elideMessages(messages, Math.floor(budget * ELISION_TARGET_FRACTION));
        messages.splice(0, messages.length, ...elision.messages);
        emit({
          type: "compaction.completed",
          session_id: input.session_id,
          turn_id: input.turn_id,
          strategy: "rule-elision",
          freed_tokens: elision.freedTokens,
          ts: Date.now(),
        });
        yield* flush();
      }
      if (budgetStatus.exceeded && budgetStatus.on_exceed === "abort") {
        emitFailed({
          name: "BudgetExceededError",
          message: `session token budget exceeded: ${budgetStatus.used} of ${budgetStatus.limit} tokens used`,
          code: "budget_exceeded",
        });
        yield* flush();
        return;
      }

      // -- 8–11. model ↔ tool rounds --
      const tools = ctx.tools
        .list()
        .map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
      const maxRounds = ctx.options?.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS;
      let dispatchedRounds = 0;
      let recoveriesUsed = 0;

      // Streams one model call: emits text/reasoning deltas through the pump
      // as they arrive, accumulates tool_call.delta fragments, merges usage.
      const streamModel = async function* (
        request: CompletionRequest,
      ): AsyncGenerator<SessionEvent, StreamResult, unknown> {
        let text = "";
        const calls: Record<number, AccumulatedCall> = {};
        let finishReason: StreamResult["finishReason"] | undefined;

        for await (const chunk of ctx.model.complete(request)) {
          switch (chunk.type) {
            case "text.delta": {
              text += chunk.text;
              emit({
                type: "text.delta",
                session_id: input.session_id,
                turn_id: input.turn_id,
                text: chunk.text,
                ts: Date.now(),
              });
              break;
            }
            case "reasoning.delta": {
              emit({
                type: "reasoning.delta",
                session_id: input.session_id,
                turn_id: input.turn_id,
                text: chunk.text,
                ts: Date.now(),
              });
              break;
            }
            case "tool_call.delta": {
              const slot = calls[chunk.index] ?? (calls[chunk.index] = { args: "" });
              if (chunk.id !== undefined) slot.call_id = chunk.id;
              if (chunk.name !== undefined) slot.name = chunk.name;
              slot.args += chunk.arguments_delta ?? "";
              break;
            }
            case "usage": {
              usageAcc.value = mergeUsage(usageAcc.value, chunk.usage);
              break;
            }
            case "done": {
              if (chunk.finish_reason === "error") {
                // A provider ending its stream with an error finish instead of
                // throwing: route it through recovery like a thrown failure.
                throw new AgentError(
                  "provider_error",
                  'model stream ended with finish_reason "error"',
                );
              }
              finishReason = chunk.finish_reason;
              break;
            }
          }
          yield* flush();
        }

        if (finishReason === undefined) {
          ctx.logger.warn("agent.stream_without_done", { turn_id: input.turn_id });
          finishReason = "stop";
        }

        const toolCalls = Object.keys(calls)
          .map((key) => Number(key))
          .sort((a, b) => a - b)
          .flatMap((index) => {
            const slot = calls[index]!;
            if (slot.name === undefined) {
              ctx.logger.warn("agent.tool_call_without_name", { turn_id: input.turn_id, index });
              return [];
            }
            return [
              {
                call_id: slot.call_id ?? `call_${index}`,
                name: slot.name,
                input: parseToolArguments(slot.args, ctx.logger, input.turn_id),
              },
            ];
          });

        return { text, toolCalls, finishReason };
      };

      for (;;) {
        // 2.0.2: an abort that lands between rounds (e.g. DELETE
        // /v1/sessions/:id/turns while the turn waits on an approval or a
        // tool) must still end the turn on the record — the next model call
        // must never fire for an aborted turn.
        if (ctx.signal.aborted) {
          emitFailed({
            name: "AbortError",
            message: `turn ${input.turn_id} aborted`,
            code: "aborted",
          });
          yield* flush();
          return;
        }
        const request: CompletionRequest = {
          model: "auto", // the router substitutes the routed model from its chain
          messages,
          tools,
          signal: ctx.signal,
        };

        let stream: StreamResult;
        try {
          stream = yield* streamModel(request);
        } catch (err) {
          // -- 12. error recovery: model-stream failures only (tool failures
          //        come back as outputs). One retry per TURN, never a third attempt.
          if (ctx.signal.aborted) {
            emitFailed({ ...toSerializedError(err), code: "aborted" });
            yield* flush();
            return;
          }
          if (recoveriesUsed >= 1) {
            emitFailed(toSerializedError(err));
            yield* flush();
            return;
          }
          let hint: RecoveryHint | null = null;
          try {
            const results = await ctx.kernel.hooks.emit(
              "feedback.recover",
              toSerializedError(err),
              ctx,
            );
            hint = results.find((r): r is RecoveryHint => r !== null && r !== undefined) ?? null;
          } catch (hookErr) {
            // A crashing recovery hook must not mask the original failure.
            ctx.logger.warn("agent.recover_hook_failed", { error: toSerializedError(hookErr) });
          }
          if (hint === null || hint.strategy !== "retry") {
            emitFailed(toSerializedError(err));
            yield* flush();
            return;
          }
          recoveriesUsed += 1;
          messages.push({
            role: "system",
            content: [{ type: "text", text: `recovery hint: ${hint.note}` }],
          });
          continue; // retry the model call ONCE
        }

        // -- 9. the assistant message (text first, then tool_use blocks) --
        const assistantMessage: Message = {
          role: "assistant",
          content: assistantContent(stream),
        };
        if (assistantMessage.content.length > 0) {
          emit({
            type: "message.assistant",
            session_id: input.session_id,
            turn_id: input.turn_id,
            content: assistantMessage.content,
            ts: Date.now(),
          });
          yield* flush();
        }

        if (stream.finishReason !== "tool_calls" || stream.toolCalls.length === 0) {
          // stop | length, or a degenerate tool_calls finish with no usable call
          if (stream.finishReason === "tool_calls") {
            ctx.logger.warn("agent.tool_calls_without_calls", { turn_id: input.turn_id });
          }
          emitCompleted();
          yield* flush();
          return;
        }

        if (dispatchedRounds >= maxRounds) {
          // Round budget exhausted: do NOT dispatch; complete the turn as-is.
          emitCompleted();
          yield* flush();
          return;
        }

        // -- 10. dispatch every tool call, in order --
        const toolResults: ContentBlock[] = [];
        for (const call of stream.toolCalls) {
          // a. action request from the curated definition (unknown tool → R3, no caps)
          const def = ctx.tools.get(call.name)?.def;
          const action: ActionRequest = {
            session_id: input.session_id,
            turn_id: input.turn_id,
            tool: call.name,
            input: call.input,
            risk: def?.risk ?? "R3",
            capabilities: def?.capabilities ?? [],
            actor_id: "agent",
          };

          // b. action.before hooks — veto > rewrite > ask; first of each kind wins
          const rawDecisions = await ctx.kernel.hooks.emit("action.before", action, ctx);
          const decisions: Array<ActionDecision | undefined> = rawDecisions.map((d) =>
            typeof d === "object" && d !== null ? (d as ActionDecision) : undefined,
          );
          const veto = decisions.find(isDecisionOf("veto"));
          if (veto !== undefined) {
            const detail = `vetoed by hook: ${veto.reason}`;
            emit({
              type: "action.denied",
              session_id: input.session_id,
              turn_id: input.turn_id,
              call_id: call.call_id,
              reason: "policy",
              detail,
              ts: Date.now(),
            });
            yield* flush();
            toolResults.push({
              type: "tool_result",
              call_id: call.call_id,
              output: denialToolOutput(detail),
            });
            continue; // no execution, no action.after
          }
          const rewrite = decisions.find(isDecisionOf("rewrite"));
          const effectiveCall: ToolCall =
            rewrite !== undefined
              ? { call_id: call.call_id, name: rewrite.action.tool, input: rewrite.action.input }
              : { call_id: call.call_id, name: call.name, input: call.input };
          const effectiveAction = rewrite !== undefined ? rewrite.action : action;
          const forceAsk = decisions.some((d) => d !== undefined && d.kind === "ask");

          // c. execute via the tool runtime — it emits tool.call/tool.result/
          //    tool.error/action.denied into the pump itself
          const runtimeCtx: ToolRuntimeExecuteContext = {
            session_id: input.session_id,
            turn_id: input.turn_id,
            engagement: meta.engagement,
            sandbox: ctx.sandbox,
            signal: ctx.signal,
            logger: ctx.logger,
            emit,
          };
          let output: ToolOutput;
          try {
            output = await runtime.execute(
              effectiveCall,
              runtimeCtx,
              forceAsk ? { force_ask: true } : undefined,
            );
          } catch (err) {
            // The runtime is contractually expected to contain tool failures;
            // a thrown error is a runtime defect — surface it and keep the turn.
            const ser = toSerializedError(err);
            emit({
              type: "tool.error",
              session_id: input.session_id,
              turn_id: input.turn_id,
              call_id: effectiveCall.call_id,
              error: ser,
              ts: Date.now(),
            });
            output = { kind: "text", text: `tool failed: ${ser.message}` };
          }
          yield* flush();

          // d. action.after hooks: observability only — never fail the turn
          try {
            await ctx.kernel.hooks.emit("action.after", output, effectiveAction, ctx);
          } catch (hookErr) {
            ctx.logger.warn("agent.action_after_hook_failed", {
              error: toSerializedError(hookErr),
              tool: effectiveCall.name,
            });
          }

          // e. model-facing tool_result: untrusted-data framing
          toolResults.push({
            type: "tool_result",
            call_id: call.call_id,
            output: wrapToolOutput(output),
          });
        }

        messages.push(assistantMessage);
        if (toolResults.length > 0) {
          messages.push({ role: "tool", content: toolResults });
        }
        dispatchedRounds += 1;
        // continue at step 8
      }
    } catch (err) {
      // Any non-model-stream failure (store, persona, hook crash): the turn
      // ends on the record; nothing is swallowed.
      emitFailed(toSerializedError(err));
      yield* flush();
    }
  }
}

/** The single loop constructor surfaces use. */
export function createAgentLoop(): AgentLoop {
  return new AgentLoopImpl();
}

function sectionMessage(section: PromptSection): Message {
  return {
    role: "system",
    content: [{ type: "text", text: `${section.title}\n\n${section.body}`.trim() }],
  };
}

function assistantContent(stream: StreamResult): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (stream.text.length > 0) {
    content.push({ type: "text", text: stream.text });
  }
  for (const call of stream.toolCalls) {
    content.push({ type: "tool_use", call_id: call.call_id, name: call.name, input: call.input });
  }
  return content;
}

function parseToolArguments(args: string, logger: Logger, turnId: string): unknown {
  if (args.trim() === "") return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    logger.warn("agent.tool_arguments_unparseable", { turn_id: turnId });
    return {};
  }
}

function isDecisionOf<K extends ActionDecision["kind"]>(
  kind: K,
): (d: ActionDecision | undefined) => d is Extract<ActionDecision, { kind: K }> {
  return (d): d is Extract<ActionDecision, { kind: K }> => d !== undefined && d.kind === kind;
}
