"use client";
// SERVERS-AI (5 Nov 2026): Settings → Servers & AI, for organisation admins. The company's own Linux servers (Pulse
// Runner, docs/runner/PROTOCOL.md) run AI work with the company's own Claude Code / Codex sign-in, in a sandbox, and
// only ever call Pulse (no open ports). Built from the calm kit (components/page-kit, as Work → My day): stat tiles, a
// numbered "Connect a server" card with the one-line install and the code's countdown, servers as stripe cards (online,
// what is signed in), recent jobs with their live status, and a test job per server. Facts in the rail.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, Bot, CircleAlert, CircleCheck, Clock3, Copy, ExternalLink, KeyRound, ListChecks, LoaderCircle, LogIn, LogOut, Pencil, Play, Server, ShieldAlert, ShieldCheck, Terminal, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ago } from "../lib/format";
import { post } from "../records";
import { Card, CalmGrid, EmptyState, Facts, Quiet, SectionHeader, StatTile, StatTiles, StripeCard, StripeList, calm, type Tone } from "../components/page-kit";
import css from "./servers.module.css";

type Cli = { installed: boolean; loggedIn: boolean; version: string | null; plan: string | null; needsLogin?: boolean; lapsedAt?: string | null };
// RUNNERS-FULL: a server's access (set by an admin, every change in its ledger) and a login started from this page.
type Level = "read-only" | "read-write" | "full";
type AccessEntry = { at: string; approvedBy: string | null; fromLevel: Level | null; toLevel: Level; sandbox: boolean; aiEmployees: boolean; reason: string | null };
type Login = { id: string; tool: "claude" | "codex"; action: "login" | "logout"; status: string; url: string | null; userCode: string | null; needsCode: boolean;
  errorCode: string | null; errorMessage: string | null; createdAt: string; updatedAt: string };
type Runner = { id: string; name: string; hostname: string | null; os: string | null; arch: string | null; version: string | null; state: "ready" | "draining";
  maxConcurrent: number; lastSeenAt: string | null; createdAt: string; capabilitiesAt: string | null; online: boolean; reported: boolean; running: number; queued: number;
  claude: Cli; codex: Cli; isolation: { verified: boolean; off: boolean; mode: string | null; reason: string | null }; maxProfile: string | null;
  usage: { jobs: number; succeeded: number; failed: number; costUsd: number; minutes: number } | null;
  accessLevel: Level; sandbox: boolean; aiEmployees: boolean; accessSetAt: string | null; accessSetBy: string | null; accessLog: AccessEntry[]; login: Login | null;
  allowNoSandbox?: boolean;
  system: { cpu?: { cores?: number | null }; ram?: { totalBytes?: number | null }; disk?: { freeBytes?: number | null } } | null };
type Job = { id: string; runnerId: string; runnerName: string; kind: "claude" | "codex" | "shell-safe"; profile: string; status: string; dryRun: boolean; summary: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; lastState: string | null; errorCode: string | null; errorMessage: string | null; exitCode: number | null;
  durationMs: number | null; costUsd: number | null; eventCount: number; requestedBy: string | null; requestedByType?: "person" | "ai-employee"; accessLevel?: Level | null; sandbox?: boolean | null;
  /** AI-SERVER-TOOLS (1590): whom the job was done for (the person who asked the AI employee). */
  requestedFor?: string | null };
type Data = { runners: Runner[]; pairing: { waiting: number; until: string | null } | null; jobs: Job[]; mcpUrl: string; command: string; now: string };
type Code = { code: string; expiresAt: string; command: string };
type Event = { seq: number; ts: string | null; type: string; data: Record<string, unknown> };

const why = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const LIVE = ["queued", "delivered", "running", "cancelling"];
const STATUS: Record<string, { label: string; tone?: Tone }> = {
  queued: { label: "Waiting for the server" }, delivered: { label: "Sent to the server" }, running: { label: "Running" }, cancelling: { label: "Stopping", tone: "warn" },
  succeeded: { label: "Done", tone: "good" }, failed: { label: "Failed", tone: "bad" }, timed_out: { label: "Ran out of time", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "warn" }, rejected: { label: "Refused by the server", tone: "bad" },
};
const KIND: Record<Job["kind"], string> = { claude: "Claude", codex: "Codex", "shell-safe": "Server check" };
const TESTS = [
  { key: "check", label: "Server check (no AI)", body: { kind: "shell-safe", command: ["uname", "-srm"] } },
  { key: "claude", label: "Claude says hello", body: { kind: "claude", prompt: "Reply with one short sentence saying hello from this server. Do not use any tools.", costCapUsd: 0.25, timeLimitSec: 180 } },
  { key: "codex", label: "Codex says hello", body: { kind: "codex", prompt: "Reply with one short sentence saying hello from this server. Do not run any commands.", costCapUsd: 0.25, timeLimitSec: 180 } },
] as const;
const LEVELS: { key: Level; label: string; text: string }[] = [
  { key: "read-only", label: "Read only", text: "AI reads files and Pulse. Nothing on the server changes." },
  { key: "read-write", label: "Read and write", text: "AI may also create and change files in its job folder. Each job is approved." },
  { key: "full", label: "Full", text: "AI may also run shell commands, and sudo if the server's runner user may. Use with care." },
];
const levelLabel = (l?: string | null) => LEVELS.find((x) => x.key === l)?.label ?? "Read only";
const LOGIN_LIVE = ["requested", "starting", "waiting", "verifying"];
const TOOL: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };
const gb = (n?: number | null) => typeof n === "number" ? `${Math.round(n / 1073741824)} GB` : null;
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "Pulse could not load this. Try again."); return d as T;
}
function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(() => notify({ id: "servers-copy", tone: "success", title: `${what} copied`, timeout: 2000 }),
    () => notify({ id: "servers-copy", tone: "error", title: "Copy did not work", message: "Select the text and copy it yourself." }));
}

