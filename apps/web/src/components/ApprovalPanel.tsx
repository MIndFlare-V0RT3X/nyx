// SPDX-License-Identifier: AGPL-3.0-or-later
// Pending approvals for the live session: risk badge, summary, remaining
// TTL, allow/deny buttons. 403s (non-owner on R4) surface inline.

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "../api.js";
import type { ApprovalView } from "../events.js";

const RISK_CLASS: Record<string, string> = {
  R0: "r0",
  R1: "r1",
  R2: "r2",
  R3: "r3",
  R4: "r4",
};

function ttlRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ApprovalPanel(props: {
  client: ApiClient;
  approvals: ApprovalView[];
  onResolved(): void;
}): React.ReactElement | null {
  const pending = props.approvals.filter((a) => a.decision === "pending");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (pending.length === 0 && error === null) return null;

  const resolve = async (id: string, decision: "allow" | "deny"): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await props.client.resolveApproval(id, decision);
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
      props.onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="approvals">
      <h3>approvals</h3>
      {pending.map((a) => (
        <div key={a.id} className={`approval ${RISK_CLASS[a.risk] ?? "r2"}`}>
          <div className="approval-head">
            <span className="risk">{a.risk}</span>
            <span className="ttl">{ttlRemaining(a.expiresAt, now)}</span>
          </div>
          <pre className="approval-summary">{a.summary}</pre>
          <div className="approval-actions">
            <button disabled={busy !== null} onClick={() => void resolve(a.id, "allow")}>
              allow
            </button>
            <button
              className="deny"
              disabled={busy !== null}
              onClick={() => void resolve(a.id, "deny")}
            >
              deny
            </button>
          </div>
        </div>
      ))}
      {error !== null && <p className="inline-error">{error}</p>}
    </section>
  );
}
