# @nyx/policy

Deny-first policy engine, approval lifecycle, and hash-chained audit log for
NYX. Structural invariants (R4 owner approval, dangerous capabilities) are
hardcoded and cannot be weakened by any config rule; approvals are single-use,
TTL-bound, and bound to the exact action digest they were requested for; every
approval state change is written to a tamper-evident audit chain in the same
SQLite transaction.

## Public exports

- `PolicyEngineImpl` — `new PolicyEngineImpl(rules: PolicyRule[], opts?: { now?: () => number })`;
  `evaluate(req: ActionRequest): Promise<PolicyVerdict>`.
- `computeActionDigest(req: ActionRequest): string` — sha256 hex over
  `canonicalJson({ tool, input, risk })` (protocol `canonicalJson`), i.e. the
  exact-action binding.
- `ApprovalEngineImpl` — `new ApprovalEngineImpl(db: better-sqlite3.Database,
opts?: { now?: () => number; ttl_ms?: number; poll_ms?: number })`.
  Creates the `approvals` (and `audit`) tables with `CREATE TABLE IF NOT
EXISTS`, so it works against any db handle. Implements the protocol
  `ApprovalEngine`: `request`, `resolve`, `get`, `pending`, `consume`.
- `appendAudit(db, entry: { actor; action; payload }, opts?: { now? })` —
  append one hash-chained row.
- `verifyAuditChain(db): { ok; checked; first_bad_id? }`.
- `policyRuleSchema` — runtime validation mirror of the protocol `PolicyRule`
  type with a zod-flavored API: `parse(value): PolicyRule` (throws a typed
  error, `code: "validation_failed"`) and `safeParse(value): { success: true;
data } | { success: false; error }`.
- Types: `PolicyEngineOptions`, `ApprovalEngineOptions`, `AuditEntry`,
  `AuditVerifyResult`, `PolicyRuleSchema`, `SafeParseResult`.

## Usage

```ts
import Database from "better-sqlite3";
import { ApprovalEngineImpl, PolicyEngineImpl, appendAudit, verifyAuditChain } from "@nyx/policy";

const engine = new PolicyEngineImpl([
  {
    id: "allow-scratch-reads",
    match: { tool: ["fs.read"], path_prefix: "/tmp" },
    decision: "allow",
  },
  { id: "deny-secrets", match: { path_prefix: "/etc" }, decision: "deny" },
]);
const verdict = await engine.evaluate({
  session_id: "s1",
  turn_id: "t1",
  tool: "fs.read",
  input: { path: "/etc/passwd" },
  risk: "R2",
  capabilities: ["fs.read"],
  actor_id: "agent",
});
// verdict.decision === "deny" — and an R4 action would be "ask" no matter
// what the config says.

const db = new Database("nyx.db");
const approvals = new ApprovalEngineImpl(db);
const outcome = await approvals.request(verdict, {
  session_id: "s1",
  turn_id: "t1",
  actor_id: "agent",
});
if (outcome === "allow") await approvals.consume(id, verdict.action_digest);

appendAudit(db, { actor: "owner", action: "session.created", payload: { id: "s1" } });
verifyAuditChain(db); // { ok: true, checked: 1 }
```

## Design notes / invariants

### Policy engine

- **Immutable invariants, evaluated first:** `risk === "R4"` → at least `ask`
  (`rule_id: "invariant:r4-owner-approval"`, summary notes owner approval);
  capabilities ∩ `{host.access, credential.use, git.push, deploy}` → at least
  `ask` (`invariant:dangerous-capability`). They only _raise_ decisions: a
  matching config `deny` still denies.
- **Resolution:** collect all matching config rules; any `deny` → deny (first
  deny's id); else invariant ask or any config `ask` → ask (invariant ids win
  over config ask ids; R4 wins over the capability invariant); else the last
  matching `allow` rule's id; else — no rule matched at all —
  `ask` / `default:unknown-action` (deny-first: unknown escalates).
- **Rule matching:** every present match field must match. `tool` list
  membership; `capability` intersection; `risk` list membership; `owner_only`
  restricts the rule to `actor_id === "owner"`. `path_prefix`/`host` are
  Phase-0 crude: a top-level string `path` (resp. `host`) field of the input
  is prefix-matched with `String#startsWith`, and when no such field exists
  the prefix is matched against the input's canonical JSON serialization.
  Documented approximation — field-aware matching lands with the config
  schema work.