export function ServersSettings() {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState("");
  const [code, setCode] = useState<Code | null>(null), [making, setMaking] = useState(false);
  const [open, setOpen] = useState<string | null>(null), [now, setNow] = useState(() => Date.now());
  // A code that was used: its server shows up in the list, so the card says so and closes.
  const waitingFrom = useRef<number | null>(null);
  const load = useCallback(() => get<Data>("admin/runners").then((d) => {
    if (waitingFrom.current !== null && d.runners.length > waitingFrom.current) {
      notify({ id: "servers-paired", tone: "success", title: "Server connected", message: `${d.runners.at(-1)?.name} paired with Pulse.` });
      waitingFrom.current = null; setCode(null);
    }
    setData(d); setError("");
  }).catch((e) => setError(why(e))), []);
  useEffect(() => { void load(); }, [load]);
  // Live: every 3 s while a job is moving or a code waits for its server, else every 15 s; never while the tab is hidden.
  const busy = !!code || !!data?.jobs.some((j) => LIVE.includes(j.status)) || !!data?.runners.some((r) => r.login && LOGIN_LIVE.includes(r.login.status));
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, busy ? 3000 : 15000);
    return () => clearInterval(t);
  }, [busy, load]);
  useEffect(() => { if (!code) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [code]);

  async function makeCode() {
    setMaking(true);
    try { const c = await post<Code>("admin/runners/pair-code", {}); waitingFrom.current = data?.runners.length ?? 0; setCode(c); setNow(Date.now()); }
    catch (e) { notify({ id: "servers-code", tone: "error", title: "No code made", message: why(e) }); } finally { setMaking(false); }
  }

  if (error && !data) return <Card label="Servers & AI"><EmptyState icon={CircleAlert} tone="bad" title="Servers & AI did not load" text={error} action={{ onClick: () => void load(), label: "Try again" }} /></Card>;
  if (!data) return <Card label="Loading servers"><p className={calm.quiet} role="status"><LoaderCircle size={14} className={css.spin} aria-hidden="true" /> Loading your servers…</p></Card>;

  const online = data.runners.filter((r) => r.online).length;
  const claude = data.runners.filter((r) => r.claude.loggedIn).length;
  const moving = data.jobs.filter((j) => LIVE.includes(j.status)).length;
  const left = code ? new Date(code.expiresAt).getTime() - now : 0;
  const selected = data.runners.find((r) => r.id === open) ?? null;
  // A login that lapsed on a server (it was signed in, and now is not): one line each, with the way back.
  const lapsed = data.runners.flatMap((r) => (["claude", "codex"] as const).filter((t) => r[t].needsLogin).map((t) => ({ r, t })));

  return <div className={css.stack} data-grow="" data-servers="">
    <StatTiles count={4} label="Servers at a glance">
      <StatTile label="Servers" value={data.runners.length} />
      <StatTile label="Online now" value={online} tone={data.runners.length && !online ? "warn" : online ? "good" : undefined} />
      <StatTile label="Claude connected" value={claude} />
      <StatTile label="Jobs running" value={moving} />
    </StatTiles>
    <CalmGrid railLabel="About your servers" rail={<Rail data={data} />}>
      {lapsed.length ? <Card label="Needs a new login">
        <SectionHeader icon={CircleAlert} title="Needs a new login" tone="bad" note={String(lapsed.length)} />
        <ul className={css.jobs}>{lapsed.map(({ r, t }) => <li key={`${r.id}-${t}`} className={css.row}>
          <span>{TOOL[t]} on <b>{r.name}</b> is signed out{r[t].lapsedAt ? ` since ${ago(r[t].lapsedAt!)}` : ""}. Jobs that need it will fail until someone signs in again.</span>
          <button type="button" className={calm.btnPrimary} onClick={() => setOpen(r.id)}><LogIn size={14} aria-hidden="true" />Connect {TOOL[t]}</button>
        </li>)}</ul>
      </Card> : null}
      {code ? <Card label="Connect a server">
        <SectionHeader icon={KeyRound} title="Connect a server" note={left > 0 ? <span aria-live="polite">Code works for {clock(left)}</span> : "Code expired"} tone={left > 0 ? undefined : "bad"} />
        <ol className={css.steps}>
          <li><b>Run this on your Linux server</b><small>It needs Node.js 20 or newer and bubblewrap. It installs Pulse Runner as a service and pairs it with this organisation.</small>
            <CommandBox command={code.command} /></li>
          <li><b>The pairing code in it</b>
            <span className={css.code} data-expired={left > 0 ? undefined : ""} aria-label={`Pairing code ${code.code.split("").join(" ")}`}>{code.code}</span>
            <small>One server, one use, ten minutes. Pulse keeps only a fingerprint of it.</small></li>
          <li><b>Connect Claude or Codex</b><small>Once the server shows up, open it here and press Connect Claude or Connect Codex. You finish the sign-in in your own browser; the sign-in stays on your server and Pulse never sees it.</small></li>
        </ol>
        <div className={css.row}>
          {left > 0 ? <p className={calm.quiet}><LoaderCircle size={14} className={css.spin} aria-hidden="true" /> Waiting for the server…</p>
            : <button type="button" className={calm.btnPrimary} onClick={() => void makeCode()} disabled={making}>Make a new code</button>}
          <button type="button" className={calm.btn} onClick={() => { waitingFrom.current = null; setCode(null); }}><X size={14} aria-hidden="true" />Close</button>
        </div>
      </Card> : null}

      {data.runners.length ? <Card label="Your servers">
        <SectionHeader icon={Server} title="Your servers" note={`${online} of ${data.runners.length} online`} />
        <StripeList label="Servers">
          {data.runners.map((r) => <StripeCard key={r.id} icon={Server} stripe={r.online ? 150 : 30} current={open === r.id}
            title={r.name} text={place(r)} onClick={() => setOpen(open === r.id ? null : r.id)}
            badge={r.online ? r.isolation.verified || !r.reported ? { label: r.state === "draining" ? "Online · finishing work" : "Online", tone: "good" } : r.isolation.off ? { label: "Online · sandbox off", tone: "warn" } : { label: "Sandbox not working", tone: "bad" } : { label: r.lastSeenAt ? `Offline · seen ${ago(r.lastSeenAt)}` : "Not seen yet", tone: "warn" }}
            end={<span className={css.signins}><SignIn name="Claude" cli={r.claude} /><SignIn name="Codex" cli={r.codex} /></span>} />)}
        </StripeList>
        {!code ? <div className={css.row}><button type="button" className={calm.btn} onClick={() => void makeCode()} disabled={making}><KeyRound size={14} aria-hidden="true" />Connect another server</button></div> : null}
      </Card> : !code ? <Card label="Connect a server">
        <EmptyState icon={Server} title="Run AI work on your own server"
          text={<>Connect a Linux server you control. Pulse Runner calls Pulse over HTTPS (no open ports), runs your AI employees with your own Claude or ChatGPT (Codex) sign-in, in a sandbox, and reports back. You run one line on the server:</>}
          action={{ onClick: () => void makeCode(), label: making ? "Making a code…" : "Connect a server" }} />
        <CommandBox command={data.command} sample />
      </Card> : null}

      {selected ? <ServerDetail key={selected.id} r={selected} onChanged={() => void load()} onGone={() => { setOpen(null); void load(); }} /> : null}

      <RootAccess onChanged={() => void load()} />
      <Jobs jobs={data.jobs} onChanged={() => void load()} />
      <AiAccess />
    </CalmGrid>
  </div>;
}

