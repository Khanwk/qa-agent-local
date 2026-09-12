import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import "./styles.css";

type Mode = "code" | "ui" | "full" | "supervisor";
type View = "overview" | "requirements" | "runs" | "supervisor" | "settings";
type Status = "pass" | "fail" | "needs_review";
type Severity = "critical" | "high" | "medium" | "low";
type Requirement = Record<string, any> & { id: string; title: string; type: string; severity?: Severity; enabled?: boolean };
type Finding = { requirementId: string; title: string; category: string; status: Status; severity?: Severity; triage?: "product_bug" | "test_broken" | "environment" | "requirement_unclear" | "possible_regression"; message: string; file?: string; line?: number; evidence?: string; screenshot?: string; trace?: string; baseline?: string };
type QaResult = { projectName: string; mode: Mode; score: number; releaseStatus: "ready" | "review_required" | "not_ready"; filesScanned: number; findings: Finding[]; git?: any; summary: { passed: number; failed: number; needsReview: number; total: number }; finishedAt: string };

const apiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:4782";
const STATE_KEY = "qa-agent-state-v2";
const HISTORY_KEY = "qa-agent-history-v2";

const defaults: Requirement[] = [
  { id: "REQ-001", title: "Prices must use EUR", type: "currency", currency: "EUR", symbol: "€", forbiddenTokens: ["USD", "GBP", "£", "$"], paths: ["/", "/shop", "/cart"], severity: "high", enabled: false, source: "template" },
  { id: "CODE-001", title: "dispatch must not be in React hook dependencies", type: "forbidden-hook-dependency", identifier: "dispatch", severity: "medium", enabled: false, source: "template" }
];

