"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "../records";
import { styles } from "../ui";
import { ACTION, day, STATUS, type Edge, type Kind, type Setup, type Version } from "./types";
import css from "./relationships.module.css";

const SINGLE: Kind[] = ["development", "client", "team", "account_owner"];
type Option = { id?: string; key?: string; label: string; sub: string | null };
const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`); const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Could not load"); return data as T;
}

/** Choose the other side from records of the right kind: a search, never a guess. Same names are listed apart. */
function Picker({ kind, label, onPick, onCancel }: { kind: Kind; label: string; onPick: (o: Option, note: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState(""), [options, setOptions] = useState<Option[]>([]), [chosen, setChosen] = useState<Option | null>(null), [note, setNote] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { get<{ options: Option[] }>(`relationships/options?kind=${kind}&q=${encodeURIComponent(q)}`).then((r) => setOptions(r.options)).catch((e) => setError(message(e))); }, 200);
    return () => clearTimeout(t);
  }, [kind, q]);
  return <div className={css.picker}>
    <input className={styles.input} type="search" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setChosen(null); }} placeholder="Search by name…" aria-label={`Search records for ${label}`} />
    <ul className={css.options} role="listbox" aria-label="Matching records">
      {options.map((o) => <li key={o.id ?? o.key}><button type="button" role="option" aria-selected={chosen === o} className={css.option} data-chosen={chosen === o ? "" : undefined} onClick={() => setChosen(o)}>
        <b>{o.label}</b>{o.sub ? <small>{o.sub}</small> : null}</button></li>)}
      {!options.length ? <li className={styles.muted}>{error || "No matching record"}</li> : null}
    </ul>
    <input className={styles.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" aria-label="Why" maxLength={500} />
    <span className={styles.inline}>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={!chosen} onClick={() => chosen && onPick(chosen, note)}>{label}</button>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={onCancel}>Cancel</button>
    </span>
  </div>;
}

function History({ thread }: { thread: string }) {
  const [rows, setRows] = useState<Version[] | null>(null), [error, setError] = useState("");
  useEffect(() => { get<{ versions: Version[] }>(`relationships/history/${thread}`).then((r) => setRows(r.versions)).catch((e) => setError(message(e))); }, [thread]);
  if (error) return <p role="alert" className={styles.muted}>{error}</p>;
  if (!rows) return <p className={styles.muted}>Loading the history…</p>;
  return <ol className={css.history} aria-label="Versions of this relationship">{rows.map((v) => <li key={v.id} data-undone={v.undoneAt ? "" : undefined}>
    <b>{ACTION[v.action] ?? v.action}</b> · {v.objectLabel} · {STATUS[v.status].label}{v.standing ? " (the confirmed one stood)" : ""}
    <small>{v.by ?? "Pulse"} · {day(v.at)}{v.note ? ` · “${v.note}”` : ""}{v.undoneAt ? ` · undone by ${v.undoneBy ?? "someone"} on ${day(v.undoneAt)}` : ""}</small>
  </li>)}</ol>;
}

/** Confirm, reject or correct (named reviewers), undo the newest decision, suggest a change, or read the history. */
export function EdgeActions({ edge: e }: { edge: Edge }) {
  const router = useRouter();
  const [open, setOpen] = useState<"" | "correct" | "suggest" | "history">(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setNote("");
    try { await fn(); setNote(done); setOpen(""); router.refresh(); } catch (err) { setNote(message(err)); } finally { setBusy(false); }
  };
  const decide = (action: "confirm" | "reject" | "correct", extra: Record<string, string> = {}) =>
    run(() => post(`relationships/history/${e.thread}/decide`, { expected: e.head, action, ...extra }), action === "confirm" ? "Confirmed" : action === "reject" ? "Rejected" : "Corrected");
  const waiting = e.status === "proposed" || !!e.pending;
  const resolved = e.pending ? e.pending.object.resolved : e.object.resolved;
  const single = SINGLE.includes(e.kind);
  return <div className={css.actions}>
    <span className={styles.inline}>
      {e.can.decide && waiting ? <>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !resolved} title={resolved ? undefined : "Choose the record first: a written name alone is never confirmed"}
          onClick={() => void decide("confirm")}>{e.pending ? "Accept the correction" : "Confirm"}</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void decide("reject")}>{e.pending ? "Keep the confirmed one" : "Reject"}</button>
      </> : null}
      {e.can.decide && !waiting && e.status === "confirmed" ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void decide("reject")}>Reject</button> : null}
      {e.can.decide && single ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => setOpen(open === "correct" ? "" : "correct")}>{resolved ? "Correct…" : "Choose the record…"}</button> : null}
      {!e.can.decide && single ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => setOpen(open === "suggest" ? "" : "suggest")}>Suggest a change…</button> : null}
      {e.can.undo ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy}
        onClick={() => void run(() => post(`relationships/history/${e.thread}/undo`, { expected: e.head }), "Undone")}>Undo</button> : null}
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-expanded={open === "history"} onClick={() => setOpen(open === "history" ? "" : "history")}>History</button>
      {note ? <span role="status" className={styles.muted}>{note}</span> : null}
    </span>
    {open === "correct" ? <Picker kind={e.kind} label="Confirm this record" onCancel={() => setOpen("")}
      onPick={(o, why) => void decide("correct", { ...(o.id ? { id: o.id } : { key: o.key! }), ...(why ? { note: why } : {}) })} /> : null}
    {open === "suggest" ? <Picker kind={e.kind} label="Send to a reviewer" onCancel={() => setOpen("")}
      onPick={(o, why) => void run(() => post("relationships/suggest", { kind: e.kind, subject: e.subject.id, ...(o.id ? { id: o.id } : { key: o.key! }), ...(why ? { note: why } : {}) }), "Sent to the reviewers")} /> : null}
    {open === "history" ? <History thread={e.thread} /> : null}
  </div>;
}

/** Admins name who reviews which kinds of relationship (owner errand E14). Nobody reviews until named. */
export function ReviewerAdmin({ setup }: { setup: Setup }) {
  const router = useRouter();
  const [person, setPerson] = useState(""), [kinds, setKinds] = useState<Kind[]>([]), [why, setWhy] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const save = async (personId: string, k: Kind[], text: string, done: string) => {
    setBusy(true); setNote("");
    try { await post("relationships/reviewers", { personId, kinds: k, note: text }); setNote(done); setPerson(""); setKinds([]); setWhy(""); router.refresh(); }
    catch (e) { setNote(message(e)); } finally { setBusy(false); }
  };
  const label = (k: Kind) => setup.kinds.find((x) => x.kind === k)?.label ?? k;
  return <div className={css.setup}>
    <h3>Reviewers</h3>
    {setup.reviewers.length ? <ul className={css.reviewers}>{setup.reviewers.map((r) => <li key={r.personId}>
      <span><b>{r.name}</b><small>{r.kinds.map(label).join(", ")} · {r.waiting} waiting</small></span>
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void save(r.personId, [], "", "Removed")}>Remove</button>
    </li>)}</ul> : <p className={css.small}>Nobody yet. The owner names who knows each kind (errand E14); until then nothing is confirmed and nobody is notified.</p>}
    <label className={styles.field}>Colleague<select value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Choose…</option>
      {setup.staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.pod ? ` · ${s.pod}` : ""}</option>)}</select></label>
    <fieldset className={css.kinds}><legend>Reviews</legend>{setup.kinds.map((k) => <label key={k.kind}>
      <input type="checkbox" checked={kinds.includes(k.kind)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k.kind] : kinds.filter((x) => x !== k.kind))} />{k.label}</label>)}</fieldset>
    <label className={styles.field}>Why them (optional)<input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={300} /></label>
    <span className={styles.inline}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !person || !kinds.length} onClick={() => void save(person, kinds, why, "Saved")}>Name reviewer</button>
      {note ? <span role="status" className={styles.muted}>{note}</span> : null}</span>
  </div>;
}

/** The owner's definition of "models". Recorded by an admin when the owner gives it; withdrawing hides model links again. */
export function ModelDefinition({ model, hidden }: { model: Setup["model"]; hidden: number }) {
  const router = useRouter();
  const [definition, setDefinition] = useState(""), [source, setSource] = useState(""), [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const save = async (body: Record<string, string | null>, done: string) => {
    setBusy(true); setNote("");
    try { await post("relationships/models", body); setNote(done); router.refresh(); } catch (e) { setNote(message(e)); } finally { setBusy(false); }
  };
  if (model) return <div className={css.setup}>
    <p className={css.small}><b>“{model.definition}”</b><br />Source: {model.source} · recorded by {model.by ?? "an admin"} on {day(model.at)}</p>
    <span className={styles.inline}><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void save({ definition: null, source: null }, "Withdrawn")}>Withdraw</button>
      {note ? <span role="status" className={styles.muted}>{note}</span> : null}</span>
  </div>;
  return <div className={css.setup}>
    <p className={css.small}>{hidden} model {hidden === 1 ? "link waits" : "links wait"}, hidden. The owner’s note of 11 October (models and talent) says models are one contact type, each connected to specific projects and clients through shoots. Record a definition only when the owner confirms that is what this graph means.</p>
    <label className={styles.field}>Owner’s definition<textarea value={definition} onChange={(e) => setDefinition(e.target.value)} maxLength={1000} placeholder="In the owner's words" /></label>
    <label className={styles.field}>Where it comes from<input value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} placeholder="e.g. owner voice note, date" /></label>
    <span className={styles.inline}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || definition.trim().length < 10 || source.trim().length < 3} onClick={() => void save({ definition, source }, "Recorded")}>Record definition</button>
      {note ? <span role="status" className={styles.muted}>{note}</span> : null}</span>
  </div>;
}

export function RefreshSources({ runs }: { runs: Setup["runs"] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const last = runs[0];
  return <div className={css.setup}>
    <h3>Sources</h3>
    <p className={css.small}>{last ? `Last read ${day(last.at)} by ${last.by ?? "the worker"}: ${last.counts.added ?? 0} new, ${last.counts.changed ?? 0} changed, ${last.counts.withdrawn ?? 0} withdrawn.` : "Not read yet."}</p>
    <span className={styles.inline}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={async () => {
      setBusy(true); setNote("");
      try { const r = await post<Record<string, number>>("relationships/refresh"); setNote(`${r.added} new, ${r.changed} changed, ${r.withdrawn} withdrawn`); router.refresh(); }
      catch (e) { setNote(message(e)); } finally { setBusy(false); }
    }}>Read the sources again</button>{note ? <span role="status" className={styles.muted}>{note}</span> : null}</span>
  </div>;
}
