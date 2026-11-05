// SPDX-License-Identifier: AGPL-3.0-or-later
// The behavioral-eval runner (Phase 7.4). Each eval is a YAML spec:
// setup (a scripted mock provider, tools, policy, seeded history) + input +
// ASSERTIONS ON THE SESSION EVENT LOG (never the final text — an eval that
// only checks the reply is not an eval). The runner executes the spec
// against REAL components (real loop, real runtime, real store) and
// produces pass/fail + a trajectory (the event sequence).
//
// Regression gate: baseline.json records each eval's pass/fail; any change
// fails CI until --eval-update (EVAL_UPDATE=1) regenerates it with a diff.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { SessionEvent } from "@nyx/protocol";
import { runLoopEval, type LoopSetup } from "./rig.js";
import {
  runCveCorrelationEval,
  runDisclosureEval,
  runOwnershipEval,
  runRateLimitEval,
  type CveCorrelationResult,
  type CveCorrelationSetup,
  type DisclosureResult,
  type DisclosureSetup,
  type OwnershipResult,
  type OwnershipSetup,
  type RateLimitResult,
  type RateLimitSetup,
} from "./specialized.js";

export const EVALS_DIR = fileURLToPath(new URL("../evals", import.meta.url));
export const BASELINE_FILE = fileURLToPath(new URL("../baseline.json", import.meta.url));

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export interface AssertionSpec {
  assert:
    | "event_present"
    | "event_absent"
    | "event_order"
    | "event_count"
    | "event_field"
    | "final_event"
    | "no_error_events"
    | "memory_written"
    | "elapsed_at_least"
    | "cves_include"
    | "confidence_is"
    | "finding_cve_updated"
    | "audit_row"
    | "hashes_match"
    | "refused"
    | "refusal_code";
  event?: string;
  events?: string[];
  field?: string;
  equals?: string;
  contains?: string;
  exactly?: number;
  at_least?: number;
  cve?: string;
  confidence?: string;
  action?: string;
  contains_text?: string;
  min_elapsed_ms?: number;
  code?: string;
}

export interface EvalSpec {
  name: string;
  description: string;
  kind: "loop" | "rate_limit" | "cve_correlation" | "disclosure_integrity" | "ownership_refusal";
  setup: unknown;
  input?: { user_message?: string };
  assertions: AssertionSpec[];
  expected_cost_ceiling?: { input_tokens?: number; output_tokens?: number };
}

export interface EvalOutcome {
  name: string;
  description: string;
  pass: boolean;
  failures: string[];
  /** The observable trajectory: the session event types, in order. */
  trajectory: string[];
  /** The trajectory's event-type histogram — the drift gate's key. Order
   *  sensitivity lives in each eval's own event_order assertions (which
   *  encode exactly which order matters); the histogram catches structural
   *  drift (an event type appearing or vanishing) without racing on
   *  interleavings that are legitimately load-dependent (mirrored
   *  subagent events vs the loop's pump flush). */
  histogram: string[];
  /** Usage vs the ceiling, when declared. */
  cost?: { input_tokens: number; output_tokens: number; within_ceiling: boolean };
}

// ---------------------------------------------------------------------------
// Assertion engine (loop evals: the event log is the surface)
// ---------------------------------------------------------------------------

function eventField(event: SessionEvent, field: string): unknown {
  const record = event as unknown as Record<string, unknown>;
  return record[field];
}

