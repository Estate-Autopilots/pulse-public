"use client";
// AGENT-MEMORY (8 Nov 2026, bugs seen in the 7 Nov demo): what an AI employee keeps and who approves what, on its profile.
//  - Knowledge: its standing rules (who set them and when; a quotation rule says what every quotation will include) and
//    its notes, by person ("How Bevit works") and by topic; whoever manages it edits notes, its owner, approvers, admins
//    and leadership edit rules. One assistant identity per role, notes per person.
//  - Who gives the final approval for each kind of action (its owner unless someone else is chosen).
//  - Its budget meter (today, this month, the company's), amber at 80%, with one-click "Add budget" for admins.
import { EmptyState, SkeletonRows } from "../../../kit/game";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, Brain, Gauge, Pencil, Plus, ScrollText, Trash2, UserRound, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { PersonSelect } from "../../../kit";
import { useOrgZone } from "../../../org-code";
import css from "./profile.module.css";
import mem from "./memory.module.css";

type Rule = { id: string; body: string; scope: "all" | "quotation" | "invoice" | "task" | "chat"; include: string | null; source: "chat" | "profile"; setBy: string; setAt: string; editedAt: string | null };
type Note = { id: string; body: string; source: "manager" | "agent" | "chat"; at: string; by: string; aboutId: string | null; about: string | null; topic: string | null; taskId: string | null; editedAt: string | null };
type Knowledge = { canEdit: boolean; canRule: boolean; rules: Rule[]; notes: Note[]; people: { id: string; name: string }[] };
type Meter = { used: number; limit: number | null; share: number | null };
export type BudgetState = { level: "ok" | "warn" | "out"; period: "day" | "month" | "org" | "plan" | "rupees" | "org_rupees"; share: number; day: Meter; month: Meter; org: Meter | null; owner: { id: string | null; name: string | null }; canAdd: boolean;
  /** TOKENS-2 (2280): rupees a month, its own and the company's (list prices; null when none is set). */
  rupees?: Meter | null; orgRupees?: Meter | null };
/** TOKENS-2: rupees at a glance (₹4,120; ₹1.2 lakh). */
const rs = (n: number) => (n >= 100000 ? `₹${(Math.round(n / 10000) / 10).toString()} lakh` : `₹${new Intl.NumberFormat("en-IN").format(Math.round(n))}`);
type Approver = { action: "message" | "task" | "quotation" | "budget"; personId: string | null; name: string | null; chosen: boolean; usual: string | null };

const SCOPE: Record<Rule["scope"], string> = { all: "Everything", quotation: "Quotations", invoice: "Invoices", task: "Tasks", chat: "Messages" };
const ACTION: Record<Approver["action"], { label: string; help: string }> = {
  message: { label: "Messages it would post", help: "Cards for what it would say where it asks first" },
  task: { label: "Tasks it proposes", help: "Create it / Edit / Don’t" },
  quotation: { label: "Quotations it drafts", help: "The approval task for its quotation" },
  budget: { label: "More budget", help: "When it needs more tokens" },
};
const day = (iso: string, zone: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone });
const num = (n: number | null | undefined) => new Intl.NumberFormat("en-IN").format(Math.max(0, Math.round(Number(n) || 0)));

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { headers: { accept: "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || "Could not load");
  return d as T;
}
function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState("");
  const load = useCallback(() => { getJson<T>(path).then((d) => { setData(d); setError(""); }).catch((e: Error) => setError(e.message)); }, [path]);
  useEffect(() => { load(); const on = () => load(); window.addEventListener("pulse:data-changed", on); return () => window.removeEventListener("pulse:data-changed", on); }, [load]);
  return { data, error, load };
}

