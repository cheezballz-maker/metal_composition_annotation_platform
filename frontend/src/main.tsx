import React from "react";
import { createRoot } from "react-dom/client";
import { ReviewWorkspace } from "./review/ReviewWorkspace";
import type { ReviewWorkspaceInfo } from "./review/types";
import "./styles.css";

type Session = { authenticated: boolean; username: string | null; mode: "session" | "basic" | "none" };

async function authRequest(path: string, options?: RequestInit): Promise<Session> {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : "Could not connect. Please try again.");
  return payload;
}

function App() {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [connectionError, setConnectionError] = React.useState(false);
  const [workspaces, setWorkspaces] = React.useState<ReviewWorkspaceInfo[] | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<ReviewWorkspaceInfo | null>(null);

  const checkSession = React.useCallback(async () => {
    setLoading(true); setError(""); setConnectionError(false);
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (response.status === 401) { setSession(null); return; }
      if (!response.ok) throw new Error("Could not check your session.");
      setSession(await response.json());
    } catch {
      setConnectionError(true); setError("Could not connect to Composition review. Please retry.");
    } finally { setLoading(false); }
  }, []);
  React.useEffect(() => {
    void checkSession();
    const expired = () => {
      setSession(null); setPassword(""); setConnectionError(false);
      setError("Your session has expired. Please sign in again.");
    };
    window.addEventListener("annotation-auth-required", expired);
    return () => window.removeEventListener("annotation-auth-required", expired);
  }, [checkSession]);
  React.useEffect(() => {
    if (!session?.authenticated) { setWorkspaces(null); setSelectedWorkspace(null); return; }
    void fetch("/api/review/workspaces", { credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : "Could not load review workspaces.");
        setWorkspaces(payload.workspaces || []);
        if (payload.workspaces?.length === 1 && payload.workspaces[0].key === "patent-claims-cn") setSelectedWorkspace(payload.workspaces[0]);
      })
      .catch((failure) => setError(failure instanceof Error ? failure.message : "Could not load review workspaces."));
  }, [session?.authenticated]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const next = await authRequest("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      setPassword(""); setSession(next);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setError("");
    try { await authRequest("/api/auth/logout", { method: "POST" }); setSession(null); setPassword(""); }
    catch { setError("Could not sign out. Please try again."); }
  };

  if (loading) return <main className="login-shell"><p className="auth-loading">Loading Composition review…</p></main>;
  if (session?.authenticated && selectedWorkspace) return <>
    {error && <div className="login-error" role="alert">{error}</div>}
    <ReviewWorkspace workspace={selectedWorkspace} username={session.username} onChooseWorkspace={() => setSelectedWorkspace(null)} onLogout={session.mode === "session" ? () => void logout() : undefined}/>
  </>;
  if (session?.authenticated) return <main className="workspace-shell"><section className="workspace-panel">
    <header className="workspace-header"><h1>Composition review</h1>{session.mode === "session" && <button onClick={() => void logout()}>Sign out</button>}</header>
    {error && <div className="login-error" role="alert">{error}</div>}
    {!workspaces ? <p className="auth-loading">Loading review workspaces…</p> : workspaces.length === 0 ? <p>No review workspace is assigned to this account.</p> :
      <div className="workspace-grid">{workspaces.map((workspace) => <button key={workspace.key} className="workspace-card" onClick={() => setSelectedWorkspace(workspace)}>
        <strong>{workspace.key === "patent-claims-cn" ? "中国专利权利要求" : workspace.label}</strong>
        <span className="workspace-count"><b>{workspace.record_count}</b><span>{workspace.key === "patent-claims-cn" ? "件专利" : "patents"}</span></span>
        <p>{workspace.key === "patent-claims-cn" ? "对照中文权利要求原文，核查提取的合金成分。" : workspace.source_kind === "patent_description" ? "Review extracted alloy mentions throughout patent descriptions." : "Review extracted alloy mentions in patent claims."}</p>
      </button>)}</div>}
  </section></main>;
  return <main className="login-shell"><section className="login-panel">
    <header className="login-brand"><div><h1>Composition review</h1><p>Review compositions against their source evidence.</p></div></header>
    {error && <div className="login-error" role="alert">{error}</div>}
    {connectionError ? <button onClick={() => void checkSession()}>Retry connection</button> :
      <form className="login-form" onSubmit={(event) => void login(event)}>
        <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus disabled={busy}/></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy}/></label>
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>}
  </section></main>;
}

createRoot(document.getElementById("root")!).render(<App/>);