- **action_digest / summary:** digest is sha256 over canonical JSON, so
  key-order differences never change it; the summary is
  `"<tool>" on <sketch> [risk R2]` where the sketch prefers top-level
  `path`/`url`/`host` values (e.g. `path="/tmp/a"`) and otherwise uses the
  canonical JSON of the input, capped at 120 chars.
- The constructor accepts (and stores) an injectable `now` for future
  timestamped verdicts; Phase 0 verdicts carry no timestamps.

### Approvals

- `request` inserts a pending row (nanoid id, TTL default 600 000 ms) plus an
  `approval.requested` audit row in one transaction, then polls (default
  150 ms) until the decision leaves `pending`; if `now >= expires_at` while
  still pending it flips the row to `deny` / `system:expiry`, audits
  `approval.expired`, and resolves `"deny"`.
- `resolve` is transactional: the row must be pending and unexpired
  (`now >= expires_at` → typed throw `approval_expired`); the decision update
  and its `approval.resolved` audit row commit or roll back together.
- `consume` is transactional and enforces, in order: row exists, decision is
  `allow`, not expired, `used_at` is NULL, and the digest matches exactly
  (`"digest mismatch"` → `approval_denied`). It sets `used_at` and audits
  `approval.consumed`. Every failure is a typed throw — never a silent deny.
- `pending(session_id)` lists pending **and unexpired** rows, newest first.
- **Risk derivation:** the frozen `PolicyVerdict` carries no risk field, but
  the `approvals` table and `approval.requested` events need one. The engine
  recovers it from the policy engine's summary convention `… [risk RX]`
  (which `PolicyEngineImpl` always emits); verdicts built without the
  convention default to `R3` (conservative). See Deviations in the package
  task report — a `risk` field on `PolicyVerdict` would remove this.
- All throws use `Error` subclasses with a `code` property from the protocol
  `NyxErrorCode` set (`approval_denied`, `approval_expired`,
  `validation_failed`).

### Audit chain

- Schema: `audit(id, prev_hash, hash, actor, action, payload_json,
created_at)`. `hash = sha256(prev_hash + "\n" + payload_json + "\n" +
actor + "\n" + action + "\n" + String(created_at))`, genesis `prev_hash`
  is `""`. Payloads are stored in canonical JSON and the hash covers the
  exact stored text, so even a semantically neutral edit (key reordering)
  breaks the row hash.
- `appendAudit` runs on whatever transaction is open on the passed
  connection: inside a better-sqlite3 `db.transaction(...)` block it joins
  that transaction (SQLite has one transaction per connection) and rolls back
  with it; standalone it autocommits. It also `CREATE TABLE IF NOT EXISTS`es
  so it works on any handle.
- `verifyAuditChain` walks rows in id order, recomputing every hash and every
  `prev_hash` link. It detects tampered `payload_json`/`actor`/`action`/
  `created_at`, rows that were edited _and_ rehashed (the next row's link
  breaks), and deleted middle rows. Deleting the **last** row leaves a valid
  chain and verifies ok — documented behavior. A full-chain rewrite by an
  attacker who recomputes every hash is undetectable without an externally
  anchored checkpoint; Phase 0 does not anchor.

### policyRuleSchema

- zod is not a declared dependency of this package, so the mirror is a
  hand-rolled validator with a zod-flavored `parse`/`safeParse` API. Field
  names match the protocol `PolicyRule` exactly. It is **strict**: unknown
  top-level or `match` fields are rejected (config typos must not silently
  disable a rule), `match` must be non-empty, capabilities/risks are checked
  against the protocol enums, and `tool`/`capability`/`risk` accept a string
  or a non-empty list of strings.

## Intentionally deferred

- No config file loading/validation of whole rule sets (the `@nyx/config`
  package composes `policyRuleSchema` for that); no rule hot-reload.
- No field-aware `path_prefix`/`host` extraction (see above).
- No persistent audit checkpoint anchoring (e.g. writing the head hash to a
  second store or the event log) — the chain is tamper-_evident_, not
  tamper-_proof_ against a full rewrite.
- `request()` polls the database; a push-based notifier (SQLite update hook
  or IPC) can replace the polling later without changing the contract.
