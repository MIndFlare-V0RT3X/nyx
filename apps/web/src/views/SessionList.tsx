// SPDX-License-Identifier: AGPL-3.0-or-later
// Session list + new-session form (title, persona, optional engagement scope).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api.js";
import type { Engagement } from "../types.js";
import { parseEngagementForm, type EngagementFormInput } from "../engagement.js";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const EMPTY_ENGAGEMENT: EngagementFormInput = {
  id: "",
  cidrs: "",
  domains: "",
  expiryHours: "24",
};

export function SessionListView(props: {
  client: ApiClient;
  hasToken: boolean;
  onOpen(sessionId: string): void;
}): React.ReactElement {
  const sessions = useQuery({
    queryKey: ["sessions", props.client.baseUrl, props.client.token],
    queryFn: () => props.client.listSessions({ limit: 50 }),
    refetchInterval: 10_000,
  });
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [personaId, setPersonaId] = useState("default");
  const [showEngagement, setShowEngagement] = useState(false);
  const [engagement, setEngagement] = useState<EngagementFormInput>(EMPTY_ENGAGEMENT);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      let engagementValue: Engagement | undefined;
      if (showEngagement && engagement.id.trim() !== "") {
        const parsed = parseEngagementForm(engagement, Date.now());
        if (parsed.problems.length > 0) throw new Error(parsed.problems.join("; "));
        engagementValue = parsed.engagement;
      }
      return props.client.createSession({
        ...(title.trim() !== "" ? { title: title.trim() } : {}),
        persona_id: personaId.trim() !== "" ? personaId.trim() : "default",
        ...(engagementValue !== undefined ? { engagement: engagementValue } : {}),
      });
    },
    onSuccess: (meta) => {
      setTitle("");
      setEngagement(EMPTY_ENGAGEMENT);
      setShowEngagement(false);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      props.onOpen(meta.session_id);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <section className="session-list">
      <form
        className="new-session"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          placeholder="new session title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input className="narrow" placeholder="persona" value={personaId} onChange={(e) => setPersonaId(e.target.value)} />
        <button type="button" className="ghost" onClick={() => setShowEngagement(!showEngagement)}>
          {showEngagement ? "− scope" : "+ scope"}
        </button>
        <button type="submit" disabled={create.isPending || !props.hasToken}>
          create
        </button>
        {showEngagement && (
          <div className="engagement-row">
            <input placeholder="engagement id (e.g. ENG-042)" value={engagement.id} onChange={(e) => setEngagement({ ...engagement, id: e.target.value })} />
            <input placeholder="cidrs, comma-separated" value={engagement.cidrs} onChange={(e) => setEngagement({ ...engagement, cidrs: e.target.value })} />
            <input placeholder="domains, comma-separated" value={engagement.domains} onChange={(e) => setEngagement({ ...engagement, domains: e.target.value })} />
            <input
              className="narrow"
              type="number"
              min={1}
              value={engagement.expiryHours}
              onChange={(e) => setEngagement({ ...engagement, expiryHours: e.target.value })}
            />
          </div>
        )}
        {formError !== null && <p className="inline-error">{formError}</p>}
      </form>

      {sessions.isError && (
        <p className="inline-error">cannot list sessions: {sessions.error instanceof Error ? sessions.error.message : String(sessions.error)}</p>
      )}
      {sessions.isSuccess && sessions.data.length === 0 && <p className="dim">no sessions yet — create one above.</p>}
      {sessions.data !== undefined && sessions.data.length > 0 && (
        <table className="sessions">
          <thead>
            <tr>
              <th>title</th>
              <th>session</th>
              <th>persona</th>
              <th>scope</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.session_id} onClick={() => props.onOpen(s.session_id)} className="row">
                <td>{s.title !== "" ? s.title : <span className="dim">(untitled)</span>}</td>
                <td className="mono">{shortId(s.session_id)}</td>
                <td>{s.persona_id}</td>
                <td>{s.engagement !== null ? <span className="badge scope">{s.engagement.id}</span> : <span className="dim">—</span>}</td>
                <td className="dim">{timeAgo(s.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