/** The Knowledge tab: standing rules, then notes by person and by topic. */
export function AiKnowledge({ id }: { id: string }) {
  const { data: k, error, load } = useLoad<Knowledge>(`agents/${id}/knowledge`);
  const zone = useOrgZone();
  const [busy, setBusy] = useState(false), [fail, setFail] = useState("");
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setFail("");
    try { await fn(); notify({ id: "ai-knowledge", tone: "success", title: done, timeout: 2200 }); load(); return true; }
    catch (e) { setFail((e as Error).message); return false; } finally { setBusy(false); }
  }
  if (error) return <Panel title="Knowledge"><p role="alert" className={css.error}>{error}</p></Panel>;
  if (!k) return <Panel title="Knowledge"><SkeletonRows rows={3} height={48} label="Loading what it knows" /></Panel>;
  const byPerson = new Map<string, { name: string; notes: Note[] }>();
  for (const n of k.notes.filter((x) => x.aboutId)) { const g = byPerson.get(n.aboutId!) ?? { name: n.about ?? "Someone", notes: [] }; g.notes.push(n); byPerson.set(n.aboutId!, g); }
  const general = k.notes.filter((x) => !x.aboutId);
  return <div className={mem.stack} data-ai-knowledge="">
    <Panel title="Standing rules" icon={<ScrollText size={16} aria-hidden="true" />} sub={k.rules.length ? `${k.rules.length} rule${k.rules.length === 1 ? "" : "s"} it follows on every run.` : "Rules it follows on every run. Say “always…”, “never…” or “every quotation should…” in a chat with it, or add one here."}>
      {k.canRule ? <AddLine placeholder="Add a rule: Every quotation should mention 50% advance with the order" label="A rule for it" busy={busy} button="Add rule"
        onAdd={(body) => run(() => post(`agents/${id}/rules`, { body }), "Rule added")} /> : null}
      {k.rules.length ? <ul className={css.list}>{k.rules.map((r) => <li key={r.id} className={css.item} data-rule="">
        <span className={css.itemIcon}><ScrollText size={15} aria-hidden="true" /></span>
        <Editable text={r.body} can={k.canRule} busy={busy} label="Edit this rule" max={600}
          onSave={(body) => run(() => post(`agents/${id}/rules`, { id: r.id, body }), "Rule saved")}
          onRemove={() => run(() => post(`agents/rules/${r.id}/retire`, {}), "Rule removed")}>
          <span className={css.wrap}>{r.body}</span>
          {r.include ? <span className={mem.include}>Every quotation it drafts will include: <b>{r.include}</b></span> : null}
          <small><span className={mem.chip}>{SCOPE[r.scope]}</span> Set by {r.setBy} · {day(r.setAt, zone)}{r.source === "chat" ? " · in chat" : ""}{r.editedAt ? " · edited" : ""}</small>
        </Editable></li>)}</ul> : null}
    </Panel>
    <Panel title="Notes about people" icon={<UserRound size={16} aria-hidden="true" />} sub="One assistant for everyone, with notes about each person it works with. It reads a person’s notes only when it works with them.">
      {k.canEdit ? <AddNote people={k.people} busy={busy} onAdd={(body, about) => run(() => post(`agents/${id}/notes`, { body, aboutPersonId: about }), "Noted")} /> : null}
      {byPerson.size ? [...byPerson.entries()].map(([pid, g]) => <section key={pid} className={mem.person} aria-label={`How ${g.name} works`}>
        <h4>How {g.name} works</h4>
        <ul className={css.list}>{g.notes.map((n) => <NoteRow key={n.id} n={n} k={k} busy={busy} id={id} run={run} zone={zone} />)}</ul></section>)
        : <EmptyState art="nothing" title="No notes about anyone yet" text="In a chat, tell it: “Remember that Bevit reviews quotes after lunch.”" />}
    </Panel>
    <Panel title="Other notes" icon={<BookOpen size={16} aria-hidden="true" />} sub={`${general.length ? `${general.length} note${general.length === 1 ? "" : "s"}` : "None yet"}, given to every run.`}>
      {general.length ? <ul className={css.list}>{general.map((n) => <NoteRow key={n.id} n={n} k={k} busy={busy} id={id} run={run} zone={zone} />)}</ul> : null}
    </Panel>
    {fail ? <p role="alert" className={css.error}>{fail}</p> : null}
  </div>;
}

function NoteRow({ n, k, busy, id, run, zone }: { n: Note; k: Knowledge; busy: boolean; id: string; run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>; zone: string }) {
  return <li className={css.item} data-source={n.source}>
    <span className={css.itemIcon}>{n.source === "agent" ? <Brain size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}</span>
    <Editable text={n.body} can={k.canEdit} busy={busy} label="Edit this note" max={1000}
      onSave={(body) => run(() => post(`agents/${id}/notes`, { id: n.id, body, aboutPersonId: n.aboutId }), "Note saved")}
      onRemove={() => run(() => post(`agents/memory/${n.id}/retire`, {}), "Note removed")}>
      <span className={css.wrap}>{n.body}</span>
      <small>{n.topic && n.topic !== "general" ? <span className={mem.chip}>{n.topic}</span> : null}{n.source === "agent" ? "Learned on a task" : n.source === "chat" ? `Asked by ${n.by} in chat` : `From ${n.by}`} · {day(n.at, zone)}{n.editedAt ? " · edited" : ""}</small>
    </Editable></li>;
}