function evaluateLoopAssertions(
  assertions: AssertionSpec[],
  events: SessionEvent[],
  memoryEntries: Array<{ content: string }>,
): string[] {
  const failures: string[] = [];
  const types: string[] = events.map((e) => e.type as string);
  for (const assertion of assertions) {
    const label = `${assertion.assert}`;
    switch (assertion.assert) {
      case "event_present":
        if (!types.includes(assertion.event ?? "" as never)) {
          failures.push(`${label}: expected a "${assertion.event}" event; trajectory ${JSON.stringify(types)}`);
        }
        break;
      case "event_absent":
        if (types.includes(assertion.event ?? "")) {
          failures.push(`${label}: expected NO "${assertion.event}" event`);
        }
        break;
      case "event_order": {
        const wanted = assertion.events ?? [];
        let cursor = -1;
        let ok = true;
        for (const type of wanted) {
          const at = types.indexOf(type, cursor + 1);
          if (at === -1 || at <= cursor) {
            ok = false;
            break;
          }
          cursor = at;
        }
        if (!ok) failures.push(`${label}: expected ${JSON.stringify(wanted)} in relative order; trajectory ${JSON.stringify(types)}`);
        break;
      }
      case "event_count": {
        const count = types.filter((t) => t === assertion.event).length;
        if (count !== (assertion.exactly ?? 0)) {
          failures.push(`${label}: expected exactly ${assertion.exactly ?? 0} "${assertion.event}" events, saw ${count}`);
        }
        break;
      }
      case "event_field": {
        const event = events.find((e) => e.type === (assertion.event as SessionEvent["type"] | undefined));
        if (event === undefined) {
          failures.push(`${label}: no "${assertion.event}" event to inspect`);
          break;
        }
        const raw = eventField(event, assertion.field ?? "");
        const value =
          raw !== null && typeof raw === "object" ? JSON.stringify(raw) : String(raw);
        if (assertion.equals !== undefined && value !== assertion.equals) {
          failures.push(`${label}: ${assertion.event}.${assertion.field} expected "${assertion.equals}", saw "${value}"`);
        }
        if (assertion.contains !== undefined && !value.includes(assertion.contains)) {
          failures.push(`${label}: ${assertion.event}.${assertion.field} expected to contain "${assertion.contains}", saw "${value}"`);
        }
        if (
          assertion.at_least !== undefined &&
          !(typeof raw === "number" && raw >= assertion.at_least)
        ) {
          failures.push(`${label}: ${assertion.event}.${assertion.field} expected >= ${assertion.at_least}, saw "${value}"`);
        }
        break;
      }
      case "final_event":
        if (types[types.length - 1] !== assertion.event) {
          failures.push(`${label}: expected the final event to be "${assertion.event}", saw "${types[types.length - 1] ?? "none"}"`);
        }
        break;
      case "no_error_events": {
        const banned = ["turn.failed", "tool.error"];
        const seen = types.filter((t) => banned.includes(t));
        if (seen.length > 0) failures.push(`${label}: error events present: ${JSON.stringify(seen)}`);
        break;
      }
      case "memory_written": {
        const needle = assertion.contains ?? "";
        const hit = memoryEntries.some((entry) => entry.content.includes(needle));
        if (!hit) {
          failures.push(`${label}: no memory entry contains "${needle}"`);
        }
        break;
      }
      default:
        failures.push(`${label}: not a loop-kind assertion (wrong kind in the spec?)`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function histogramOf(trajectory: string[]): string[] {
  const counts = new Map<string, number>();
  for (const type of trajectory) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, n]) => `${type}×${n}`);
}

export async function runEval(spec: EvalSpec): Promise<EvalOutcome> {
  const base: EvalOutcome = {
    name: spec.name,
    description: spec.description,
    pass: false,
    failures: [],
    trajectory: [],
    histogram: [],
  };

  if (spec.kind === "loop") {
    const setup = spec.setup as LoopSetup;
    const message = spec.input?.user_message ?? "";
    const result = await runLoopEval(setup, message);
    const trajectory = result.events.map((e) => e.type);
    const failures = evaluateLoopAssertions(
      spec.assertions,
      result.events,
      result.memory_entries.map((e) => ({ content: e.content })),
    );
    // Cost ceiling (declared ceilings are part of the contract).
    if (spec.expected_cost_ceiling !== undefined) {
      const completed = result.events.find((e) => e.type === "turn.completed") as
        | { usage?: { input_tokens: number; output_tokens: number } }
        | undefined;
      const inputTokens = completed?.usage?.input_tokens ?? 0;
      const outputTokens = completed?.usage?.output_tokens ?? 0;
      const within =
        (spec.expected_cost_ceiling.input_tokens === undefined ||
          inputTokens <= spec.expected_cost_ceiling.input_tokens) &&
        (spec.expected_cost_ceiling.output_tokens === undefined ||
          outputTokens <= spec.expected_cost_ceiling.output_tokens);
      base.cost = { input_tokens: inputTokens, output_tokens: outputTokens, within_ceiling: within };
      if (!within) failures.push("cost ceiling exceeded");
    }
    return {
      ...base,
      trajectory,
      histogram: histogramOf(trajectory),
      failures,
      pass: failures.length === 0,
    };
  }

  if (spec.kind === "rate_limit") {
    const setup = spec.setup as RateLimitSetup;
    const result: RateLimitResult = await runRateLimitEval(setup);
    const failures: string[] = [];
    for (const assertion of spec.assertions) {
      if (assertion.assert === "elapsed_at_least") {
        if (result.elapsed_ms < (assertion.min_elapsed_ms ?? 0)) {
          failures.push(
            `elapsed_at_least: ${result.elapsed_ms}ms < ${assertion.min_elapsed_ms}ms — the burst was not paced`,
          );
        }
      } else {
        failures.push(`${assertion.assert}: not a rate_limit assertion`);
      }
    }
    const trajectory = [`rate.paced:${result.elapsed_ms >= (spec.assertions[0]?.min_elapsed_ms ?? 0) ? "ok" : "short"}ms`];
    return {
      ...base,
      trajectory,
      histogram: histogramOf(trajectory),
      failures,
      pass: failures.length === 0,
    };
  }

  if (spec.kind === "cve_correlation") {
    const setup = spec.setup as CveCorrelationSetup;
    const result: CveCorrelationResult = await runCveCorrelationEval(setup);
    const failures: string[] = [];
    for (const assertion of spec.assertions) {
      switch (assertion.assert) {
        case "cves_include":
          if (!result.cves.includes(assertion.cve ?? "")) {
            failures.push(`cves_include: expected ${assertion.cve} in ${JSON.stringify(result.cves)}`);
          }
          break;
        case "confidence_is":
          if (result.confidence !== (assertion.confidence ?? "")) {
            failures.push(`confidence_is: expected ${assertion.confidence}, saw ${result.confidence}`);
          }
          break;
        case "finding_cve_updated":
          if (result.finding_cve === null || !result.finding_cve.includes(assertion.cve ?? "")) {
            failures.push(`finding_cve_updated: the finding's CVE was not updated (${JSON.stringify(result.finding_cve)})`);
          }
          break;
        case "audit_row":
          if (!result.audit_rows.some((row) => row.action === (assertion.action ?? ""))) {
            failures.push(`audit_row: no "${assertion.action}" audit row`);
          }
          break;
        default:
          failures.push(`${assertion.assert}: not a cve_correlation assertion`);
      }
    }
    const trajectory = [`cve:${result.cves.join(",")}`, `confidence:${result.confidence}`];
    return {
      ...base,
      trajectory,
      histogram: histogramOf(trajectory),
      failures,
      pass: failures.length === 0,
    };
  }

  if (spec.kind === "disclosure_integrity") {
    const setup = spec.setup as DisclosureSetup;
    const result: DisclosureResult = await runDisclosureEval(setup);
    const failures: string[] = [];
    for (const assertion of spec.assertions) {
      if (assertion.assert === "hashes_match") {
        for (const file of result.files) {
          const recomputed = result.recomputed[file.name];
          if (recomputed !== file.sha256) {
            failures.push(`hashes_match: ${file.name} manifest ${file.sha256} != disk ${String(recomputed)}`);
          }
        }
        if (result.files.length === 0) {
          failures.push("hashes_match: the disclosure package has no files");
        }
      } else {
        failures.push(`${assertion.assert}: not a disclosure_integrity assertion`);
      }
    }
    const trajectory = result.files.map((f) => `file:${f.name}`);
    return {
      ...base,
      trajectory,
      histogram: histogramOf(trajectory),
      failures,
      pass: failures.length === 0,
    };
  }

  if (spec.kind === "ownership_refusal") {
    const setup = spec.setup as OwnershipSetup;
    const result: OwnershipResult = await runOwnershipEval(setup);
    const failures: string[] = [];
    for (const assertion of spec.assertions) {
      switch (assertion.assert) {
        case "refused":
          if (result.refused !== true) {
            failures.push("refused: a foreign-operator engagement was NOT refused");
          }
          break;
        case "refusal_code":
          if (result.code !== (assertion.code ?? "")) {
            failures.push(`refusal_code: expected ${assertion.code}, saw ${String(result.code)}`);
          }
          if (result.session_created || result.session_count !== 0) {
            failures.push(
              `refusal_code: the refusal did not prevent the session ` +
                `(created=${String(result.session_created)}, rows=${String(result.session_count)})`,
            );
          }
          break;
        default:
          failures.push(`${assertion.assert}: not an ownership_refusal assertion`);
      }
    }
    const trajectory = [`refused:${String(result.refused)}`, `code:${String(result.code)}`];
    return {
      ...base,
      trajectory,
      histogram: histogramOf(trajectory),
      failures,
      pass: failures.length === 0,
    };
  }

  return { ...base, failures: [`unknown kind "${String(spec.kind)}"`], pass: false };
}

// ---------------------------------------------------------------------------
// Loading + baseline
// ---------------------------------------------------------------------------

export async function loadEvalSpecs(dir: string = EVALS_DIR): Promise<EvalSpec[]> {
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".eval.yaml")).sort();
  const specs: EvalSpec[] = [];
  for (const file of files) {
    const text = await fsp.readFile(path.join(dir, file), "utf8");
    const parsed = parseYaml(text) as EvalSpec;
    if (typeof parsed.name !== "string" || !Array.isArray(parsed.assertions)) {
      throw new Error(`${file}: eval specs need name + assertions`);
    }
    specs.push(parsed);
  }
  return specs;
}

