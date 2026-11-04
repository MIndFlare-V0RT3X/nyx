// SPDX-License-Identifier: AGPL-3.0-or-later
// App shell: auth state (token + base URL, persisted), the api client,
// React Query, and the list ↔ session view switch.

import { useCallback, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient, type ApiClient } from "./api.js";
import { AuthBar } from "./components/AuthBar.js";
import { SessionListView } from "./views/SessionList.js";
import { SessionView } from "./views/SessionView.js";

const TOKEN_KEY = "nyx.token";
const BASE_KEY = "nyx.baseUrl";
const DEFAULT_BASE = "http://127.0.0.1:8787";

function readSetting(key: string, fallback: string): string {
  const value = window.localStorage.getItem(key);
  return value === null || value === "" ? fallback : value;
}

function AppShell(): React.ReactElement {
  const [token, setToken] = useState(() => readSetting(TOKEN_KEY, ""));
  const [baseUrl, setBaseUrl] = useState(() => readSetting(BASE_KEY, DEFAULT_BASE));
  const [activeSession, setActiveSession] = useState<string | null>(null);

  const persistToken = useCallback((value: string) => {
    setToken(value);
    window.localStorage.setItem(TOKEN_KEY, value);
  }, []);
  const persistBaseUrl = useCallback((value: string) => {
    setBaseUrl(value);
    window.localStorage.setItem(BASE_KEY, value);
  }, []);

  const client: ApiClient = useMemo(() => createClient({ baseUrl, token }), [baseUrl, token]);

  return (
    <div className="app">
      <AuthBar
        baseUrl={baseUrl}
        token={token}
        onBaseUrl={persistBaseUrl}
        onToken={persistToken}
        client={client}
      />
      <main className="app-main">
        {activeSession === null ? (
          <SessionListView client={client} hasToken={token !== ""} onOpen={setActiveSession} />
        ) : (
          <SessionView
            client={client}
            sessionId={activeSession}
            onBack={() => setActiveSession(null)}
          />
        )}
      </main>
      <footer className="app-footer">
        NYX — local-first agent runtime · loopback server at <code>{baseUrl}</code>
      </footer>
    </div>
  );
}

export default function App(): React.ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