/** A line of text shown, or edited in place; remove asks nothing more (undo is adding it again). */
function Editable({ text, can, busy, label, max, onSave, onRemove, children }: { text: string; can: boolean; busy: boolean; label: string; max: number; onSave: (t: string) => Promise<boolean>; onRemove: () => Promise<boolean>; children: ReactNode }) {
  const [edit, setEdit] = useState<string | null>(null);
  if (edit !== null) return <form className={mem.edit} onSubmit={(e) => { e.preventDefault(); if (edit.trim()) void onSave(edit.trim()).then((ok) => { if (ok) setEdit(null); }); }}>
    <textarea value={edit} onChange={(e) => setEdit(e.target.value)} maxLength={max} rows={2} aria-label={label} autoFocus />
    <span className={mem.editTools}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button>
      <button type="button" className={styles.btn} onClick={() => setEdit(null)}><X size={14} aria-hidden="true" />Cancel</button></span></form>;
  return <>
    <span className={css.itemMain}>{children}</span>
    {can ? <span className={mem.rowTools}>
      <button type="button" className={css.iconBtn} aria-label={label} title={label} onClick={() => setEdit(text)} disabled={busy}><Pencil size={15} aria-hidden="true" /></button>
      <button type="button" className={css.iconBtn} aria-label="Remove" title="Remove" onClick={() => void onRemove()} disabled={busy}><Trash2 size={15} aria-hidden="true" /></button></span> : null}
  </>;
}

function AddLine({ placeholder, label, busy, button, onAdd }: { placeholder: string; label: string; busy: boolean; button: string; onAdd: (t: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  return <form className={css.teach} onSubmit={(e: FormEvent) => { e.preventDefault(); if (text.trim().length >= 3) void onAdd(text.trim()).then((ok) => { if (ok) setText(""); }); }}>
    <input value={text} onChange={(e) => setText(e.target.value)} maxLength={600} placeholder={placeholder} aria-label={label} />
    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || text.trim().length < 3}><Plus size={15} aria-hidden="true" />{button}</button></form>;
}

function AddNote({ people, busy, onAdd }: { people: Knowledge["people"]; busy: boolean; onAdd: (t: string, about: string | null) => Promise<boolean> }) {
  const [text, setText] = useState(""), [about, setAbout] = useState<string | null>(null);
  return <form className={mem.addNote} onSubmit={(e: FormEvent) => { e.preventDefault(); if (text.trim()) void onAdd(text.trim(), about).then((ok) => { if (ok) { setText(""); } }); }}>
    <PersonSelect label="About" people={people} value={about} noneLabel="No one in particular" placeholder="No one in particular" onChange={(p) => setAbout(p?.id ?? null)} />
    <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="How they like to work: reviews quotes after lunch, prefers WhatsApp" aria-label="A note" />
    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !text.trim()}><Plus size={15} aria-hidden="true" />Add note</button></form>;
}

function Panel({ title, sub, icon, children }: { title: string; sub?: string; icon?: ReactNode; children: ReactNode }) {
  return <section className={css.pane} aria-label={title}>
    <header className={css.paneHead}><div><h3 className={mem.title}>{icon}{title}</h3>{sub ? <p>{sub}</p> : null}</div></header>
    <div className={css.paneBody}>{children}</div></section>;
}

