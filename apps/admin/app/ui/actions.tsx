"use client";
// PULSE-ADMIN: the admin site's changes (ported from Pulse's in-app /admin). Each asks for a reason (it goes to the platform audit log and to the
// organisation's own Audit), sends one request, and reloads the page's data. Nothing here is e-mailed to anyone.
import { Eye, LogOut, Megaphone, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { ago } from "../lib/format";
import { COMPANY_SWITCHES, MODULES, ORG_ONLY, PLAN_LABELS, words, type PersonDetail } from "../lib/types";
import css from "./console.module.css";
import { kitStyles } from "./kit";

/** A change, through this site's own route (app/api/platform) to Pulse's platform API as the signed-in person. */
async function post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Not saved");
  return data as T;
}

const failure = (e: unknown) => (e instanceof Error ? e.message : "Not saved");

function Reason({ value, onChange, label = "Why (goes in the audit log)" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return <label className={kitStyles.field}>{label}<input value={value} onChange={(e) => onChange(e.target.value)} minLength={4} maxLength={400} placeholder="e.g. Tester asked to pause their trial" /></label>;
}
function Status({ error, done }: { error: string; done?: string }) {
  return error ? <p role="alert" className={css.error}>{error}</p> : done ? <p role="status" className={css.done}>{done}</p> : null;
}

export function OrgStatus({ org, status, own }: { org: string; status: string; own: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const next = status === "suspended" ? "active" : "suspended";
  if (own) return <p className={css.note}>The install’s own organisation is never suspended from here.</p>;
  if (status === "setup") return <p className={css.note}>Still being set up: finish it under Companies.</p>;
  async function go(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post(`platform/orgs/${org}`, { status: next, reason }); setReason(""); router.refresh(); }
    catch (x) { setError(failure(x)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={go}>
    <p className={css.note}>{next === "suspended" ? "Suspending signs everyone in this organisation out at once and closes its address. Nothing is deleted." : "Reactivating lets its people sign in again."}</p>
    <Reason value={reason} onChange={setReason} />
    <div className={css.row}><button className={`${kitStyles.button} ${next === "suspended" ? css.danger : ""}`} data-variant={next === "suspended" ? "secondary" : "primary"} disabled={busy || reason.trim().length < 4}>
      {next === "suspended" ? <><ShieldOff size={14} aria-hidden="true" />{busy ? "Suspending…" : "Suspend organisation"}</> : busy ? "Reactivating…" : "Reactivate organisation"}</button></div>
    <Status error={error} />
  </form>;
}

export function PlanForm({ org, plan }: { org: string; plan: { plan: string; seatLimit: number | null; aiTokensMonth: number | null; trialEnds: string | null; note: string | null } }) {
  const router = useRouter();
  const [v, setV] = useState({ plan: plan.plan, seatLimit: plan.seatLimit ? String(plan.seatLimit) : "", aiTokensMonth: plan.aiTokensMonth ? String(plan.aiTokensMonth) : "",
    trialEnds: plan.trialEnds ?? "", note: plan.note ?? "" });
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => { setV({ ...v, [k]: e.target.value }); setDone(""); };
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setDone("");
    try { await post(`platform/orgs/${org}`, { ...v, reason }); setReason(""); setDone("Saved"); router.refresh(); }
    catch (x) { setError(failure(x)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={save}>
    <div className={css.grid}>
      <label className={kitStyles.field}>Plan<select value={v.plan} onChange={set("plan")}>{Object.entries(PLAN_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className={kitStyles.field}>Seats<input inputMode="numeric" value={v.seatLimit} onChange={set("seatLimit")} placeholder="No limit" /></label>
      <label className={kitStyles.field}>AI tokens a month<input inputMode="numeric" value={v.aiTokensMonth} onChange={set("aiTokensMonth")} placeholder="No limit" /></label>
      <label className={kitStyles.field}>Trial ends<input type="date" value={v.trialEnds} onChange={set("trialEnds")} /></label>
    </div>
    <label className={kitStyles.field}>Note<input value={v.note} onChange={set("note")} maxLength={400} placeholder="What was agreed" /></label>
    <Reason value={reason} onChange={setReason} />
    <div className={css.row}><button className={kitStyles.button} data-variant="primary" disabled={busy || reason.trim().length < 4}>{busy ? "Saving…" : "Save plan and limits"}</button></div>
    <Status error={error} done={done} />
  </form>;
}

export function FlagPanel({ org, company, off, on }: { org: string; company: Record<string, boolean>; off: string[]; on: string[] }) {
  const router = useRouter();
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(""), [error, setError] = useState("");
  async function flip(flag: string, kind: "company" | "module" | "org-only", enabled: boolean) {
    if (reason.trim().length < 4) { setError("Say why first: it goes in the audit log"); return; }
    setBusy(flag); setError("");
    try { await post(`platform/orgs/${org}/flags`, { flag, kind, enabled, reason }); router.refresh(); }
    catch (x) { setError(failure(x)); } finally { setBusy(""); }
  }
  const row = (flag: string, kind: "company" | "module" | "org-only", value: boolean, hint: ReactNode) =>
    <label key={`${kind}:${flag}`} className={css.switch}><span><b>{words(flag)}</b><small>{hint}</small></span>
      <input type="checkbox" role="switch" checked={value} disabled={!!busy} onChange={(e) => void flip(flag, kind, e.target.checked)} aria-label={words(flag)} /></label>;
  return <div className={css.form}>
    <Reason value={reason} onChange={setReason} label="Why (needed for any switch)" />
    <Status error={error} />
    <h4 className={css.heading}>The company’s own switches</h4>
    <div className={css.switches}>{COMPANY_SWITCHES.map((f) => row(f, "company", company[f] ?? f !== "attendance", "Its admins see this under Settings → Organisation"))}</div>
    <h4 className={css.heading}>Modules</h4>
    <div className={css.switches}>{MODULES.map((f) => row(f, "module", !off.includes(f), "Off: gone from menus; its pages and API answer as if absent"))}</div>
    <h4 className={css.heading}>Organisation-only</h4>
    <div className={css.switches}>{ORG_ONLY.map((f) => row(f, "org-only", on.includes(f), "Off everywhere unless switched on here"))}</div>
    <p className={css.note}>A module the server has not switched on stays off whatever this says.</p>
  </div>;
}

const PERSON_ACTIONS = [
  { key: "sign_out", label: "Sign out everywhere", hint: "Ends every session on every device." },
  { key: "unlock", label: "Unlock sign-in", hint: "Clears failed attempts and any lock." },
  { key: "reset", label: "Reset sign-in", hint: "Unlocks, signs out, and asks for a new password at the next sign-in." },
  { key: "disable", label: "Disable sign-in", hint: "Their Pulse password stops working; sessions end." },
  { key: "enable", label: "Enable sign-in", hint: "Their Pulse password works again." },
] as const;

export function PersonHelp({ org, person, disabled }: { org: string; person: string; disabled: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState<string>("sign_out"), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const chosen = PERSON_ACTIONS.find((a) => a.key === action)!;
  async function go(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setDone("");
    try { const r = await post<{ sessionsEnded: number }>(`platform/orgs/${org}/people/${person}/sign-in`, { action, reason });
      setDone(`${chosen.label}: done${r.sessionsEnded ? ` (${r.sessionsEnded} session${r.sessionsEnded === 1 ? "" : "s"} ended)` : ""}`); setReason(""); router.refresh(); }
    catch (x) { setError(failure(x)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={go}>
    <label className={kitStyles.field}>Sign-in help<select value={action} onChange={(e) => { setAction(e.target.value); setDone(""); }}>
      {PERSON_ACTIONS.filter((a) => (disabled ? a.key !== "disable" : a.key !== "enable")).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
    <p className={css.note}>{chosen.hint} Nothing is e-mailed.</p>
    <Reason value={reason} onChange={setReason} />
    <div className={css.row}><button className={`${kitStyles.button} ${action === "disable" ? css.danger : ""}`} data-variant={action === "disable" ? "secondary" : "primary"} disabled={busy || reason.trim().length < 4}><LogOut size={14} aria-hidden="true" />{busy ? "Working…" : chosen.label}</button></div>
    <Status error={error} done={done} />
  </form>;
}

/** View as (read-only): what Pulse holds for this person and what they see, after a reason. Nothing can be changed. */
export function ViewAs({ org, person, name }: { org: string; person: string; name: string }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [seen, setSeen] = useState<PersonDetail | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { setSeen(await post<PersonDetail>(`platform/orgs/${org}/people/${person}/view-as`, { reason })); }
    catch (x) { setError(failure(x)); } finally { setBusy(false); }
  }
  if (seen) return <div className={css.viewAs} aria-label={`Viewing as ${name}, read-only`}>
    <p className={css.viewAsBar}><Eye size={14} aria-hidden="true" />Viewing as {seen.name} · read-only · recorded in the audit log <button type="button" className={css.linkButton} onClick={() => setSeen(null)}>Close</button></p>
    <dl className={css.facts}>
      <dt>Organisation</dt><dd>{seen.org.name}</dd>
      <dt>Signs in as</dt><dd>{seen.username ? `@${seen.username}` : "—"}{seen.email ? ` · ${seen.email}` : ""}</dd>
      <dt>Roles</dt><dd>{seen.roles.length ? seen.roles.map(words).join(", ") : "Member"}</dd>
      <dt>Title and pod</dt><dd>{[seen.title, seen.pod, seen.department].filter(Boolean).join(" · ") || "—"}</dd>
      <dt>Manager</dt><dd>{seen.manager ?? "—"}</dd>
      <dt>Open tasks</dt><dd>{seen.openTasks}</dd>
      <dt>Switched on for them</dt><dd>{Object.entries(seen.modules).filter(([, v]) => v).map(([k]) => words(k)).join(", ") || "—"}</dd>
      <dt>Sign-in</dt><dd>{seen.signIn ? `${seen.signIn.status}${seen.signIn.mustChange ? ", must choose a new password" : ""} · last ${ago(seen.signIn.lastLogin)}` : "No Pulse password here"}</dd>
      <dt>Devices signed in</dt><dd>{seen.sessions.length ? seen.sessions.map((s) => `${s.device ?? "Browser"} (${ago(s.lastActive)})`).join(", ") : "None"}</dd>
      <dt>Pulse account</dt><dd>{seen.account ? `@${seen.account.handle} · ${seen.account.orgs.map((o) => o.org).join(", ")}` : "Not linked to a Pulse account"}</dd>
    </dl>
  </div>;
  return <form className={css.form} onSubmit={go}>
    <p className={css.note}>See what Pulse holds for {name} and what they can see. Read-only: nothing can be changed from this view.</p>
    <Reason value={reason} onChange={setReason} label="Why (they and their admins can see this in their Audit)" />
    <div className={css.row}><button className={kitStyles.button} disabled={busy || reason.trim().length < 4}><Eye size={14} aria-hidden="true" />{busy ? "Opening…" : "View as (read-only)"}</button></div>
    <Status error={error} />
  </form>;
}

export function AnnouncementForm() {
  const router = useRouter();
  const [v, setV] = useState({ title: "", body: "", tone: "info", audience: "everyone", link: "", endsAt: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => { setV({ ...v, [k]: e.target.value }); setDone(""); };
  async function publish(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setDone("");
    try { await post("platform/announcements", { ...v, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : "" });
      setV({ title: "", body: "", tone: "info", audience: "everyone", link: "", endsAt: "" }); setDone("Published"); router.refresh(); }
    catch (x) { setError(failure(x)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={publish}>
    <label className={kitStyles.field}>Title<input value={v.title} onChange={set("title")} required minLength={2} maxLength={120} placeholder="e.g. Pulse is updating at 10 pm tonight" /></label>
    <label className={kitStyles.field}>Details<textarea value={v.body} onChange={set("body")} maxLength={1000} rows={3} placeholder="Optional: one or two sentences" /></label>
    <div className={css.grid}>
      <label className={kitStyles.field}>Tone<select value={v.tone} onChange={set("tone")}><option value="info">Information</option><option value="warning">Warning</option><option value="success">Good news</option></select></label>
      <label className={kitStyles.field}>Who sees it<select value={v.audience} onChange={set("audience")}><option value="everyone">Everyone</option><option value="admins">Organisation admins</option></select></label>
      <label className={kitStyles.field}>Link<input value={v.link} onChange={set("link")} placeholder="/whats-new or https://…" /></label>
      <label className={kitStyles.field}>Ends<input type="datetime-local" value={v.endsAt} onChange={set("endsAt")} /></label>
    </div>
    <div className={css.row}><button className={kitStyles.button} data-variant="primary" disabled={busy || v.title.trim().length < 2}><Megaphone size={14} aria-hidden="true" />{busy ? "Publishing…" : "Publish"}</button></div>
    <Status error={error} done={done} />
  </form>;
}

export function EndAnnouncement({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <span className={css.row}>
    <button type="button" className={kitStyles.button} disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await post(`platform/announcements/${id}/end`); router.refresh(); } catch (x) { setError(failure(x)); } finally { setBusy(false); } }}>{busy ? "Ending…" : "End now"}</button>
    {error ? <span role="alert" className={css.error}>{error}</span> : null}
  </span>;
}

