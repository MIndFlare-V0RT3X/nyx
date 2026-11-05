# Behavioral evals — integration tests for the harness

`tests/evals/` answers a question the unit suites cannot: does the HARNESS
carry the behaviors it promises? End-to-end benchmarks tell you a number
moved and leave you guessing why; behavioral evals assert on the
**intermediate, observable actions** — the session event log — not the
final text. A scripted mock provider drives a specific trajectory; the
assertions check what the harness did with it.

These are tests for the harness, not for the model: the mock provider is
scripted to exhibit a behavior (ask a question, call the validator,
delegate, attempt an out-of-scope call), and the eval proves the harness
records, enforces, propagates, and refuses correctly around it. Real-model
runs are operator-side and produce their own baselines (out of scope for
v0.7.0; see the Phase 7 brief §12).

## The suite

Twelve evals, one YAML spec each (`tests/evals/evals/*.eval.yaml`):

| #   | Eval                                   | Asserts (on events)                                                |
| --- | -------------------------------------- | ------------------------------------------------------------------ |
| 1   | clarification-on-underspecified-prompt | message.assistant present, ZERO tool.call, full order              |
| 2   | validator-before-done                  | tool.call(validator) before turn.completed, result in the log      |
| 3   | scope-enforcement                      | action.denied reason=scope, no tool.result, no approval asked      |
| 4   | approval-flow                          | approval.requested → resolved → action.denied reason=approval      |
| 5   | subagent-delegation                    | subagent.spawned/completed mirrored, result returns as tool.result |
| 6   | compaction-trigger                     | compaction.started/completed strategy=rule-elision, freed tokens   |
| 7   | memory-write-after-turn                | tool.call(memory.write) + the entry in the real store              |
| 8   | rate-limit-respect                     | 4 calls @ 2rps paced ≥ 1500ms wall clock (real clock)              |
| 9   | cve-correlation-accuracy               | Apache httpd 2.4.49 → CVE-2021-41773 exact-match, finding updated  |
| 10  | disclosure-package-integrity           | manifest sha256 == recomputed on-disk artifact hashes              |
| 11  | abort-propagation                      | tool.error code=aborted, turn.failed aborted, nothing after        |
| 12  | scope-refusal-owner-mismatch           | foreign-operator engagement refused (engagement_ownership)         |

The rig is REAL everywhere except the model: real agent loop, real tool
runtime, real policy engine, real approval engine (with the production
onCreated/onResolved event wiring and a scripted operator resolver), real
session store (in-memory SQLite + audit), real memory store, real subagent
manager, tmpdir sandbox. The scripted seams are the provider (turn
scripts), the approval outcomes, and the fake tools a script calls.

Two honest scope notes: eval 7's `memory.write` tool is rig-provided —
production memory writes happen through compaction's session-memory tier
and the split-mode kernel RPC; the eval proves the loop→tool→store
plumbing and the durable side effect. Eval 12 drives the ownership
invariant through the exact session-creation sequence the surfaces use
(assert BEFORE the store) and additionally proves no session row survives
the refusal.

## The regression gate

`baseline.json` records every eval's pass/fail AND its event-type
HISTOGRAM (the multiset of event types in the trajectory). The suite fails
when either drifts — an event type appearing or vanishing is a structural
behavior change. ORDER sensitivity lives in each eval's own `event_order`
assertions, which encode exactly which order matters (some interleavings —
mirrored subagent events vs the loop's pump flush — are legitimately
load-dependent, which is why the gate keys on the histogram):

```sh
pnpm --filter @nyx/evals test          # gate: any drift fails
pnpm --filter @nyx/evals eval:update   # --eval-update: regenerate + print the diff
```

A histogram change is a behavior change — even if all assertions still
pass — and deserves a look before it is accepted. `--eval-update` prints
the diff (added / removed / flipped / drifted) and rewrites the baseline;
commit the baseline with the change that justified it. CI runs the gate in
both lanes (the evals are offline: scripted provider, no network, no
docker), and nothing in CI sets EVAL_UPDATE — a baseline update is always
a visible diff.

## How to add an eval

1. Write `tests/evals/evals/<nn>-<name>.eval.yaml`:

   ```yaml
   name: my-behavior
   description: >
     One paragraph: what the model is scripted to do and what the harness
     must observably do about it.
   kind:
     loop # loop | rate_limit | cve_correlation |
     # disclosure_integrity | ownership_refusal
   setup:
     provider_script: # each item = one model turn, in order
       - tool_call: { name: my_tool, call_id: c1, input: { ... } }
       - text: "the final reply"
     tools: # fake tools the script can call
       - name: my_tool
         risk: R0
     policy:
       - { id: allow-r0, match: { risk: R0 }, decision: allow }
   input:
     user_message: "do the thing"
   assertions: # ON THE EVENT LOG — hard rule #4
     - { assert: event_present, event: tool.call }
     - { assert: event_field, event: tool.call, field: name, equals: my_tool }
     - { assert: event_order, events: [tool.call, tool.result, turn.completed] }
     - { assert: final_event, event: turn.completed }
   expected_cost_ceiling: { input_tokens: 100000, output_tokens: 10000 }
   ```

2. Run it: `pnpm --filter @nyx/evals test` — the new eval fails the
   baseline gate as "not in the baseline".

3. Accept it: `pnpm --filter @nyx/evals eval:update`, review the printed
   diff, commit the spec together with the regenerated `baseline.json`.

Rules of the house:

- **Assert on events, not final text.** An eval that only checks the
  reply is not an eval (the meta-test enforces this for `loop` evals).
- One behavior per eval; put the observable in the assertion, not the
  description.
- A specialized `kind` is justified only when the behavior's surface is
  not the event log (wall clock, artifact hashes, structural refusals).
  Everything else is `loop`.
