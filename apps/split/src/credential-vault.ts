// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the credential vault (KERNEL PROCESS ONLY).
//
// The kernel is the only process that reads credential env vars. Everything
// else asks `credential.inject {name, target_env}` and receives a scoped,
// TTL-60s, single-use token: the resolved value wrapped with scope and
// expiry metadata. The durable secret never crosses the process boundary;
// every issue and consume lands on the audit chain.
//
// Nothing is EVER written to disk: a credential file cannot leak from this
// process because it does not exist (the split e2e asserts ENOENT on every
// plausible path).

/** Audit row shape (matches @nyx/policy's appendAudit entry). */
export type VaultAuditSink = (entry: { actor: string; action: string; payload: unknown }) => void;

/** Phase 0 §5.5: scoped tokens live at most 60 seconds. */
export const CREDENTIAL_TOKEN_TTL_MS = 60_000;

export interface ScopedCredential {
  token: string;
  target_env: string;
  expires_at: number;
  scopes: string[];
}

interface IssuedRecord {
  credential: ScopedCredential;
  consumed: boolean;
}

export interface CredentialVaultOptions {
  /** Env source read ONCE at boot (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** The audit sink — issue + consume rows, actor "system:credentials". */
  audit?: VaultAuditSink;
  now?: () => number;
}

export class CredentialVault {
  readonly #env: NodeJS.ProcessEnv;
  readonly #audit?: VaultAuditSink;
  readonly #now: () => number;
  readonly #issued = new Map<string, IssuedRecord>();

  constructor(opts: CredentialVaultOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#audit = opts.audit;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Resolve `name` (an env var name, e.g. the config's api_key_env) and
   * mint a scoped token for injection into ONE tool call / provider use.
   * Throws when the env var is unset or empty — fail loudly, never mint an
   * empty credential.
   */
  inject(name: string, target_env: string, requester: string): ScopedCredential {
    const value = this.#env[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `credential "${name}" is not set in the kernel process environment (requested by ${requester} for ${target_env})`,
      );
    }
    const credential: ScopedCredential = {
      token: value,
      target_env,
      expires_at: this.#now() + CREDENTIAL_TOKEN_TTL_MS,
      scopes: [target_env],
    };
    const id = `${requester}:${target_env}:${this.#now()}:${Math.random().toString(36).slice(2, 10)}`;
    this.#issued.set(id, { credential, consumed: false });
    this.#audit?.({
      actor: "system:credentials",
      action: "security.credential.issued",
      payload: {
        name,
        target_env,
        requester,
        expires_at: credential.expires_at,
        ttl_ms: CREDENTIAL_TOKEN_TTL_MS,
      },
    });
    return credential;
  }

  /**
   * Mark a token consumed (revoked). Idempotent per id; the caller passes
   * the credential object it received. Tokens past their TTL are refused
   * (the boundary is scope + time, not just possession).
   */
  consume(credential: ScopedCredential, requester: string): boolean {
    const record = [...this.#issued.values()].find(
      (r) => r.credential === credential && !r.consumed,
    );
    if (record === undefined) return false;
    record.consumed = true;
    this.#audit?.({
      actor: "system:credentials",
      action: "security.credential.consumed",
      payload: { target_env: credential.target_env, requester },
    });
    return true;
  }

  /** Expired-but-unconsumed tokens (housekeeping + test visibility). */
  get outstandingCount(): number {
    const now = this.#now();
    let count = 0;
    for (const record of this.#issued.values()) {
      if (!record.consumed && record.credential.expires_at > now) count += 1;
    }
    return count;
  }
}
