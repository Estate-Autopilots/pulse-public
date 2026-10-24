"use client";
// FLOW-C: the Session screen (Repeat · a ritual): a recurring review whose agenda Pulse builds from every running run (the
// work in a given state: cuts waiting for review, deliverables live for a while, open steps), each item with its verdict;
// then the notes, the decisions, and new requests going out (each becomes a request on the board).
import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarClock, Check, Plus, X } from "lucide-react";
import { styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import type { Work } from "./work";
import { dayText, str, strList, todayIso } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";

type Item = { id: string; title: string; run: string; runId: string; code?: string | null; state?: string; due?: string | null; since?: string | null; live?: string | null; verdict?: string | null; stepId?: string | null; type?: string };
const KIND_WORD: Record<string, string> = { rough_cut: "Cuts and drafts waiting for this review", live: "Deliverables live 10–15 days: their verdict", open: "Open steps" };

export function SessionScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null, data = (rec?.data ?? {}) as Record<string, unknown>;
  const kind = str(d.settings.agenda) || "rough_cut";
  const verdictOptions = w.types.find((t) => t.key === "asset")?.fields.find((f) => f.key === "verdict")?.options ?? [];
  const [agenda, setAgenda] = useState<Item[] | null>(Array.isArray(data.agenda) ? data.agenda as Item[] : null), [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState(str(data.notes));
  const [decisions, setDecisions] = useState<string[]>(strList(data.decisions)), [decision, setDecision] = useState("");
  const [requests, setRequests] = useState<string[]>([]), [request, setRequest] = useState("");
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (agenda) return; let on = true;
    flow<{ agenda: Item[] }>(`sessions/agenda?kind=${encodeURIComponent(kind)}`).then((r) => { if (on) setAgenda(r.agenda); }).catch((e) => { if (on) setErr(why(e)); });
    return () => { on = false; };
  }, [agenda, kind]);
  const held = rec?.status === "held";
  const ritual = str(data.ritual) || s.title;
  const every = str(d.settings.every), at = str(d.settings.at);
  async function verdict(item: Item, v: string) {
    setVerdicts((x) => ({ ...x, [item.id]: v }));
    await w.act(`records/${item.id}`, { data: { verdict: v } }, `${item.code ?? item.title}: ${v}`);
  }
  async function record() {
    if (rec && agenda) await w.act(`records/${rec.id}`, { data: { agenda: agenda.map((x) => ({ id: x.id, code: x.code ?? null, title: x.title, run: x.run, verdict: verdicts[x.id] ?? x.verdict ?? null })) } }, null);
    const ok = await w.act(`steps/${s.id}/actions/note`, { notes, decisions, requests }, requests.length ? `Session recorded · ${requests.length} request${requests.length > 1 ? "s" : ""} on the board` : "Session recorded");
    if (ok) setRequests([]);
  }
  return <div className={m.stack}>
    <section className={m.card} aria-label="The session">
      <h3><CalendarClock size={15} aria-hidden="true" />{ritual}<small>{every ? `every ${every}` : ""}{at ? ` at ${at}` : ""}{held ? ` · held ${dayText(str(data.on))}` : ` · ${dayText(todayIso())}`}</small></h3>
      <div className={m.row}><b>{KIND_WORD[kind] ?? "Agenda"}</b><small className={css.quiet}>built from every running run</small>
        <button type="button" className={css.linkBtn} onClick={() => { setAgenda(null); setErr(null); }}>Build it again</button></div>
      {err ? <p className={css.quiet}>{err}</p> : !agenda ? <p className={css.quiet}>Building the agenda…</p> : !agenda.length ? <p className={css.quiet}>Nothing is waiting for this session today.</p>
        : <ol className={m.agenda}>{agenda.map((item) => <li key={item.id}>
          <span><b>{item.code ?? item.title}</b><small>{item.run}{item.state ? ` · ${item.state.replace("_", " ")}` : ""}{item.live ? ` · live since ${dayText(item.live)}` : ""}{item.since ? ` · waiting since ${dayText(item.since)}` : ""}{item.due ? ` · due ${dayText(item.due)}` : ""}</small></span>
          {kind === "live" && verdictOptions.length ? <span className={m.verdicts} role="group" aria-label={`Verdict on ${item.code ?? item.title}`}>{verdictOptions.map((v) => <button key={v} type="button" aria-pressed={(verdicts[item.id] ?? item.verdict) === v} disabled={!w.live || w.busy} onClick={() => void verdict(item, v)}>{v}</button>)}</span> : null}
          <Link href={item.stepId ? `/steps/${item.stepId}` : kind === "open" ? `/steps/${item.id}` : `/runs/${item.runId}`}>Open</Link>
        </li>)}</ol>}
    </section>

    <section className={m.card} aria-label="Notes and decisions">
      <h3>Notes and decisions</h3>
      <label className={m.lab}>Notes<textarea rows={5} value={notes} disabled={!w.live} onChange={(e) => setNotes(e.target.value)} placeholder="What was looked at and what was said" /></label>
      <ListEdit label="Decisions" items={decisions} setItems={setDecisions} value={decision} setValue={setDecision} live={w.live} placeholder="A decision (what, who does it)" />
      <ListEdit label="New requests out" items={requests} setItems={setRequests} value={request} setValue={setRequest} live={w.live} placeholder="A new request (each goes on the request board)" />
      {strList(data.requests).length ? <p className={css.quiet}>Sent to the board last time: {strList(data.requests).join(" · ")}</p> : null}
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy} onClick={() => void record()}>Record the session</button></div> : null}
    </section>

    {w.live ? <div className={css.finishBar}><span>{held ? `Recorded ${dayText(str(data.on))}` : "Record the session, then it is done"}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !held} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Done: the changes and requests go on")}><Check size={14} aria-hidden="true" />Done</button></div>
      : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Held and done.</p> : null}
  </div>;
}

/** A short list typed in one line at a time (decisions, needs, a shot list). */
export function ListEdit({ label, items, setItems, value, setValue, live, placeholder, ordered }: { label: string; items: string[]; setItems: (x: string[]) => void; value: string; setValue: (x: string) => void; live: boolean; placeholder: string; ordered?: boolean }) {
  const L = ordered ? "ol" : "ul";
  return <div className={m.listEditor}>
    <span className={m.lab}>{label}{items.length ? ` · ${items.length}` : ""}</span>
    {items.length ? <L>{items.map((x, i) => <li key={`${i}-${x}`}><span>{x}</span>{live ? <button type="button" className={css.iconBtn} aria-label={`Remove ${x}`} onClick={() => setItems(items.filter((_y, k) => k !== i))}><X size={13} /></button> : null}</li>)}</L> : null}
    {live ? <form className={m.row} onSubmit={(e) => { e.preventDefault(); if (value.trim()) { setItems([...items, value.trim()]); setValue(""); } }}>
      <input className={m.grow} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={500} />
      <button type="submit" className={styles.btn} disabled={!value.trim()}><Plus size={14} aria-hidden="true" />Add</button></form> : null}
  </div>;
}