function getDeviceId() {
  let id = localStorage.getItem("qa-agent-device-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("qa-agent-device-id", id); }
  return id;
}

function App() {
  const [health, setHealth] = useState<any>(null);
  const [supabaseClient, setSupabaseClient] = useState<any>(null);
  const [webPortalUrl, setWebPortalUrl] = useState("");
  const supabase = supabaseClient;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("Client Project");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [mode, setMode] = useState<Mode>("full");
  const [gitBase, setGitBase] = useState("HEAD~1");
  const [requirements, setRequirements] = useState<Requirement[]>(defaults);
  const [requirementText, setRequirementText] = useState("");
  const [proposals, setProposals] = useState<Requirement[]>([]);
  const [result, setResult] = useState<QaResult | null>(null);
  const [history, setHistory] = useState<QaResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [appStatus, setAppStatus] = useState<"unknown" | "online" | "offline">("unknown");
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({});
  const [manualType, setManualType] = useState("route");
  const [manualTitle, setManualTitle] = useState("");
  const [manualValue, setManualValue] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const [watchSupervisor, setWatchSupervisor] = useState(false);
  const [watchState, setWatchState] = useState<"idle" | "watching" | "changed" | "error">("idle");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingJson, setEditingJson] = useState("");
  const lastGitSignature = useRef("");

  useEffect(() => {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) {
      try {
        const state = JSON.parse(saved);
        setProjectPath(state.projectPath || ""); setProjectName(state.projectName || "Client Project"); setBaseUrl(state.baseUrl || "http://localhost:3000"); setGitBase(state.gitBase || "HEAD~1");
        if (Array.isArray(state.requirements)) setRequirements(state.requirements);
      } catch {}
    }
    const savedHistory = localStorage.getItem(HISTORY_KEY);
    if (savedHistory) try { setHistory(JSON.parse(savedHistory)); } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STATE_KEY, JSON.stringify({ projectPath, projectName, baseUrl, gitBase, requirements }));
  }, [projectPath, projectName, baseUrl, gitBase, requirements]);

  useEffect(() => {
    (async () => {
      try {
        const [healthResponse, configResponse] = await Promise.all([fetch(`${apiUrl}/api/health`), fetch(`${apiUrl}/api/runtime-config`)]);
        const healthData = await healthResponse.json();
        const configData = await configResponse.json();
        setHealth(healthData);
        setWebPortalUrl(configData.webPortalUrl || "");
        if (configData.supabaseUrl && configData.supabasePublishableKey) {
          const client = createClient(configData.supabaseUrl, configData.supabasePublishableKey);
          setSupabaseClient(client);
          await verifySession(client);
        } else {
          setAuthChecking(false);
        }
      } catch {
        setHealth({ ok: false, authConfigured: false });
        setAuthChecking(false);
      }
    })();
  }, []);

  async function authHeaders(client = supabase) {
    const deviceId = getDeviceId();
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-QA-Device": deviceId, "X-QA-Device-Name": navigator.userAgent.slice(0, 150) };
    if (client) {
      const { data } = await client.auth.getSession();
      if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    return headers;
  }

  async function verifySession(client = supabase) {
    if (!client) { setAuthChecking(false); setAuthed(false); return; }
    try {
      const { data } = await client.auth.getSession();
      if (!data.session) { setAuthed(false); return; }
      const response = await fetch(`${apiUrl}/api/auth/check`, { headers: await authHeaders(client) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Account verification failed");
      setAuthed(true);
      setAuthError("");
    } catch (error) {
      setAuthed(false);
      setAuthError(error instanceof Error ? error.message : "Account verification failed");
      await client.auth.signOut().catch(() => {});
    } finally { setAuthChecking(false); }
  }


  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setAuthError("");
    if (!supabase) return setAuthError("Supabase is not configured in the local agent.");
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await verifySession(supabase);
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Sign in failed"); }
    finally { setBusy(false); }
  }

  async function signOut() { await supabase?.auth.signOut(); setAuthed(false); setView("overview"); }

  async function api(pathname: string, options: RequestInit = {}) {
    const response = await fetch(`${apiUrl}${pathname}`, { ...options, headers: { ...(await authHeaders()), ...(options.headers || {}) } });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.blob();
    if (!response.ok) throw new Error((payload as any)?.error || `Request failed (${response.status})`);
    return payload;
  }

  async function pickFolder() {
    try { const data: any = await api("/api/project/pick", { method: "POST" }); setProjectPath(data.projectPath); }
    catch (error) { alert(error instanceof Error ? error.message : "Folder picker failed"); }
  }

  async function checkApp() {
    setAppStatus("unknown");
    try { await api("/api/project/probe", { method: "POST", body: JSON.stringify({ baseUrl }) }); setAppStatus("online"); }
    catch { setAppStatus("offline"); }
  }

  function saveHistory(next: QaResult) {
    const updated = [next, ...history].slice(0, 10);
    setHistory(updated); localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  }

  async function runQa(runMode: Mode = mode, onlyRequirement?: Requirement) {
    if (!projectPath.trim()) { setView("settings"); return alert("Select a local project folder first."); }
    setBusy(true);
    try {
      const payload: any = await api("/api/qa/run", { method: "POST", body: JSON.stringify({ projectName, projectPath, baseUrl, mode: runMode, gitBase, requirements: onlyRequirement ? [onlyRequirement] : requirements }) });
      setMode(runMode); setResult(payload); saveHistory(payload); setView(runMode === "supervisor" ? "supervisor" : "runs");
    } catch (error) { alert(error instanceof Error ? error.message : "QA run failed"); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!watchSupervisor || !projectPath.trim() || !authed) { setWatchState(watchSupervisor ? "watching" : "idle"); return; }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data: any = await api("/api/project/git", { method: "POST", body: JSON.stringify({ projectPath, projectName, gitBase }) });
        if (cancelled) return;
        const signature = JSON.stringify({ files: data.files || [], additions: data.additions || 0, deletions: data.deletions || 0 });
        if (lastGitSignature.current && signature !== lastGitSignature.current) {
          setWatchState("changed");
          await runQa("supervisor");
        } else setWatchState("watching");
        lastGitSignature.current = signature;
      } catch { if (!cancelled) setWatchState("error"); }
      if (!cancelled) timer = window.setTimeout(poll, 5000);
    };
    poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [watchSupervisor, projectPath, gitBase, authed]);

  function nextId(prefix = "REQ") {
    const used = new Set(requirements.map((r) => r.id)); let i = 1;
    while (used.has(`${prefix}-${String(i).padStart(3, "0")}`)) i++;
    return `${prefix}-${String(i).padStart(3, "0")}`;
  }

  async function convertWithGemini() {
    if (!requirementText.trim()) return;
    setBusy(true);
    try {
      const data: any = await api("/api/ai/requirements", { method: "POST", body: JSON.stringify({ text: requirementText }) });
      const occupied = new Set(requirements.map((item) => item.id));
      const generated = (data.requirements || []).map((r: Requirement) => {
        const preferred = String(r.id || "").trim();
        let id = preferred && !occupied.has(preferred) ? preferred : "";
        if (!id) {
          let i = 1;
          do { id = `REQ-${String(i++).padStart(3, "0")}`; } while (occupied.has(id));
        }
        occupied.add(id);
        return { ...r, id, enabled: true, source: r.source || "gemini" };
      });
      setProposals(generated);
    } catch (error) { alert(error instanceof Error ? error.message : "Gemini conversion failed"); }
    finally { setBusy(false); }
  }

  function approveProposals() { setRequirements((current) => [...current, ...proposals]); setProposals([]); setRequirementText(""); }

  function addManual() {
    if (!manualTitle.trim() || !manualValue.trim()) return alert("Enter a title and value/path.");
    let rule: Requirement;
    if (manualType === "route") rule = { id: nextId(), title: manualTitle, type: "route", path: manualValue, severity: "high", enabled: true, source: "manual" };
    else if (manualType === "currency") { const currency = manualValue.toUpperCase(); rule = { id: nextId(), title: manualTitle, type: "currency", currency, symbol: currency === "EUR" ? "€" : undefined, forbiddenTokens: currency === "EUR" ? ["USD", "GBP", "£", "$"] : [], requirePresence: true, severity: "high", enabled: true, source: "manual" }; }
    else if (manualType === "forbidden-hook-dependency") rule = { id: nextId("CODE"), title: manualTitle, type: manualType, identifier: manualValue, severity: "medium", enabled: true, source: "manual" };
    else if (manualType === "accessibility") rule = { id: nextId(), title: manualTitle, type: manualType, path: manualValue, severity: "medium", enabled: true, source: "manual" };
    else if (manualType === "visual") rule = { id: nextId(), title: manualTitle, type: manualType, path: manualValue, severity: "medium", enabled: true, source: "manual" };
    else rule = { id: nextId("CODE"), title: manualTitle, type: "text-search", required: manualValue.split(",").map((x) => x.trim()).filter(Boolean), requiredMode: "all", severity: "medium", enabled: true, source: "manual" };
    setRequirements((items) => [...items, rule]); setManualTitle(""); setManualValue("");
  }

  function updateRequirement(index: number, patch: Partial<Requirement>) { setRequirements((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  function removeRequirement(index: number) { setRequirements((items) => items.filter((_, i) => i !== index)); }
  function openEditRequirement(index: number) { setEditingIndex(index); setEditingJson(JSON.stringify(requirements[index], null, 2)); }
  function saveEditedRequirement() {
    if (editingIndex === null) return;
    try {
      const parsed = JSON.parse(editingJson);
      if (!parsed.id || !parsed.title || !parsed.type) throw new Error("Requirement must include id, title and type.");
      setRequirements((items) => items.map((item, i) => i === editingIndex ? { ...parsed, enabled: parsed.enabled !== false } : item));
      setEditingIndex(null); setEditingJson("");
    } catch (error) { alert(error instanceof Error ? error.message : "Invalid requirement JSON"); }
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify({ projectName, projectPath, baseUrl, gitBase, requirements }, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = "qa.config.json"; anchor.click(); URL.revokeObjectURL(href);
  }

  async function importConfig(file?: File) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.requirements)) throw new Error("Config must include a requirements array");
      setProjectName(data.projectName || projectName); setProjectPath(data.projectPath || projectPath); setBaseUrl(data.baseUrl || baseUrl); setGitBase(data.gitBase || gitBase); setRequirements(data.requirements);
    } catch (error) { alert(error instanceof Error ? error.message : "Invalid config"); }
  }

  async function showArtifact(filePath: string) {
    try {
      const response = await fetch(`${apiUrl}/api/artifact?path=${encodeURIComponent(filePath)}`, { headers: await authHeaders() });
      if (!response.ok) throw new Error("Artifact could not be loaded");
      const blob = await response.blob(); setArtifactUrls((items) => ({ ...items, [filePath]: URL.createObjectURL(blob) }));
    } catch (error) { alert(error instanceof Error ? error.message : "Artifact could not be loaded"); }
  }

  async function downloadArtifact(filePath: string) {
    try {
      const response = await fetch(`${apiUrl}/api/artifact?path=${encodeURIComponent(filePath)}&download=1`, { headers: await authHeaders() });
      if (!response.ok) throw new Error("Artifact could not be downloaded");
      const blob = await response.blob(); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filePath.split(/[\\/]/).pop() || "artifact"; anchor.click(); URL.revokeObjectURL(href);
    } catch (error) { alert(error instanceof Error ? error.message : "Artifact could not be downloaded"); }
  }

  function copyFix(finding: Finding) {
    const text = `Fix this QA finding without changing unrelated behavior.\nRequirement: ${finding.requirementId} - ${finding.title}\nStatus: ${finding.status}\nIssue: ${finding.message}${finding.file ? `\nFile: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}${finding.evidence ? `\nEvidence:\n${finding.evidence}` : ""}`;
    navigator.clipboard.writeText(text);
  }

  const counts = useMemo(() => ({ pass: result?.summary.passed || 0, fail: result?.summary.failed || 0, review: result?.summary.needsReview || 0 }), [result]);
  const filteredFindings = useMemo(() => (result?.findings || []).filter((finding) => (statusFilter === "all" || finding.status === statusFilter) && (categoryFilter === "all" || finding.category === categoryFilter)), [result, statusFilter, categoryFilter]);
  const categories = useMemo(() => [...new Set((result?.findings || []).map((f) => f.category))], [result]);

  if (!health || authChecking) return <div className="splash"><div className="spinner"/><b>Starting QA Agent…</b></div>;
  if (!health.authConfigured || !supabase) return <div className="auth-shell"><div className="auth-card"><div className="brand">QA Agent <small>V2</small></div><h1>Setup required</h1><p>Authentication is fail-closed. Add your Supabase URL and publishable key to <code>.env</code>, then restart the agent. No UI rebuild is required.</p><div className="error">SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.</div></div></div>;
  if (!authed) return <div className="auth-shell"><form className="auth-card" onSubmit={signIn}><div className="brand">QA Agent <small>V2</small></div><h1>Sign in</h1><p>Use an eligible account created on the QA Agent web portal.</p><label>Email<input autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}/></label><label>Password<input autoComplete="current-password" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)}/></label><button disabled={busy}>{busy ? "Checking access…" : "Sign in"}</button>{authError && <div className="error">{authError}</div>}<small>Signup is intentionally available only on the web portal.{webPortalUrl && <> <a href={webPortalUrl} target="_blank" rel="noreferrer">Create account</a></>}</small></form></div>;

  const releaseCopy = result?.releaseStatus === "ready" ? ["READY", "All executed checks passed."] : result?.releaseStatus === "review_required" ? ["REVIEW REQUIRED", "No blocking failures, but human review remains."] : ["NOT READY", result ? "Blocking QA failures must be resolved." : "Run QA before approving this project."];

  const nav: { id: View; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" }, { id: "requirements", label: "Requirements", count: requirements.filter((r) => r.enabled !== false).length }, { id: "runs", label: "Test runs", count: result?.summary.failed }, { id: "supervisor", label: "Supervisor" }, { id: "settings", label: "Settings" }
  ];

  const Results = () => !result ? <section className="empty panel"><b>No QA run yet</b><p>Choose a QA mode and run the project. Results, evidence and traces will appear here.</p></section> : <>
    <section className={`release-card ${result.releaseStatus}`}><div><span className="release-label">RELEASE STATUS</span><h2>{releaseCopy[0]}</h2><p>{releaseCopy[1]}</p></div><div className="release-numbers"><b>{result.summary.failed}</b><span>blocking</span><b>{result.summary.needsReview}</b><span>review</span><b>{result.summary.passed}</b><span>passed</span></div></section>
    <section className="panel"><div className="panel-head"><div><h2>Latest run</h2><p>{result.filesScanned} source file(s) scanned · {result.mode}{result.git ? ` · ${result.git.files.length} changed file(s) · +${result.git.additions}/-${result.git.deletions}` : ""}</p></div><button className="secondary" onClick={() => navigator.clipboard.writeText(JSON.stringify(result, null, 2))}>Copy JSON</button></div>
      <div className="filters"><button className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>All {result.summary.total}</button><button className={statusFilter === "fail" ? "active" : ""} onClick={() => setStatusFilter("fail")}>Failed {result.summary.failed}</button><button className={statusFilter === "needs_review" ? "active" : ""} onClick={() => setStatusFilter("needs_review")}>Review {result.summary.needsReview}</button><button className={statusFilter === "pass" ? "active" : ""} onClick={() => setStatusFilter("pass")}>Passed {result.summary.passed}</button><select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option value="all">All types</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></div>
      {filteredFindings.map((finding, index) => {
        const req = requirements.find((r) => r.id === finding.requirementId);
        return <article className={`finding ${finding.status}`} key={`${finding.requirementId}-${finding.category}-${index}`}><div className="finding-icon">{finding.status === "pass" ? "✓" : finding.status === "fail" ? "×" : "!"}</div><div className="finding-body"><div className="finding-title"><div><b>{finding.requirementId} · {finding.title}</b><span className={`severity ${finding.severity || "medium"}`}>{finding.severity || "medium"}</span><span className="category">{finding.category}</span>{finding.triage && <span className={`triage ${finding.triage}`}>{finding.triage.replaceAll("_", " ")}</span>}</div></div><p>{finding.message}</p>{finding.file && <code>{finding.file}{finding.line ? `:${finding.line}` : ""}</code>}{finding.evidence && <pre>{finding.evidence}</pre>}{finding.screenshot && artifactUrls[finding.screenshot] && <img className="evidence-shot" src={artifactUrls[finding.screenshot]} alt={`Failure evidence for ${finding.requirementId}`}/>}<div className="finding-actions">{finding.screenshot && <button onClick={() => showArtifact(finding.screenshot!)}>{artifactUrls[finding.screenshot] ? "Refresh screenshot" : "View screenshot"}</button>}{finding.trace && <button onClick={() => downloadArtifact(finding.trace!)}>Download trace</button>}{finding.baseline && <button onClick={() => showArtifact(finding.baseline!)}>View baseline</button>}{finding.file && <button onClick={() => navigator.clipboard.writeText(`${projectPath}/${finding.file}${finding.line ? `:${finding.line}` : ""}`)}>Copy location</button>}{finding.status !== "pass" && <button onClick={() => copyFix(finding)}>Copy fix prompt</button>}{req && <button onClick={() => runQa(finding.category === "code" ? "code" : finding.category === "api" ? "full" : "ui", req)}>Re-run check</button>}</div></div></article>;
      })}
    </section>
  </>;

  return <div className="layout">
    <aside><div className="brand">QA Agent <small>V2</small></div><div className="project-mini"><b>{projectName}</b><span className={`dot ${appStatus}`}/><small>{appStatus === "online" ? "App reachable" : appStatus === "offline" ? "App offline" : "App not checked"}</small></div><nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><span>{item.label}</span>{typeof item.count === "number" && item.count > 0 && <em>{item.count}</em>}</button>)}</nav><div className="local"><b>Local-first</b><small>Source scanning and browser execution stay on this machine.</small></div><button className="signout" onClick={signOut}>Sign out</button></aside>
    <main><div className="mobile-tabs">{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}</div>
      <header><div><span className="eyebrow">{view.toUpperCase()}</span><h1>{view === "overview" ? projectName : nav.find((n) => n.id === view)?.label}</h1><p>{view === "overview" ? "Verify requirements, code and real browser behavior before the client sees a regression." : "Requirements-driven QA with evidence, not generic AI suggestions."}</p></div>{view !== "settings" && <button className="primary" onClick={() => runQa(mode)} disabled={busy}>{busy ? "Running QA…" : "Run QA"}</button>}</header>

      {view === "overview" && <>
        <section className={`release-card hero-release ${result?.releaseStatus || "not_ready"}`}><div><span className="release-label">CURRENT GATE</span><h2>{releaseCopy[0]}</h2><p>{releaseCopy[1]}</p></div><div className="score"><strong>{result ? `${result.score}%` : "—"}</strong><span>QA score</span></div></section>
        <section className="mode-grid"><button onClick={() => { setMode("code"); runQa("code"); }}><span>CODE QA</span><b>Architecture & rules</b><p>AST checks, required patterns, routes, currency and team standards.</p></button><button onClick={() => { setMode("ui"); runQa("ui"); }}><span>UI QA</span><b>Real browser behavior</b><p>Playwright flows, runtime errors, accessibility and visual checks.</p></button><button onClick={() => { setMode("full"); runQa("full"); }}><span>FULL PROJECT</span><b>Release verification</b><p>Code + UI + API checks with a single release decision.</p></button><button onClick={() => { setMode("supervisor"); runQa("supervisor"); }}><span>AGENT SUPERVISOR</span><b>Review AI changes</b><p>Committed, staged, unstaged and untracked changes against requirements.</p></button></section>
        <section className="stats"><div><strong>{requirements.filter((r) => r.enabled !== false).length}</strong><span>Active requirements</span></div><div><strong>{counts.pass}</strong><span>Passed</span></div><div><strong>{counts.fail}</strong><span>Failed</span></div><div><strong>{counts.review}</strong><span>Needs review</span></div></section>
        {result?.git && <section className="panel change-summary"><div><span className="eyebrow">RECENT CHANGE</span><h2>{result.git.files.length} files · +{result.git.additions} / -{result.git.deletions}</h2><p>{result.git.untrackedFiles?.length || 0} untracked · {result.git.unstagedFiles?.length || 0} unstaged · {result.git.stagedFiles?.length || 0} staged · {result.git.committedFiles?.length || 0} committed since {result.git.base}</p></div></section>}
      </>}

      {view === "requirements" && <>
        <section className="panel"><div className="panel-head"><div><h2>Turn client requirements into checks</h2><p>Only the text below is sent to Gemini. Never paste secrets or an entire repository.</p></div><div className="actions"><button className="secondary" onClick={exportConfig}>Export</button><button className="secondary" onClick={() => importRef.current?.click()}>Import</button><input ref={importRef} hidden type="file" accept="application/json" onChange={(e) => importConfig(e.target.files?.[0])}/></div></div><div className="ai-box"><textarea placeholder='Example: "Guest users can checkout and all prices use EUR."' value={requirementText} onChange={(e) => setRequirementText(e.target.value)}/><button className="primary" onClick={convertWithGemini} disabled={busy || !health.geminiConfigured}>{health.geminiConfigured ? "Convert with Gemini" : "Gemini not configured"}</button></div>{proposals.length > 0 && <div className="proposal"><div><b>Gemini proposed {proposals.length} atomic checks</b><p>Review them before adding. Nothing is saved automatically.</p></div>{proposals.map((rule) => <div className="proposal-row" key={rule.id}><span>{rule.id}</span><b>{rule.title}</b><code>{rule.type}</code></div>)}<div className="actions"><button className="primary" onClick={approveProposals}>Approve all</button><button className="secondary" onClick={() => setProposals([])}>Discard</button></div></div>}</section>
        <section className="panel"><div className="panel-head"><div><h2>Add deterministic check</h2><p>No AI required.</p></div></div><div className="manual-grid"><select value={manualType} onChange={(e) => setManualType(e.target.value)}><option value="route">Route exists</option><option value="currency">Currency</option><option value="forbidden-hook-dependency">Forbidden hook dependency</option><option value="text-search">Required code tokens</option><option value="accessibility">Accessibility page</option><option value="visual">Visual baseline</option></select><input placeholder="Requirement title" value={manualTitle} onChange={(e) => setManualTitle(e.target.value)}/><input placeholder={manualType === "route" || manualType === "visual" || manualType === "accessibility" ? "/checkout" : manualType === "currency" ? "EUR" : manualType === "forbidden-hook-dependency" ? "dispatch" : "BackendInstance, handlerError"} value={manualValue} onChange={(e) => setManualValue(e.target.value)}/><button className="secondary" onClick={addManual}>Add check</button></div></section>
        <section className="panel"><div className="panel-head"><div><h2>Requirements</h2><p>{requirements.filter((r) => r.enabled !== false).length} enabled · {requirements.length} total</p></div></div>{requirements.map((rule, index) => <div className={`req ${rule.enabled === false ? "disabled-rule" : ""}`} key={`${rule.id}-${index}`}><input className="toggle" type="checkbox" checked={rule.enabled !== false} onChange={(e) => updateRequirement(index, { enabled: e.target.checked })}/><div className="req-main"><b>{rule.id}</b><span>{rule.title}</span><small>{rule.source || "local"}</small></div><code>{rule.type}</code><select className="severity-select" value={rule.severity || "medium"} onChange={(e) => updateRequirement(index, { severity: e.target.value as Severity })}><option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select><div className="req-actions"><button className="edit-rule" onClick={() => openEditRequirement(index)}>Edit</button><button className="remove" onClick={() => removeRequirement(index)} aria-label={`Remove ${rule.title}`}>×</button></div></div>)}</section>
      </>}

      {view === "runs" && <><Results/>{history.length > 1 && <section className="panel"><div className="panel-head"><div><h2>Recent runs</h2><p>Last {history.length} runs stored locally.</p></div></div><div className="history">{history.slice(1).map((item, i) => <button key={`${item.finishedAt}-${i}`} onClick={() => setResult(item)}><b>{item.releaseStatus.replace("_", " ").toUpperCase()}</b><span>{new Date(item.finishedAt).toLocaleString()}</span><em>{item.summary.failed} failed · {item.summary.needsReview} review</em></button>)}</div></section>}</>}

      {view === "supervisor" && <><section className="panel supervisor-intro"><span className="eyebrow">CURSOR · CLAUDE CODE · CODEX</span><h2>Verify what the coding agent actually changed.</h2><p>Supervisor includes committed changes since your base plus staged, unstaged and untracked files, then runs the same saved requirements against the affected project.</p><div className="supervisor-run"><label>Git base<input value={gitBase} onChange={(e) => setGitBase(e.target.value)}/></label><button className="primary" onClick={() => runQa("supervisor")} disabled={busy}>{busy ? "Reviewing changes…" : "Run Supervisor"}</button><label className="watch-toggle"><input type="checkbox" checked={watchSupervisor} onChange={(e) => { lastGitSignature.current = ""; setWatchSupervisor(e.target.checked); }}/><span>Watch coding-agent changes</span></label><span className={`watch-status ${watchState}`}>{watchSupervisor ? (watchState === "watching" ? "● Watching every 5s" : watchState === "changed" ? "● Change found — verifying" : watchState === "error" ? "● Watch unavailable" : "● Starting watch") : "Watch is off"}</span></div></section><Results/></>}

      {view === "settings" && <section className="panel settings"><div className="panel-head"><div><h2>Project setup</h2><p>The local agent reads this folder directly. Source code is not uploaded to the QA Agent web portal.</p></div></div><div className="settings-grid"><label>Project name<input value={projectName} onChange={(e) => setProjectName(e.target.value)}/></label><label>Local project path<div className="path-row"><input placeholder="C:\\Projects\\client-app" value={projectPath} onChange={(e) => setProjectPath(e.target.value)}/><button className="secondary" type="button" onClick={pickFolder}>Browse</button></div></label><label>Application URL<div className="path-row"><input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setAppStatus("unknown"); }}/><button className="secondary" type="button" onClick={checkApp}>Test</button></div><small className={`app-state ${appStatus}`}>{appStatus === "online" ? "● Application reachable" : appStatus === "offline" ? "● Application not reachable" : "Application status not checked"}</small></label><label>Default run mode<select value={mode} onChange={(e) => setMode(e.target.value as Mode)}><option value="code">Code QA</option><option value="ui">UI QA</option><option value="full">Full Project</option><option value="supervisor">AI Change Supervisor</option></select></label></div><div className="config-actions"><button className="secondary" onClick={exportConfig}>Export qa.config.json</button><button className="secondary" onClick={() => importRef.current?.click()}>Import config</button></div></section>}
      {editingIndex !== null && <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditingIndex(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-requirement-title" onMouseDown={(e) => e.stopPropagation()}><div className="panel-head"><div><h2 id="edit-requirement-title">Edit requirement</h2><p>Advanced JSON editor. Invalid JSON is never saved.</p></div><button className="remove" onClick={() => setEditingIndex(null)} aria-label="Close">×</button></div><textarea className="json-editor" value={editingJson} onChange={(e) => setEditingJson(e.target.value)} spellCheck={false}/><div className="modal-actions"><button className="secondary" onClick={() => setEditingIndex(null)}>Cancel</button><button className="primary" onClick={saveEditedRequirement}>Save requirement</button></div></div></div>}

    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
