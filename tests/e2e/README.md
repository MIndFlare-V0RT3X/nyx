# @nyx/e2e

> End-to-end tests against the real stack — server, agent loop, tool
> runtime, policy engine, approval lifecycle, sandbox, session store —
> driven through the HTTP app like an external client. Fully offline:
> scripted mock providers, loopback HTTP for `web.fetch`, local dev
> sandbox, tmpdir data roots.

- `smoke.test.ts` — create a session, run a turn with a tool call, assert
  the exact durable event order and the file side effect.
- `approval.test.ts` — R2 ask → allow → single-use execution → resolved;
  ask → deny → `action.denied` with no execution; **scope enforcement**:
  out-of-scope egress denied without ever asking, and no engagement ⇒ no
  external egress (local tools unaffected).
- `replay.test.ts` — fork at seq over REST; the child's event prefix is
  payload-identical (modulo the rewritten session identity and fresh seqs)
  and the child is a live session.

Run: `pnpm --filter @nyx/e2e test` (or `pnpm e2e`).