/** Who gives the final approval for each kind of action; its owner unless someone else is chosen. */
export function FinalApprovers({ id, canManage, people }: { id: string; canManage: boolean; people: { id: string; name: string }[] }) {
  const { data, error, load } = useLoad<{ approvers: Approver[] }>(`agents/${id}/approvers`);
  const [busy, setBusy] = useState(false), [fail, setFail] = useState("");
  async function pick(action: Approver["action"], personId: string | null) {
    setBusy(true); setFail("");
    try { await post(`agents/${id}/approvers`, { action, personId }); notify({ id: "ai-approver", tone: "success", title: "Final approver saved", timeout: 2200 }); load(); }
    catch (e) { setFail((e as Error).message); } finally { setBusy(false); }
  }
  if (error) return <p role="alert" className={css.error}>{error}</p>;
  if (!data) return <SkeletonRows rows={3} height={52} label="Loading who approves" />;
  return <div className={mem.approvers} data-final-approvers="">
    {data.approvers.map((a) => <div key={a.action} className={mem.approver}>
      <span><b>{ACTION[a.action].label}</b><small>{ACTION[a.action].help}</small></span>
      {canManage ? <PersonSelect label={`Final approval: ${ACTION[a.action].label}`} people={people} value={a.chosen ? a.personId : null}
        noneLabel={`${a.usual ?? "Its owner"} (usual)`} placeholder={`${a.usual ?? "Its owner"} (usual)`} onChange={(p) => { if (!busy) void pick(a.action, p?.id ?? null); }} />
        : <b className={mem.who}>{a.name ?? "Its owner"}{a.chosen ? "" : " (usual)"}</b>}
    </div>)}
    {fail ? <p role="alert" className={css.error}>{fail}</p> : null}
  </div>;
}

/** AI-AGENTS-2: a token figure at a glance (3 crore, 2.5 lakh, 45k). */
const short = (n: number) => { const t = (x: number) => (Math.round(x * 10) / 10).toString(); return n >= 10000000 ? `${t(n / 10000000)} crore` : n >= 100000 ? `${t(n / 100000)} lakh` : n >= 1000 ? `${t(n / 1000)}k` : String(Math.round(n)); };
/** "2.6 lakh of 3 lakh tokens left today"; "3 crore tokens left today" while nearly all of it is left (not "3 crore of 3 crore"). */
const leftWords = (used: number, limit: number, label: string) => { const left = short(Math.max(0, limit - used)), all = short(limit), when = label === "Today" ? "today" : label.toLowerCase();
  return left === all ? `${all} tokens left ${when}` : `${left} of ${all} tokens left ${when}`; };