function place(r: Runner) {
  const bits = [r.hostname && r.hostname !== r.name ? r.hostname : null, [r.os, r.arch].filter(Boolean).join(" ") || null, r.version ? `Runner ${r.version}` : null,
    r.running ? `${r.running} running` : null, r.queued ? `${r.queued} waiting` : null];
  return bits.filter(Boolean).join(" · ") || "Waiting for its first report";
}

/** A server's usage, the last 30 days, in one line ("4 jobs · 3 done, 1 failed · 12 minutes · $0.40"). */
function usageLine(u: Runner["usage"]) {
  if (!u?.jobs) return "No jobs yet";
  const ended = [u.succeeded ? `${u.succeeded} done` : null, u.failed ? `${u.failed} failed` : null].filter(Boolean).join(", ");
  return [`${u.jobs} ${u.jobs === 1 ? "job" : "jobs"}`, ended || null, u.minutes ? `${u.minutes} min` : null, u.costUsd ? `$${u.costUsd.toFixed(2)}` : null].filter(Boolean).join(" · ");
}

function SignIn({ name, cli }: { name: string; cli: Cli }) {
  const tone = cli.loggedIn ? "good" : cli.installed ? "warn" : undefined;
  const title = cli.loggedIn ? `${name} connected${cli.plan ? ` (${cli.plan})` : ""}` : cli.installed ? `${name} installed, not signed in` : `${name} not installed`;
  return <span className={calm.badge} data-tone={tone} title={title} aria-label={title}>{cli.loggedIn ? <CircleCheck size={12} aria-hidden="true" /> : null}{name}</span>;
}

function CommandBox({ command, sample }: { command: string; sample?: boolean }) {
  return <div className={css.command} data-sample={sample ? "" : undefined}>
    <Terminal size={14} aria-hidden="true" />
    <code>{command}</code>
    {sample ? <small>The code comes when you press Connect a server.</small>
      : <button type="button" className={calm.btn} onClick={() => copy(command, "Install command")}><Copy size={14} aria-hidden="true" />Copy</button>}
  </div>;
}

