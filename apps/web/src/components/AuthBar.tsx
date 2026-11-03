// SPDX-License-Identifier: AGPL-3.0-or-later
// Top bar: server base URL, bearer token, and a live health indicator.

import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "../api.js";

export function AuthBar(props: {
  baseUrl: string;
  token: string;
  onBaseUrl(value: string): void;
  onToken(value: string): void;
  client: ApiClient;
}): React.ReactElement {
  const health = useQuery({
    queryKey: ["health", props.client.baseUrl, props.client.token],
    queryFn: () => props.client.getHealth(),
    retry: false,
    refetchInterval: 15_000,
  });
  const ok = health.isSuccess;
  const label = health.isError ? "offline" : ok ? "online" : "…";

  return (
    <header className="authbar">
      <span className="brand">nyx</span>
      <label className="field">
        <span>server</span>
        <input
          value={props.baseUrl}
          onChange={(e) => props.onBaseUrl(e.target.value)}
          spellCheck={false}
          placeholder="http://127.0.0.1:8787"
        />
      </label>
      <label className="field grow">
        <span>token</span>
        <input
          type="password"
          value={props.token}
          onChange={(e) => props.onToken(e.target.value)}
          spellCheck={false}
          placeholder="owner bearer token"
        />
      </label>
      <span className={`dot ${ok ? "on" : "off"}`} title={label} aria-label={label} />
    </header>
  );
}
