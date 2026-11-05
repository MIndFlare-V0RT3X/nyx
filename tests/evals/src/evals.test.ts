// SPDX-License-Identifier: AGPL-3.0-or-later
// The eval suite itself: run every spec, compare against the recorded
// baseline, fail on regression. EVAL_UPDATE=1 (the --eval-update flow)
// regenerates the baseline and prints the diff instead of gating.

import { beforeAll, describe, expect, it } from "vitest";
import {
  baselineDiff,
  loadBaseline,
  loadEvalSpecs,
  runEval,
  writeBaseline,
  type EvalOutcome,
} from "./runner.js";

describe("behavioral evals (Phase 7.4)", () => {
  let outcomes: EvalOutcome[] = [];

  beforeAll(async () => {
    const specs = await loadEvalSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(12);
    outcomes = [];
    for (const spec of specs) {
      outcomes.push(await runEval(spec));
    }
  }, 240_000);

  it("every eval passes", () => {
    const failed = outcomes.filter((o) => !o.pass);
    for (const outcome of failed) {
      console.error(`EVAL FAIL ${outcome.name}:\n  ${outcome.failures.join("\n  ")}`);
    }
    expect(failed.map((o) => o.name)).toEqual([]);
  });

  it("asserts on events, not final text: every loop eval has event-log assertions", async () => {
    const specs = await loadEvalSpecs();
    for (const spec of specs) {
      if (spec.kind !== "loop") continue;
      const eventAssertions = spec.assertions.filter((a) =>
        [
          "event_present",
          "event_absent",
          "event_order",
          "event_count",
          "event_field",
          "final_event",
          "no_error_events",
        ].includes(a.assert),
      );
      expect(
        eventAssertions.length,
        `${spec.name}: a loop eval must assert on the event log`,
      ).toBeGreaterThan(0);
    }
  });

  it("the baseline matches: a regression fails here", async () => {
    let baseline: Awaited<ReturnType<typeof loadBaseline>>;
    try {
      baseline = await loadBaseline();
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT" && process.env.EVAL_UPDATE === "1") {
        // First generation (--eval-update with no baseline yet).
        await writeBaseline(outcomes);
        console.log(`baseline generated with ${outcomes.length} evals`);
        return;
      }
      throw new Error(
        "baseline.json is missing — run `EVAL_UPDATE=1 pnpm --filter @nyx/evals test` once to record it",
        { cause: err },
      );
    }
    const before = new Map(baseline.outcomes.map((o) => [o.name, o]));
    const regressions: string[] = [];
    for (const outcome of outcomes) {
      const old = before.get(outcome.name);
      if (old === undefined) {
        regressions.push(`${outcome.name}: not in the baseline (run with EVAL_UPDATE=1 to add)`);
        continue;
      }
      if (old.pass !== outcome.pass) {
        regressions.push(
          `${outcome.name}: was ${old.pass ? "pass" : "fail"}, now ${outcome.pass ? "pass" : "fail"}`,
        );
      }
      if (JSON.stringify(old.histogram) !== JSON.stringify(outcome.histogram)) {
        regressions.push(`${outcome.name}: event-type histogram changed`);
      }
    }
    for (const name of before.keys()) {
      if (!outcomes.some((o) => o.name === name)) {
        regressions.push(`${name}: in the baseline but no spec produces it`);
      }
    }
    if (regressions.length > 0 && process.env.EVAL_UPDATE === "1") {
      // --eval-update: regenerate + print the diff, do not gate.
      await writeBaseline(outcomes);
      console.log(baselineDiff(baseline, outcomes).join("\n"));
      return;
    }
    expect(regressions).toEqual([]);
  });

  it("a KNOWN regression is caught (the gate proves itself)", async () => {
    // Take the scope-enforcement eval and corrupt its expectation: the
    // denial reason asserted as "policy" instead of "scope". The runner
    // must report the failure — proving a real behavior change cannot slip
    // through the assertion engine.
    const specs = await loadEvalSpecs();
    const spec = specs.find((s) => s.name === "scope-enforcement");
    expect(spec).toBeDefined();
    const corrupted = structuredClone(spec!);
    for (const assertion of corrupted.assertions) {
      if (assertion.assert === "event_field" && assertion.field === "reason") {
        assertion.equals = "policy";
      }
    }
    const outcome = await runEval(corrupted);
    expect(outcome.pass).toBe(false);
    expect(outcome.failures.join(" ")).toContain("scope");
  });

  it("baselineDiff reports added/removed/changed evals and trajectory drift", () => {
    const diff = baselineDiff(
      {
        generated_at: "t0",
        outcomes: [
          { name: "kept", pass: true, histogram: ["a×1"] },
          { name: "gone", pass: true, histogram: [] },
          { name: "flipped", pass: true, histogram: [] },
          { name: "drifted", pass: true, histogram: ["x×1"] },
        ],
      },
      [
        { name: "kept", description: "", pass: true, failures: [], trajectory: ["a"], histogram: ["a×1"] },
        { name: "added", description: "", pass: true, failures: [], trajectory: [], histogram: [] },
        { name: "flipped", description: "", pass: false, failures: ["nope"], trajectory: [], histogram: [] },
        { name: "drifted", description: "", pass: true, failures: [], trajectory: ["y"], histogram: ["y×1"] },
      ] as unknown as EvalOutcome[],
    );
    const text = diff.join("\n");
    expect(text).toContain("- gone: removed");
    expect(text).toContain("+ added: added (pass)");
    expect(text).toContain("~ flipped: pass → FAIL");
    expect(text).toContain("~ drifted: event-type histogram changed");
    expect(text).not.toContain("~ kept");
  });
});
