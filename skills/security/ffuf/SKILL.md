---
name: security-ffuf
description: Web fuzzing of directories, parameters, and vhosts against an in-scope URL with the FUZZ keyword.
when_to_use: "Enumerating hidden paths or parameters on a target you are already authorized to test."
tools: ["security.ffuf"]
persona_scope: ["security"]
attack_class: enum
version: 1.0.0
---

# ffuf — web fuzzing

Call `security.ffuf` with
`{ "url": "https://app.example.com/portal/FUZZ", "wordlist": "wordlists/raft-small-words.txt", "extensions": [".php"] }`.
The URL must be in the engagement's scope (URL targets match on
scheme+host+path; the FUZZ position is inside that authorized path space).

## Reading the output
`{ hits: [{ url, status, length, words }], count }`. Calibrate: identical
`length`/`words` across many hits usually means a soft-404 — filter them out
before drawing conclusions.

## Gotchas
- The engagement's ffuf rate bucket blocks, never drops — do not spawn
  parallel calls to "speed it up"; they share the same bucket and just wait.
- The wordlist path is workspace-relative and containment-checked; place
  wordlists in the workspace first. With `security.executor: "host"` the
  path must also resolve from the harness process's working directory —
  the sandbox executor is the turnkey mode.
- Fuzzing sibling paths outside the authorized subtree is denied by scope.

## Preserving output
To keep a run as evidence, write the result into the workspace (`fs.write`
to `artifacts/ffuf-<target>.json`) and record its sha256 via `shell.exec`
(`sha256sum artifacts/ffuf-<target>.json`) — a finding you record later can then cite it
as hash-verified evidence.