export interface Baseline {
  generated_at: string;
  outcomes: Array<{ name: string; pass: boolean; histogram: string[] }>;
}

export async function loadBaseline(): Promise<Baseline> {
  const text = await fsp.readFile(BASELINE_FILE, "utf8");
  return JSON.parse(text) as Baseline;
}

export async function writeBaseline(outcomes: EvalOutcome[]): Promise<void> {
  const baseline: Baseline = {
    generated_at: new Date().toISOString(),
    outcomes: outcomes.map((o) => ({ name: o.name, pass: o.pass, histogram: o.histogram })),
  };
  await fsp.writeFile(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** The diff between a recorded baseline and fresh outcomes (for --eval-update). */
export function baselineDiff(
  baseline: Baseline,
  outcomes: EvalOutcome[],
): string[] {
  const lines: string[] = [];
  const before = new Map(baseline.outcomes.map((o) => [o.name, o]));
  const after = new Map(outcomes.map((o) => [o.name, o]));
  for (const name of [...before.keys()].sort()) {
    if (!after.has(name)) lines.push(`- ${name}: removed`);
  }
  for (const name of [...after.keys()].sort()) {
    const fresh = after.get(name);
    const old = before.get(name);
    const freshOutcome = fresh;
    if (old === undefined) {
      lines.push(`+ ${name}: added (${freshOutcome?.pass === true ? "pass" : "FAIL"})`);
      continue;
    }
    if (old.pass !== freshOutcome?.pass) {
      lines.push(`~ ${name}: ${old.pass ? "pass" : "FAIL"} → ${freshOutcome?.pass ? "pass" : "FAIL"}`);
    }
    if (JSON.stringify(old.histogram) !== JSON.stringify(freshOutcome?.histogram)) {
      lines.push(`~ ${name}: event-type histogram changed`);
      lines.push(`    before: ${JSON.stringify(old.histogram)}`);
      lines.push(`    after:  ${JSON.stringify(freshOutcome?.histogram)}`);
    }
  }
  return lines;
}