/** Its budget: today's and this month's use, amber from 80%, and "Add budget" for admins and leadership. */
export function BudgetMeter({ id, compact = false }: { id: string; compact?: boolean }) {
  const { data: b, load } = useLoad<BudgetState>(`agents/${id}/budget`);
  const [busy, setBusy] = useState(false), [fail, setFail] = useState(""), [editInr, setEditInr] = useState(false);
  // TOKENS-2: its rupees a month (admins and leadership; empty clears). Warned at 80%, stopped at 100%, like tokens.
  async function saveInr(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setFail("");
    const v = String(new FormData(e.currentTarget).get("inr") ?? "").replace(/[₹,\s]/g, "");
    try { await post(`agents/${id}/rupee-budget`, { monthlyInr: v ? Number(v) : null }); notify({ id: "ai-budget", tone: "success", title: v ? "Rupee budget saved" : "Rupee budget removed", message: v ? `${rs(Number(v))} a month. It warns at 80%.` : "It keeps its token limits.", timeout: 2600 }); setEditInr(false); load(); }
    catch (err) { setFail((err as Error).message); } finally { setBusy(false); }
  }
  async function add() {
    setBusy(true); setFail("");
    try { const r = await post<{ added: number; scope: string }>(`agents/${id}/budget/add`, { scope: "auto" }); notify({ id: "ai-budget", tone: "success", title: "Budget added", message: `${num(r.added)} more tokens ${r.scope === "month" ? "this month" : "today"}.`, timeout: 2600 }); load(); }
    catch (e) { setFail((e as Error).message); } finally { setBusy(false); }
  }
  if (!b) return null;
  const rows: { key: string; label: string; m: Meter }[] = [
    ...(b.month.limit ? [{ key: "month", label: "This month", m: b.month }] : []),
    { key: "day", label: "Today", m: b.day },
    ...(b.org?.limit ? [{ key: "org", label: "Company today", m: b.org }] : [])];
  const inrRows: { key: string; label: string; m: Meter }[] = [
    ...(b.rupees?.limit ? [{ key: "rupees", label: "Rupees this month", m: b.rupees }] : []),
    ...(b.orgRupees?.limit ? [{ key: "orgRupees", label: "Company rupees", m: b.orgRupees }] : [])];
  const word = b.level === "out" ? (b.period === "month" ? "This month’s budget is used up." : b.period === "plan" ? "The company’s AI plan is used up." : b.period === "org" ? "The company’s AI budget for today is used up."
      : b.period === "rupees" ? "This month’s rupee budget is used up." : b.period === "org_rupees" ? "The company’s AI rupees for this month are used up." : "Today’s budget is used up.")
    : b.level === "warn" ? `${b.share}% used. It warned ${b.owner.name ?? "its owner"}.` : "";
  const button = b.canAdd && b.level !== "ok" && b.period !== "rupees" && b.period !== "org_rupees" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void add()} disabled={busy} data-add-budget=""><Plus size={14} aria-hidden="true" />Add budget</button> : null;
  // AI-AGENTS-2 (owner: "show budget as tokens, not 13%"): the line under a chat with an AI says what is left, in tokens.
  if (compact) return <div className={mem.bar} data-level={b.level} role="status" data-ai-budget="">
    <Gauge size={14} aria-hidden="true" />
    <span className={mem.barText}>{b.level === "out" ? `${word} ${b.owner.name ?? "An admin"} can add more.` : rows[0].m.limit ? leftWords(rows[0].m.used, rows[0].m.limit, rows[0].label) : `${short(rows[0].m.used)} tokens used ${rows[0].label.toLowerCase()}`}</span>
    <span className={css.meter} role="progressbar" aria-label={`${rows[0].label} budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, rows[0].m.share ?? 0)} data-high={b.level !== "ok" ? "" : undefined}><span style={{ width: `${Math.min(100, rows[0].m.share ?? 0)}%` }} /></span>
    {button}</div>;
  // AI-AGENTS-3 (judge: "the gauge's needle points sideways at '100% left'"; "3,00,00,000 means little"): one bar per
  // period with what is used and what is left in short figures (45k used · 3 crore left), amber from 80% as before.
  return <div className={mem.budget} data-level={b.level} data-ai-budget="">
    {rows.map((r) => { const pct = Math.min(100, r.m.share ?? 0);
      return <div key={r.key} className={mem.budgetRow}><b>{r.label}</b>
        <span className={css.meter} role="progressbar" aria-label={`${r.label}: share of the limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-high={pct >= 80 ? "" : undefined}>
          <span style={{ width: `${r.m.used ? Math.max(1, pct) : 0}%` }} /></span>
        <small className={mem.budgetLeft}>{short(r.m.used)} used{r.m.limit ? ` · ${short(Math.max(0, r.m.limit - r.m.used))} left` : ""}</small></div>; })}
    {inrRows.map((r) => { const pct = Math.min(100, r.m.share ?? 0);
      return <div key={r.key} className={mem.budgetRow} data-inr=""><b>{r.label}</b>
        <span className={css.meter} role="progressbar" aria-label={`${r.label}: share of the limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-high={pct >= 80 ? "" : undefined}>
          <span style={{ width: `${r.m.used ? Math.max(1, pct) : 0}%` }} /></span>
        <small className={mem.budgetLeft}>{rs(r.m.used)} of {rs(r.m.limit ?? 0)}</small></div>; })}
    {word ? <p className={mem.budgetWord} role="status">{word}{b.level === "out" ? ` It tells people who write to it, and ${b.owner.name ?? "its owner"} can add more.` : ""}</p> : null}
    {button}{!b.canAdd && b.level !== "ok" ? <small className={css.note}>Admins and leadership add budget.</small> : null}
    {b.canAdd ? (editInr
      ? <form className={mem.inrForm} onSubmit={(e) => void saveInr(e)}>
          <label>Rupees a month <input name="inr" inputMode="decimal" defaultValue={b.rupees?.limit ?? ""} placeholder="Empty for no rupee limit" aria-describedby={`inr-hint-${id}`} /></label>
          <small id={`inr-hint-${id}`} className={css.note}>At the AI engines&apos; list prices. It warns at 80% and stops at 100%.</small>
          <span className={mem.inrActions}><button type="submit" className={styles.btn} disabled={busy}>Save</button><button type="button" className={styles.btn} onClick={() => setEditInr(false)}>Cancel</button></span>
        </form>
      : <button type="button" className={styles.btn} onClick={() => setEditInr(true)} data-set-inr="">{b.rupees?.limit ? "Change the rupee budget" : "Set a rupee budget"}</button>) : null}
    {fail ? <p role="alert" className={css.error}>{fail}</p> : null}
  </div>;
}
