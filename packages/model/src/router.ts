// SPDX-License-Identifier: AGPL-3.0-or-later
// Ordered-fallback model router: picks a provider chain per task, applies
// per-step overrides, falls back on retryable failures the chain opted into,
// and tracks per-session token budgets.

import type {
  BudgetStatus,
  CompletionRequest,
  Logger,
  ModelChunk,
  ModelInfo,
  ModelRouter,
  ProviderRegistry,
  RouteOptions,
  Usage,
} from "@nyx/protocol";
import { mergeUsage } from "@nyx/protocol";
import { ProviderError } from "./errors.js";
import { toSafeSerializedError } from "./redact.js";

/**
 * One hop in a route chain. `provider` must be a registered provider id;
 * `model` is the model id to request from it.
 */
export interface ChainStep {
  provider: string;
  model: string;
  reasoning_effort?: "low" | "high" | "max";
  max_tokens?: number;
  tool_choice?: "auto" | "none" | { name: string };
}

/** Error codes that trigger falling back to the next step (when retryable). */
export type FallbackCode = "rate_limit" | "server_error" | "timeout";

/** Task-tagged rule; matches RouteOptions.task. */
export interface RouteRule {
  task: string;
  chain: ChainStep[];
  fallback_on?: FallbackCode[];
}

/**
 * Router configuration. This interface is defined here (not imported from
 * @nyx/config) so that @nyx/config can structurally match it without a
 * dependency cycle: any object with these fields is accepted.
 */
export interface RouterConfig {
  default: { chain: ChainStep[]; fallback_on?: FallbackCode[] };
  rules?: RouteRule[];
}

/** Token budgets. Per-turn enforcement is the agent's job, not the router's. */
export interface RouterBudgets {
  per_turn_tokens: number;
  per_session_tokens: number;
  on_exceed: "ask" | "trim" | "abort";
}

const DEFAULT_FALLBACK_ON: FallbackCode[] = ["rate_limit", "server_error", "timeout"];

interface ResolvedRoute {
  chain: ChainStep[];
  fallbackOn: Set<string>;
}

export class ModelRouterImpl implements ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly config: RouterConfig;
  private readonly logger: Logger | undefined;
  private readonly budgets: RouterBudgets;
  private readonly sessionUsage = new Map<string, Usage>();

  constructor(
    registry: ProviderRegistry,
    config: RouterConfig,
    logger?: Logger,
    budgets?: RouterBudgets,
  ) {
    this.registry = registry;
    this.config = config;
    this.logger = logger;
    this.budgets = budgets ?? {
      per_turn_tokens: Number.POSITIVE_INFINITY,
      per_session_tokens: Number.POSITIVE_INFINITY,
      on_exceed: "abort",
    };
  }

  async *complete(
    req: CompletionRequest,
    opts?: RouteOptions,
  ): AsyncGenerator<ModelChunk, void, void> {
    const route = this.resolveRoute(opts?.task);
    const task = opts?.task ?? "default";
    let lastError: unknown;

    for (let i = 0; i < route.chain.length; i++) {
      const step = route.chain[i] as ChainStep;
      const provider = this.registry.get(step.provider);
      if (provider === undefined) {
        this.logger?.warn("route.fallback", {
          task,
          from: step.provider,
          to: route.chain[i + 1]?.provider ?? "(end)",
          code: "provider_missing",
        });
        continue;
      }

      const effective: CompletionRequest = {
        ...req,
        model: step.model,
        ...(step.reasoning_effort !== undefined ? { reasoning_effort: step.reasoning_effort } : {}),
        ...(step.max_tokens !== undefined ? { max_tokens: step.max_tokens } : {}),
        ...(step.tool_choice !== undefined ? { tool_choice: step.tool_choice } : {}),
      };

      this.logger?.info("route.selected", {
        task,
        provider: step.provider,
        model: step.model,
        attempt: i + 1,
      });

      try {
        for await (const chunk of provider.complete(effective)) {
          yield chunk;
        }
        return;
      } catch (err) {
        const ser = toSafeSerializedError(err);
        const code = ser.code ?? "provider_error";
        const retryable = ser.retryable ?? false;
        lastError = err;
        if (retryable && route.fallbackOn.has(code)) {
          this.logger?.warn("route.fallback", {
            task,
            from: step.provider,
            to: route.chain[i + 1]?.provider ?? "(end)",
            code,
          });
          continue;
        }
        throw err;
      }
    }

    if (lastError !== undefined) throw lastError;
    throw new ProviderError(`no provider in the "${task}" chain succeeded or was available`, {
      code: "provider_error",
      retryable: false,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const results = await Promise.allSettled(this.registry.list().map((p) => p.listModels()));
    const out: ModelInfo[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        out.push(...result.value);
      } else {
        const provider = this.registry.list()[i];
        this.logger?.warn("route.list_models_failed", {
          provider: provider?.id ?? "unknown",
          message: toSafeSerializedError(result.reason).message,
        });
      }
    });
    return out;
  }

  recordUsage(session_id: string, usage: Usage): void {
    const current = this.sessionUsage.get(session_id);
    this.sessionUsage.set(session_id, mergeUsage(current, usage));
  }

  checkBudget(session_id: string): BudgetStatus {
    const used = this.sessionUsage.get(session_id) ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    const total =
      used.total_tokens ?? used.input_tokens + used.output_tokens + (used.reasoning_tokens ?? 0);
    return {
      exceeded: total > this.budgets.per_session_tokens,
      used: total,
      limit: this.budgets.per_session_tokens,
      on_exceed: this.budgets.on_exceed,
    };
  }

  private resolveRoute(task: string | undefined): ResolvedRoute {
    const rule = task !== undefined ? this.config.rules?.find((r) => r.task === task) : undefined;
    const chosen = rule ?? this.config.default;
    return {
      chain: chosen.chain,
      fallbackOn: new Set(chosen.fallback_on ?? DEFAULT_FALLBACK_ON),
    };
  }
}
