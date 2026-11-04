# Heartbeat

Scheduled, system-generated turns: memory review, task resumption, periodic
summaries. A heartbeat is an ordinary turn — the same agent loop, persona,
policy, approvals, and sandbox as any other — with two differences: it is
**started by the harness, not an operator**, and it is enqueued at
`heartbeat` priority into the session's lane.

Disabled by default; opt in via `config.heartbeat.enabled`.

## The scheduler

`@nyx/runtime`'s `HeartbeatScheduler`:

```ts
register(spec: HeartbeatSpec): void;
unregister(id: string): void;
list(): HeartbeatSpec[];
trigger(id: string): Promise<void>;   // manual fire (tests, operator runs)
start(): Promise<void>;
stop(): Promise<void>;
```

```ts
interface HeartbeatSpec {
  id: string;
  schedule: string;        // 5-field cron, UTC
  persona_id?: string;     // default: the configured default persona
  session_id?: string;     // default: a new session per fire
  prompt: string;          // the user message of the generated turn
  priority: "heartbeat";
  enabled: boolean;
}
```

On fire, the sink enqueues a turn into the target session's lane at
`heartbeat` priority. With the default lane config
(`heartbeat_serialized_with_interactive: true`) heartbeats serialize with
interactive turns — a memory review never interleaves with an operator's
in-flight turn. Opt out per config if you want heartbeats to run alongside.

## The cron engine (declared choice)

Hand-rolled, five fields (`minute hour day-of-month month day-of-week`),
**no new dependency** (node-cron was considered and rejected — the grammar we
need is ~100 lines and fully testable):

- `*`, single numbers, ranges `a-b`, steps `*/n` and `a-b/n`, comma lists.
- Vixie-cron day semantics: dom and dow both restricted → **union**; exactly
  one restricted → intersection; neither → every day.
- **UTC.** Schedules are stable across the host's local timezone and DST
  transitions; an operator who wants local time writes the offset into the
  schedule. (A personal harness runs on one machine; UTC keeps the guarantee
  testable.)
- `nextFire` scans forward with a 4-year bound and throws rather than spin
  forever on a never-matching expression (e.g. February 30th).

Cron **syntax is validated when the scheduler is constructed** — the server
refuses to start on a malformed `schedule`, and `@nyx/runtime`'s
`parseCron` throws with the offending field.

## Persistence and restarts

State lives in `data_dir/heartbeat.db`:

- `heartbeat_state` (spec_id, last_fired_at, next_fire_at) — one row per spec.
- `heartbeat_history` (spec_id, fired_at, status, source) — every fire:
  `fired/schedule`, `fired/manual`, or `missed/missed`.

The rules that matter:

1. **State advances before the turn runs.** A crash mid-fire cannot re-fire
   the same slot on restart.
2. **Missed fires are logged, never fired retroactively.** If the process was
   down across a scheduled time, `start()` records a `heartbeat.missed`
   history row (and a `heartbeat.missed` log line) and reschedules from now.
   A harness that was off at 03:00 does not wake up and immediately re-run
   the review against stale expectations.
3. **Manual `trigger()` does not consume the schedule.** The scheduled fire
   still happens at its own time; the manual run is recorded with
   `source = manual`.

## Default specs (shipped disabled)

Two recommendations live commented in `nyx.config.example.yaml`, both
`enabled: false` until the operator reviews them:

- `memory-review` — daily at 03:00: "Review the last 24 hours of memory and
  consolidate duplicates, expire stale episodes, surface anything that should
  have been escalated."
- `session-summary` — hourly: "If any session has been inactive for over 24
  hours with uncommitted memory, summarize it into the persona memory store
  and close the session."

Both prompts are plain user messages to the persona — the harness adds no
special authority to heartbeat turns.


## Timezones (Phase 2)

Each spec may name an IANA `timezone` (default `UTC`); the cron expression is
interpreted in that zone via `Intl.DateTimeFormat` (Node's full ICU). A spec
with `timezone: "Asia/Karachi"` and `schedule: "0 3 * * *"` fires at 03:00
PKT (22:00 UTC the previous day). DST semantics: spring-forward gaps skip
(vixie-cron behavior); fall-back ambiguity fires the wall time **once** (the
first occurrence) — a personal harness does not double-run heartbeats.
Missed-fire detection compares instants, so it uses the same zone
automatically. Unknown zone names are hard errors at registration and in the
config schema.