function ServerDetail({ r, onChanged, onGone }: { r: Runner; onChanged: () => void; onGone: () => void }) {
  const [busy, setBusy] = useState(""), [name, setName] = useState(r.name), [renaming, setRenaming] = useState(false), [confirm, setConfirm] = useState(false);
  async function act(what: string, run: () => Promise<unknown>, done: string) {
    setBusy(what);
    try { await run(); notify({ id: `server-${what}`, tone: "success", title: done, timeout: 2500 }); }
    catch (e) { notify({ id: `server-${what}`, tone: "error", title: "That did not work", message: why(e) }); } finally { setBusy(""); }
  }
  const facts: [string, ReactNode][] = [
    ["Status", r.online ? r.state === "draining" ? "Online, finishing its work" : "Online" : r.lastSeenAt ? `Offline since ${ago(r.lastSeenAt)}` : "Not seen yet"],
    ["Claude", r.claude.loggedIn ? `Signed in${r.claude.plan ? ` · ${r.claude.plan}` : ""}${r.claude.version ? ` · ${r.claude.version}` : ""}` : r.claude.installed ? "Installed, not signed in" : "Not installed"],
    ["Codex", r.codex.loggedIn ? `Signed in${r.codex.version ? ` · ${r.codex.version}` : ""}` : r.codex.installed ? "Installed, not signed in" : "Not installed"],
    ["Sandbox", r.isolation.verified ? `${r.isolation.mode ?? "Sandbox"} working` : r.isolation.off ? "Turned off on the server. Jobs run, but are not sealed off from the server's files." : r.reported ? `Not working${r.isolation.reason ? `: ${r.isolation.reason}` : ""}. Jobs will be refused.` : "Not reported yet"],
    ["Access", `${levelLabel(r.accessLevel)}${r.accessLevel !== "read-only" ? r.sandbox ? " · in the sandbox" : " · sandbox off" : ""}${r.aiEmployees ? " · AI employees may use it" : ""}`],
    ["Jobs at once", String(r.maxConcurrent)],
    ...(r.maxProfile ? [["Most it allows", r.maxProfile === "read-only" ? "Read only" : r.maxProfile === "write" ? "Read and write files" : "Files and shell"] as [string, ReactNode]] : []),
    ...(r.system ? [["Machine", [r.system.cpu?.cores ? `${r.system.cpu.cores} cores` : null, gb(r.system.ram?.totalBytes) ? `${gb(r.system.ram?.totalBytes)} memory` : null, gb(r.system.disk?.freeBytes) ? `${gb(r.system.disk?.freeBytes)} free` : null].filter(Boolean).join(" · ") || "—"] as [string, ReactNode]] : []),
    ["Connected", ago(r.createdAt)],
    ["Last 30 days", usageLine(r.usage)],
  ];
  return <Card label={`Server ${r.name}`}>
    <SectionHeader icon={Server} title={r.name} note={r.hostname ?? undefined} />
    <Facts items={facts} />
    <SignInPanel r={r} onChanged={onChanged} />
    <AccessPanel r={r} onChanged={onChanged} />
    <SectionHeader icon={Play} title="Start a test job" as="h3" />
    <div className={css.row}>
      {TESTS.map((t) => {
        const off = !r.online || (t.key === "claude" && !r.claude.loggedIn) || (t.key === "codex" && !r.codex.loggedIn);
        return <button key={t.key} type="button" className={t.key === "check" ? calm.btnPrimary : calm.btn} disabled={off || !!busy}
          title={!r.online ? "The server is offline" : off ? `Sign in to ${KIND[t.key as "claude" | "codex"]} on the server first (pulse-runner login)` : undefined}
          onClick={() => void act(`test-${t.key}`, async () => { await post(`admin/runners/${r.id}/jobs`, t.body); onChanged(); }, `${t.label}: sent to ${r.name}`)}>
          {busy === `test-${t.key}` ? <LoaderCircle size={14} className={css.spin} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{t.label}</button>;
      })}
    </div>
    <SectionHeader icon={Pencil} title="Manage" as="h3" />
    {renaming ? <form className={css.row} onSubmit={(e) => { e.preventDefault(); void act("rename", async () => { await post(`admin/runners/${r.id}/rename`, { name }); setRenaming(false); onChanged(); }, "Renamed"); }}>
      <label className={css.field}><span>Name</span><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <button type="submit" className={calm.btnPrimary} disabled={!!busy || !name.trim()}>Save</button>
      <button type="button" className={calm.btn} onClick={() => { setRenaming(false); setName(r.name); }}>Cancel</button>
    </form> : <div className={css.row}>
      <button type="button" className={calm.btn} onClick={() => setRenaming(true)}><Pencil size={14} aria-hidden="true" />Rename</button>
      {confirm ? <>
        <span className={calm.quiet}>Its credential stops working at once and its unfinished jobs are cancelled.</span>
        <button type="button" className={`${calm.btn} ${css.danger}`} disabled={!!busy} onClick={() => void act("revoke", async () => { await post(`admin/runners/${r.id}/revoke`, {}); onGone(); }, `${r.name} disconnected`)}><Ban size={14} aria-hidden="true" />Disconnect it</button>
        <button type="button" className={calm.btn} onClick={() => setConfirm(false)}>Keep it</button>
      </> : <button type="button" className={`${calm.btn} ${css.danger}`} onClick={() => setConfirm(true)}><Ban size={14} aria-hidden="true" />Disconnect</button>}
    </div>}
  </Card>;
}

/** RUNNERS-FULL: Connect Claude / Codex. The server runs the CLI's own sign-in; this shows its link (and code) for you to
 *  finish in your own browser with your own subscription. The sign-in stays on the server. */
function SignInPanel({ r, onChanged }: { r: Runner; onChanged: () => void }) {
  const [busy, setBusy] = useState(""), [pasted, setPasted] = useState("");
  const l = r.login, live = !!l && LOGIN_LIVE.includes(l.status);
  async function act(what: string, run: () => Promise<unknown>, done?: string) {
    setBusy(what);
    try { await run(); if (done) notify({ id: `login-${what}`, tone: "success", title: done, timeout: 2500 }); onChanged(); }
    catch (e) { notify({ id: `login-${what}`, tone: "error", title: "That did not work", message: why(e) }); } finally { setBusy(""); }
  }
  const start = (tool: "claude" | "codex", action: "login" | "logout") => act(`${action}-${tool}`, () => post(`admin/runners/${r.id}/logins`, { tool, action }),
    action === "login" ? `Asking ${r.name} to start the ${TOOL[tool]} sign-in` : `Signing ${TOOL[tool]} out on ${r.name}`);
  const said = !l ? null : l.status === "requested" ? "Waiting for the server to start the sign-in…" : l.status === "starting" ? "The server is starting the sign-in…"
    : l.status === "waiting" ? l.needsCode ? "Open the link, sign in with your own account, then paste the code the page shows you." : "Open the link and sign in with your own account."
    : l.status === "verifying" ? "Checking the sign-in on the server…" : l.status === "succeeded" ? (l.action === "logout" ? `${TOOL[l.tool]} signed out.` : `${TOOL[l.tool]} connected.`)
    : l.status === "cancelled" ? "Sign-in stopped." : l.status === "expired" ? "The sign-in ran out of time. Start again." : l.errorMessage ?? "The sign-in did not finish.";
  return <>
    <SectionHeader icon={LogIn} title="AI sign-in on this server" as="h3" />
    <div className={css.row}>
      {(["claude", "codex"] as const).map((t) => r[t].loggedIn
        ? <button key={t} type="button" className={calm.btn} disabled={!!busy || !r.online || live} onClick={() => void start(t, "logout")}><LogOut size={14} aria-hidden="true" />Disconnect {TOOL[t]}{r[t].plan ? ` (${r[t].plan})` : ""}</button>
        : <button key={t} type="button" className={r[t].needsLogin ? calm.btnPrimary : calm.btn} disabled={!!busy || !r.online || live || !r[t].installed}
            title={!r[t].installed ? `${TOOL[t]} is not installed on this server` : !r.online ? "The server is offline" : undefined}
            onClick={() => void start(t, "login")}><LogIn size={14} aria-hidden="true" />Connect {TOOL[t]}</button>)}
    </div>
    {l ? <div className={css.detail} aria-live="polite" data-login={l.status}>
      <p className={calm.quiet}>{live ? <LoaderCircle size={14} className={css.spin} aria-hidden="true" /> : null}{TOOL[l.tool]}: {said}</p>
      {l.status === "waiting" || l.status === "verifying" ? <>
        {l.url ? <p><a href={l.url} target="_blank" rel="noopener noreferrer" className={calm.btnPrimary}><ExternalLink size={14} aria-hidden="true" />Open the {TOOL[l.tool]} sign-in page</a></p> : null}
        {l.userCode ? <p>Code to enter there: <span className={css.code}>{l.userCode}</span> <button type="button" className={calm.btn} onClick={() => copy(l.userCode!, "Code")}><Copy size={14} aria-hidden="true" />Copy</button></p> : null}
        {l.needsCode && l.status === "waiting" ? <form className={css.row} onSubmit={(e) => { e.preventDefault(); void act("code", async () => { await post(`admin/runners/logins/${l.id}/code`, { code: pasted }); setPasted(""); }); }}>
          <label className={css.field}><span>Code from the sign-in page</span><input value={pasted} onChange={(e) => setPasted(e.target.value)} autoComplete="off" spellCheck={false} maxLength={512} /></label>
          <button type="submit" className={calm.btnPrimary} disabled={!!busy || pasted.trim().length < 4}>Finish sign-in</button>
        </form> : null}
      </> : null}
      {live ? <div className={css.row}><button type="button" className={calm.btn} disabled={!!busy} onClick={() => void act("cancel", () => post(`admin/runners/logins/${l.id}/cancel`, {}))}><X size={14} aria-hidden="true" />Stop</button></div> : null}
    </div> : null}
    <Quiet>The sign-in runs on the server, in Claude Code&apos;s or Codex&apos;s own way, with your own Max, Pro, Team or ChatGPT plan. Pulse only shows you its link; the sign-in itself stays on the server.</Quiet>
  </>;
}

/** RUNNERS-FULL: what AI may do on this server. Only admins change it; every change is kept with who approved it. */
function AccessPanel({ r, onChanged }: { r: Runner; onChanged: () => void }) {
  const [level, setLevel] = useState<Level>(r.accessLevel), [sandbox, setSandbox] = useState(r.sandbox), [ai, setAi] = useState(r.aiEmployees), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const changed = level !== r.accessLevel || sandbox !== r.sandbox || ai !== r.aiEmployees;
  async function save() {
    setBusy(true);
    try {
      await post(`admin/runners/${r.id}/access`, { level, sandbox, aiEmployees: ai, reason: reason.trim() || undefined }); setReason("");
      notify({ id: "server-access", tone: "success", title: `${r.name}: ${levelLabel(level)}`, message: "Saved, with you as the approver.", timeout: 3000 }); onChanged();
    } catch (e) { notify({ id: "server-access", tone: "error", title: "Access not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <>
    <SectionHeader icon={ShieldCheck} title="What AI may do here" as="h3" note={r.accessSetBy && r.accessSetAt ? `Set by ${r.accessSetBy}, ${ago(r.accessSetAt)}` : "Read only until an admin changes it"} />
    <fieldset className={css.field} data-access="">
      <legend>Access</legend>
      {LEVELS.map((x) => <label key={x.key}><input type="radio" name={`level-${r.id}`} checked={level === x.key} onChange={() => setLevel(x.key)} /> <b>{x.label}</b> <small>{x.text}</small></label>)}
    </fieldset>
    <label className={css.field}><span><input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Keep jobs in the sandbox</span>
      <small>{sandbox ? "Jobs only see their own folder and the system's programs." : r.allowNoSandbox ? "Jobs run as the server's runner user, outside the sandbox." : "Off here, but the server keeps the sandbox on until its own admin allows running without it."}</small></label>
    <label className={css.field}><span><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> AI employees may use this server</span>
      <small>Your AI employees can then run Claude or Codex here, up to this access. Every job is listed below with its cost.</small></label>
    {changed ? <div className={css.row}>
      <label className={css.field}><span>Why (kept with the change)</span><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
      <button type="button" className={calm.btnPrimary} disabled={busy} onClick={() => void save()}>Save access</button>
      <button type="button" className={calm.btn} onClick={() => { setLevel(r.accessLevel); setSandbox(r.sandbox); setAi(r.aiEmployees); }}>Undo</button>
    </div> : null}
    {r.accessLog.length ? <Facts items={r.accessLog.map((a) => [ago(a.at), `${a.approvedBy ?? "An admin"}: ${a.fromLevel && a.fromLevel !== a.toLevel ? `${levelLabel(a.fromLevel)} → ` : ""}${levelLabel(a.toLevel)}${a.sandbox ? "" : ", sandbox off"}${a.aiEmployees ? ", AI employees in" : ""}${a.reason ? ` · ${a.reason}` : ""}`] as [string, ReactNode])} /> : null}
  </>;
}

function Jobs({ jobs, onChanged }: { jobs: Job[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!jobs.length) return <Card label="Recent jobs"><SectionHeader icon={ListChecks} title="Recent jobs" />
    <Quiet>No jobs yet. Start a test job on a server to see it work end to end.</Quiet></Card>;
  return <Card label="Recent jobs">
    <SectionHeader icon={ListChecks} title="Recent jobs" note={`${jobs.length} latest`} />
    <ul className={css.jobs}>{jobs.map((j) => <li key={j.id}>
      <button type="button" className={css.job} aria-expanded={open === j.id} onClick={() => setOpen(open === j.id ? null : j.id)}>
        <span className={css.jobIcon} aria-hidden="true">{j.kind === "shell-safe" ? <Terminal size={16} /> : <Bot size={16} />}</span>
        <span className={css.jobText}><b>{KIND[j.kind]}{j.dryRun ? " · plan only" : ""} on {j.runnerName}{j.requestedByType === "ai-employee" && j.requestedBy ? ` · by ${j.requestedBy}${j.requestedFor ? ` for ${j.requestedFor}` : ""}` : ""}</b><small>{j.summary ?? ""}</small></span>
        <span className={css.jobEnd}><Status j={j} /><small>{ago(j.finishedAt ?? j.startedAt ?? j.createdAt)}{j.costUsd ? ` · $${j.costUsd.toFixed(2)}` : ""}</small></span>
      </button>
      {open === j.id ? <JobDetail id={j.id} live={LIVE.includes(j.status)} onChanged={onChanged} /> : null}
    </li>)}</ul>
  </Card>;
}

function Status({ j }: { j: Job }) {
  const s = STATUS[j.status] ?? { label: j.status };
  const label = j.status === "running" && j.lastState === "uploading" ? "Sending files" : s.label;
  return <span className={calm.badge} data-tone={s.tone} data-status={j.status}>
    {LIVE.includes(j.status) ? <LoaderCircle size={12} className={css.spin} aria-hidden="true" /> : j.status === "succeeded" ? <CircleCheck size={12} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}{label}</span>;
}

function JobDetail({ id, live, onChanged }: { id: string; live: boolean; onChanged: () => void }) {
  const [d, setD] = useState<{ job: Job & { approval: unknown }; events: Event[]; outputs: { id: string; path: string; bytes: number }[] } | null>(null), [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get<NonNullable<typeof d>>(`admin/runners/jobs/${id}`).then(setD).catch((e) => setErr(why(e))), [id]);
  useEffect(() => { void load(); if (!live) return; const t = setInterval(() => void load(), 2500); return () => clearInterval(t); }, [load, live]);
  if (err) return <p className={calm.quiet}>{err}</p>;
  if (!d) return <p className={calm.quiet}><LoaderCircle size={14} className={css.spin} aria-hidden="true" /> Loading…</p>;
  const j = d.job, lines = d.events.filter((e) => e.type === "log" || e.type === "warning" || e.type === "status" || e.type === "agent").slice(-60);
  async function cancel() {
    setBusy(true);
    try { await post(`admin/runners/jobs/${id}/cancel`, {}); notify({ id: "job-cancel", tone: "success", title: "Stopping the job", timeout: 2500 }); onChanged(); void load(); }
    catch (e) { notify({ id: "job-cancel", tone: "error", title: "Not cancelled", message: why(e) }); } finally { setBusy(false); }
  }
  return <div className={css.detail}>
    <Facts items={[["Asked by", `${j.requestedBy ?? "—"}${j.requestedByType === "ai-employee" ? " (AI employee)" : ""}${j.requestedFor && j.requestedFor !== j.requestedBy ? ` for ${j.requestedFor}` : ""}`],
      ["Access", `${j.profile === "read-only" ? "Read only" : j.profile === "write" ? "Read and write files (approved)" : "Files and shell (approved)"}${j.accessLevel ? ` · server at ${levelLabel(j.accessLevel)}${j.sandbox === false ? ", sandbox off" : ""}` : ""}`],
      ...(j.costUsd ? [["Cost", `$${j.costUsd.toFixed(2)}`] as [string, ReactNode]] : []),
      ...(j.durationMs ? [["Took", `${Math.round(j.durationMs / 1000)} s`] as [string, ReactNode]] : []),
      ...(j.errorCode ? [["Why", `${j.errorMessage ?? j.errorCode} (${j.errorCode})`] as [string, ReactNode]] : []),
      ...(d.outputs.length ? [["Files", d.outputs.map((o) => o.path).join(", ")] as [string, ReactNode]] : [])]} />
    {lines.length ? <pre className={css.log} aria-label="What the server reported">{lines.map((e) => <span key={e.seq} data-type={e.type}>{line(e)}{"\n"}</span>)}</pre>
      : <Quiet>{live ? "Nothing reported yet." : "The server reported no output."}</Quiet>}
    {live ? <div className={css.row}><button type="button" className={`${calm.btn} ${css.danger}`} disabled={busy || j.status === "cancelling"} onClick={() => void cancel()}><X size={14} aria-hidden="true" />{j.status === "cancelling" ? "Stopping…" : "Cancel job"}</button></div> : null}
  </div>;
}

function line(e: Event) {
  const d = e.data;
  if (e.type === "log") return String(d.line ?? "");
  if (e.type === "status") return `· ${String(d.state ?? "")}${d.reason ? ` (${String(d.reason)})` : ""}`;
  if (e.type === "warning") return `! ${String(d.message ?? d.code ?? "")}`;
  // An agent line: the assistant's words when the CLI said any, else its event type.
  const m = d.message as { content?: { type?: string; text?: string }[] } | undefined;
  const words = Array.isArray(m?.content) ? m!.content.filter((c) => c?.type === "text").map((c) => c.text).join(" ") : typeof d.result === "string" ? d.result : "";
  return words ? `› ${words}` : `› ${String(d.type ?? "agent")}`;
}

function Rail({ data }: { data: Data }) {
  const total = data.runners.reduce((t, r) => ({ jobs: t.jobs + (r.usage?.jobs ?? 0), succeeded: t.succeeded + (r.usage?.succeeded ?? 0), failed: t.failed + (r.usage?.failed ?? 0),
    minutes: t.minutes + (r.usage?.minutes ?? 0), costUsd: t.costUsd + (r.usage?.costUsd ?? 0) }), { jobs: 0, succeeded: 0, failed: 0, minutes: 0, costUsd: 0 });
  return <>
    <Card label="How it works">
      <SectionHeader icon={ShieldCheck} title="How it works" />
      <Facts items={[["Connection", "Your server calls Pulse over HTTPS. No open ports."], ["AI sign-in", "Your own Claude Code or Codex, on your server"],
        ["Sandbox", "Each job runs sealed off (bubblewrap) unless an admin turns it off for a server"], ["Access", "Read only unless an admin raises it per server"], ["Pulse data", "A token for one job, read only, ends with the job"]]} />
    </Card>
    <Card label="Good to know">
      <SectionHeader icon={CircleAlert} title="Good to know" />
      <Quiet>A server shows as offline after 90 seconds without a call. Disconnecting a server stops its credential at once; to remove it from the machine run <code>pulse-runner uninstall</code> there.</Quiet>
      {data.pairing?.waiting ? <Quiet>{data.pairing.waiting === 1 ? "One code is" : `${data.pairing.waiting} codes are`} waiting to be used{data.pairing.until ? ` (for up to ${Math.max(1, Math.ceil((Date.parse(data.pairing.until) - Date.parse(data.now)) / 60000))} more minutes)` : ""}.</Quiet> : null}
    </Card>
    <Card label="Usage, last 30 days">
      <SectionHeader icon={ListChecks} title="Usage, last 30 days" />
      <Facts items={[["Jobs", String(total.jobs)], ["Done", String(total.succeeded)], ["Failed", String(total.failed)], ["Time on servers", `${Math.round(total.minutes)} min`],
        ["Reported cost", `$${total.costUsd.toFixed(2)}`]]} />
      <Quiet>Cost is what Claude Code reports for each job, paid by your own subscription. Codex does not report cost.</Quiet>
    </Card>
  </>;
}

// AI-SERVER-TOOLS (1590): what AI employees may do in Pulse. Every AI employee reaches every area by default (its own
// key, as itself, inside this company); an admin narrows one per area (read, write), turns on "ask me first for writes"
// for its server work, or pauses all AI employees at once.
type AiAgent = { id: string; name: string; areas: string[]; all: boolean; serverWritesAsk: boolean };
type AiAccessData = { areas: string[]; agents: AiAgent[]; paused: boolean; pause: { pausedAt: string; pausedBy: string | null; reason: string | null } | null };
const AREA: Record<string, string> = { tasks: "Tasks", projects: "Projects", people: "People", chats: "Chats", docs: "Documents", billing: "Billing (quotes, invoices)",
  workflows: "Workflows and servers", companies: "Companies and clients", search: "Search", events: "Events", finance: "Finance", hr: "HR (leave, attendance)" };
function AiAccess() {
  const [d, setD] = useState<AiAccessData | null>(null), [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(() => get<AiAccessData>("admin/runners/ai-access").then(setD).catch(() => setD(null)), []);
  useEffect(() => { void load(); }, [load]);
  if (!d) return null;
  const groups = [...new Set(d.areas.map((a) => a.split(".")[0]))];
  async function save(a: AiAgent, areas: string[] | null, serverWritesAsk?: boolean) {
    setBusy(true);
    try { await post(`admin/runners/ai-access/${a.id}`, { areas, ...(serverWritesAsk === undefined ? {} : { serverWritesAsk }) }); notify({ id: "ai-access", tone: "success", title: `${a.name}: access saved`, timeout: 2500 }); void load(); }
    catch (e) { notify({ id: "ai-access", tone: "error", title: "Not saved", message: why(e) }); } finally { setBusy(false); }
  }
  async function pause(on: boolean) {
    setBusy(true);
    try { await post("admin/runners/ai-pause", { paused: on }); notify({ id: "ai-pause", tone: "success", title: on ? "All AI employees are paused" : "AI employees work again", timeout: 3000 }); void load(); }
    catch (e) { notify({ id: "ai-pause", tone: "error", title: "Not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <Card label="What AI employees may do">
    <SectionHeader icon={Bot} title="What AI employees may do" note={d.paused ? "Paused" : "Everything, unless you narrow it"} tone={d.paused ? "bad" : undefined} />
    <p className={calm.quiet}>Each AI employee acts in Pulse as itself, inside this company only: every area below by default, and on servers that let AI employees in, up to the access level of that server. Every action is recorded with its name.</p>
    <div className={css.row}>
      {d.paused ? <span>Paused{d.pause?.pausedBy ? ` by ${d.pause.pausedBy}` : ""}{d.pause?.pausedAt ? ` ${ago(d.pause.pausedAt)}` : ""}.</span> : null}
      <button type="button" className={d.paused ? calm.btnPrimary : calm.btn} disabled={busy} onClick={() => void pause(!d.paused)}>{d.paused ? <Play size={14} aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}{d.paused ? "Resume AI employees" : "Pause all AI employees"}</button>
    </div>
    <ul className={css.jobs}>{d.agents.map((a) => <li key={a.id}>
      <button type="button" className={css.job} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
        <span className={css.jobText}><b>{a.name}</b><small>{a.all ? "Everything" : `${a.areas.length} of ${d.areas.length} area permissions`}{a.serverWritesAsk ? " · asks first for server writes" : ""}</small></span>
      </button>
      {open === a.id ? <div className={css.detail}>
        <table className={css.access}><thead><tr><th scope="col">Area</th><th scope="col">Read</th><th scope="col">Write</th></tr></thead><tbody>
          {groups.map((g) => <tr key={g}><th scope="row">{AREA[g] ?? g}</th>{["read", "write"].map((m) => {
            const k = `${g}.${m}`, on = a.areas.includes(k);
            return <td key={k}><input type="checkbox" aria-label={`${AREA[g] ?? g}: ${m}`} checked={on} disabled={busy}
              onChange={() => void save(a, on ? a.areas.filter((x) => x !== k) : [...a.areas, k])} /></td>;
          })}</tr>)}
        </tbody></table>
        <label className={css.row}><input type="checkbox" checked={a.serverWritesAsk} disabled={busy} onChange={() => void save(a, a.all ? null : a.areas, !a.serverWritesAsk)} />
          Ask me first for writes on servers (it then runs read-only work only; a person runs the rest)</label>
        {!a.all ? <button type="button" className={calm.btn} disabled={busy} onClick={() => void save(a, null)}>Give everything back</button> : null}
      </div> : null}
    </li>)}</ul>
  </Card>;
}

// AI-EMPLOYEE-POWER (owner, 6 Nov 2026): root access for AI employees. The organisation owner grants an AI employee root
// on a server from its profile (People → it → AI → Capabilities); here admins see every grant, every root command with
// its (redacted) output, the grant and revoke history, and one button that takes root back from every AI employee at
// once and stops their running root jobs.
type RootItem = { jobId: string; server: string; agent: string; requestedFor: string | null; command: string; status: string; exitCode: number | null;
  createdAt: string; finishedAt: string | null; durationMs: number | null; output: string | null };
type RootGrant = { agent: string; agentId: string; server: string; serverId: string; tier: string; timeLimitSec: number; by: string | null; at: string | null };
type RootLog = { at: string; agent: string; server: string; fromTier: string | null; toTier: string | null; by: string | null; reason: string | null };
type RootAudit = { items: RootItem[]; grants: RootGrant[]; log: RootLog[] };
const TIER_WORD: Record<string, string> = { none: "No access", "read-only": "Read-only", sandboxed: "Read-write (sandboxed)", root: "Root", default: "Default" };
const tierWord = (t: string | null) => t ? TIER_WORD[t] ?? t : "Default";
const took = (ms: number | null) => ms === null ? null : ms < 1000 ? `${ms} ms` : ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
function RootAccess({ onChanged }: { onChanged: () => void }) {
  const [d, setD] = useState<RootAudit | null>(null), [state, setState] = useState<"loading" | "ok" | "gone" | "error">("loading"), [err, setErr] = useState("");
  const [asking, setAsking] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    fetch("/api/v0/admin/runners/root-audit?limit=50", { cache: "no-store" }).then(async (r) => {
      const x = await r.json().catch(() => ({})) as Partial<RootAudit> & { error?: string };
      if (!live) return;
      if (r.status === 404 || r.status === 403 || r.status === 401) { setState("gone"); return; }
      if (!r.ok) { setErr(x.error ?? "Pulse could not load this. Try again."); setState("error"); return; }
      setD({ items: x.items ?? [], grants: x.grants ?? [], log: x.log ?? [] }); setState("ok");
    }).catch(() => { if (live) { setErr("Pulse could not load this. Try again."); setState("error"); } });
    return () => { live = false; };
  }, [tick]);
  if (state === "loading" || state === "gone") return null;
  async function revokeAll() {
    setBusy(true);
    try {
      const r = await post<{ revoked?: number; cancelledJobs?: number }>("admin/runners/revoke-root", { reason: reason.trim() || undefined });
      const n = r.revoked ?? 0, m = r.cancelledJobs ?? 0;
      const said = `Root revoked for ${n} AI ${n === 1 ? "employee" : "employees"}; ${m} running ${m === 1 ? "job" : "jobs"} stopped.`;
      setResult(said); setAsking(false); setReason("");
      notify({ id: "root-revoke", tone: "success", title: "Root revoked", message: said, timeout: 4000 });
      load(); onChanged();
    } catch (e) { notify({ id: "root-revoke", tone: "error", title: "Root not revoked", message: why(e) }); } finally { setBusy(false); }
  }
  const grants = d?.grants ?? [], items = d?.items ?? [], log = d?.log ?? [];
  return <Card label="Root access">
    <SectionHeader icon={ShieldAlert} title="Root access" tone={grants.length ? "bad" : undefined} note={grants.length ? `${grants.length} ${grants.length === 1 ? "grant" : "grants"} in force` : "No AI employee has root"} />
    <p className={calm.quiet}>Root is a full root shell on a server, with no command list, for one AI employee at a time. Only the organisation owner grants it, from the AI employee’s profile (AI → Capabilities). Every root command is listed here with its output.</p>
    <div className={css.row}>
      {asking ? <>
        <label className={css.field}><span>Why (kept with the change)</span><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="button" className={css.rootBtn} disabled={busy} onClick={() => void revokeAll()}>{busy ? <LoaderCircle size={14} className={css.spin} aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}Yes, revoke all root now</button>
        <button type="button" className={calm.btn} disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
        <span className={calm.quiet}>Every AI employee goes back to its server’s default access, and running root jobs are stopped.</span>
      </> : <button type="button" className={css.rootBtn} onClick={() => { setAsking(true); setResult(null); }}><Ban size={14} aria-hidden="true" />Revoke all root</button>}
    </div>
    {result ? <p className={css.rootResult} role="status"><CircleCheck size={14} aria-hidden="true" />{result}</p> : null}
    {state === "error" ? <p className={calm.quiet} role="alert">{err} <button type="button" className={calm.btn} onClick={load}>Try again</button></p> : null}

    <SectionHeader icon={KeyRound} title="Who has root now" as="h3" note={grants.length ? String(grants.length) : undefined} />
    {grants.length ? <ul className={css.jobs}>{grants.map((g) => <li key={`${g.agentId}-${g.serverId}`} className={css.rootRow}>
      <span className={css.jobText}><b>{g.agent} on {g.server}</b>
        <small>{g.by ? `Granted by ${g.by}` : "Granted"}{g.at ? `, ${ago(g.at)}` : ""} · up to {Math.max(1, Math.round(g.timeLimitSec / 60))} min a job</small></span>
    </li>)}</ul> : <Quiet>No AI employee has root on any server.</Quiet>}

    <SectionHeader icon={Terminal} title="Root commands" as="h3" note={items.length ? `${items.length} latest` : undefined} />
    {items.length ? <ul className={css.jobs}>{items.map((j) => {
      const s = STATUS[j.status] ?? { label: j.status };
      return <li key={j.jobId}>
        <button type="button" className={css.job} aria-expanded={open === j.jobId} onClick={() => setOpen(open === j.jobId ? null : j.jobId)}>
          <span className={css.jobIcon} aria-hidden="true"><Terminal size={16} /></span>
          <span className={css.jobText}><b>{j.agent} on {j.server}{j.requestedFor ? ` · for ${j.requestedFor}` : ""}</b><small><code>{j.command}</code></small></span>
          <span className={css.jobEnd}>
            <span className={calm.badge} data-tone={s.tone} data-status={j.status}>{LIVE.includes(j.status) ? <LoaderCircle size={12} className={css.spin} aria-hidden="true" /> : null}{s.label}{j.exitCode !== null ? ` · exit ${j.exitCode}` : ""}</span>
            <small>{ago(j.finishedAt ?? j.createdAt)}{took(j.durationMs) ? ` · ${took(j.durationMs)}` : ""}</small></span>
        </button>
        {open === j.jobId ? <div className={css.detail}>
          <pre className={css.log} aria-label="The command">{j.command}</pre>
          {j.output ? <pre className={css.log} aria-label="What it printed (secrets hidden)">{j.output}</pre> : <Quiet>It printed nothing.</Quiet>}
        </div> : null}
      </li>;
    })}</ul> : <Quiet>No root command has run yet.</Quiet>}

    {log.length ? <>
      <SectionHeader icon={ListChecks} title="Grant and revoke history" as="h3" note={String(log.length)} />
      <ul className={css.jobs}>{log.map((l, i) => <li key={`${l.at}-${i}`} className={css.rootRow}>
        <span className={css.jobText}><b>{l.agent} on {l.server}: {tierWord(l.fromTier)} → {tierWord(l.toTier)}</b>
          <small>{l.by ?? "An admin"}, {ago(l.at)}{l.reason ? ` · ${l.reason}` : ""}</small></span>
      </li>)}</ul>
    </> : null}
  </Card>;
}
