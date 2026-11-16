"use client";
// KAZUK-REST slice 6: the cover page's sections. Asked of me (accept, or decline with a reason), cover for my own leave
// and work-from-home days (and "Name who covers" where none is named), what went up and needs a fallback (managers and
// HR name someone else), the SOP's steps, and HR's cover rule.
import { ArrowUpRight, Check, ShieldCheck, UserRoundCheck, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { Badge, Empty, styles } from "../ui";
import css from "./cover.module.css";

type Status = "asked" | "accepted" | "declined" | "escalated" | "cancelled";
export type Cover = { id: string; kind: "leave" | "wfh"; sourceId: string; personId: string; personName: string; coverId: string; coverName: string; fromDate: string; toDate: string;
  coverStart: string | null; coverEnd: string | null; note: string | null; status: Status; respondBy: string; answeredAt: string | null; answerNote: string | null; escalatedAt: string | null; escalatedWhy: "declined" | "no_answer" | null };
export type CoverData = { today: string; policy: { hours: number; required: boolean; sop: string | null; shiftStart: string | null; shiftEnd: string | null }; asked: Cover[]; mine: Cover[]; up: Cover[];
  uncovered: { kind: "leave" | "wfh"; sourceId: string; fromDate: string; toDate: string; what: string }[]; people: { id: string; name: string }[]; canSet: boolean };

const STATUS: Record<Status, { label: string; tone: "neutral" | "warning" | "success" | "accent" }> = {
  asked: { label: "Waiting for an answer", tone: "warning" }, accepted: { label: "Covered", tone: "success" }, declined: { label: "Declined", tone: "warning" },
  escalated: { label: "Needs someone else", tone: "warning" }, cancelled: { label: "Cancelled", tone: "neutral" } };
const day = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${iso}T00:00:00Z`));
const span = (a: { fromDate: string; toDate: string }) => a.fromDate === a.toDate ? day(a.fromDate) : `${day(a.fromDate)} to ${day(a.toDate)}`;
const what = (k: string) => k === "wfh" ? "Work from home" : "Leave";
const hours = (a: { coverStart: string | null; coverEnd: string | null }) => a.coverStart && a.coverEnd ? ` · ${a.coverStart} to ${a.coverEnd}` : "";
/** HR's own steps, one per line (a leading "1." or "-" is the list's own). */
const lines = (text: string) => text.split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean);
/** The standard steps, used until HR writes the company's own. */
const STANDARD = (hrs: number, required: boolean) => [
  `When you ask for leave or a work-from-home day, name the colleague who covers your work${required ? " (required here)" : ""}.`,
  `They are told in Pulse and answer within ${hrs} hours: they cover, or say why they can’t. They cover your working hours, from your shift.`,
  "If they can’t, or don’t answer in time, your manager and HR are told and name someone else.",
  "Hand over before you go: what is due, where the files are, and who to call."];

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "Not saved. Try again.");
  return data as T;
}

function useRun() {
  const router = useRouter(); const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, path: string, body: unknown, done: string) => {
    setBusy(key);
    try { await post(path, body); notify({ id: "cover", tone: "success", title: done, timeout: 2500 }); router.refresh(); return true; }
    catch (e) { notify({ id: "cover", tone: "error", title: "Not saved", message: (e as Error).message }); return false; }
    finally { setBusy(null); }
  };
  return { busy, run };
}

function NameCover({ kind, sourceId, people, label = "Name who covers" }: { kind: "leave" | "wfh"; sourceId: string; people: CoverData["people"]; label?: string }) {
  const { busy, run } = useRun(); const [who, setWho] = useState("");
  return <form className={css.inline} onSubmit={(e: FormEvent) => { e.preventDefault(); if (who) void run(sourceId, "cover/ask", { kind, sourceId, coverId: who }, "Asked. They are told now."); }}>
    <select value={who} onChange={(e) => setWho(e.target.value)} aria-label={`${label}: colleague`} required>
      <option value="">Choose a colleague</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={!who || busy === sourceId}><UserRoundCheck size={13} aria-hidden="true" />{label}</button>
  </form>;
}

function Answer({ a }: { a: Cover }) {
  const { busy, run } = useRun(); const [declining, setDeclining] = useState(false); const [why, setWhy] = useState("");
  if (a.status !== "asked") return <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>;
  if (declining) return <form className={css.inline} onSubmit={(e) => { e.preventDefault(); void run(a.id, `cover/${a.id}/answer`, { accept: false, note: why }, "Declined. HR and the manager are told."); }}>
    <input value={why} onChange={(e) => setWhy(e.target.value)} minLength={3} maxLength={300} required placeholder="Why you cannot (HR reads it)" aria-label="Why you cannot cover" />
    <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === a.id}>Send</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setDeclining(false)}>Back</button>
  </form>;
  return <span className={css.inline}>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy === a.id} onClick={() => void run(a.id, `cover/${a.id}/answer`, { accept: true }, "Thanks. They know you cover.")}><Check size={13} aria-hidden="true" />I’ll cover</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setDeclining(true)}><X size={13} aria-hidden="true" />I can’t</button>
  </span>;
}

function Policy({ policy }: { policy: CoverData["policy"] }) {
  const { busy, run } = useRun(); const [answerIn, setAnswerIn] = useState(String(policy.hours)); const [required, setRequired] = useState(policy.required);
  const [sop, setSop] = useState(policy.sop ?? "");
  return <form className={css.policy} onSubmit={(e) => { e.preventDefault(); void run("policy", "cover/policy", { hours: Number(answerIn), required, sop }, "Cover rule saved"); }}>
    <label>Hours to answer<input type="number" min={1} max={168} value={answerIn} onChange={(e) => setAnswerIn(e.target.value)} required /></label>
    <label className={css.sop}>The steps people read (one per line; leave empty for the standard steps)
      <textarea value={sop} onChange={(e) => setSop(e.target.value)} maxLength={4000} rows={5} placeholder={STANDARD(policy.hours, policy.required).join("\n")} /></label>
    <label className={css.check}><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />Naming a cover is required for leave and work from home</label>
    <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === "policy"}>Save the rule</button>
  </form>;
}

export function CoverBoard({ data }: { data: CoverData; zone: string }) {
  const d = data;
  return <div className={css.grid}>
    <section className={`${styles.panel} ${css.wide}`} aria-labelledby="cover-asked">
      <h2 id="cover-asked" className={css.h}>Asked to cover</h2>
      {d.asked.length ? <ul className={css.list}>{d.asked.map((a) => <li key={a.id} className={css.row}>
        <span className={css.main}><b>{a.personName}</b><small>{what(a.kind)} · {span(a)}{hours(a)}{a.note ? ` · “${a.note}”` : ""}</small></span>
        <Answer a={a} />
      </li>)}</ul> : <Empty compact icon={ShieldCheck} title="Nobody is waiting on you" text="When a colleague names you to cover their leave or work-from-home day, it shows here." />}
    </section>

    <section className={styles.panel} aria-labelledby="cover-mine">
      <h2 id="cover-mine" className={css.h}>Cover for my days away</h2>
      {d.mine.length || d.uncovered.length ? <ul className={css.list}>
        {d.mine.map((a) => <li key={a.id} className={css.row}>
          <span className={css.main}><b>{what(a.kind)} · {span(a)}</b><small>{a.coverName}{hours(a)}{a.answerNote ? ` · “${a.answerNote}”` : ""}</small></span>
          <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
        </li>)}
        {d.uncovered.map((u) => <li key={u.sourceId} className={css.row}>
          <span className={css.main}><b>{what(u.kind)} · {span(u)}</b><small>Nobody named to cover yet</small></span>
          <NameCover kind={u.kind} sourceId={u.sourceId} people={d.people} />
        </li>)}
      </ul> : <Empty compact icon={UserRoundCheck} title="No days away coming up" text="Leave and work-from-home days you ask for show here with who covers them." />}
    </section>

    <section className={styles.panel} aria-labelledby="cover-sop">
      <h2 id="cover-sop" className={css.h}>How cover works</h2>
      <ol className={css.steps}>
        {(d.policy.sop ? lines(d.policy.sop) : STANDARD(d.policy.hours, d.policy.required)).map((l, i) => <li key={i}>{l}</li>)}
      </ol>
      {d.policy.shiftStart && d.policy.shiftEnd ? <p className={css.fine}>Cover follows the working hours: your own shift, else {d.policy.shiftStart} to {d.policy.shiftEnd}.</p> : null}
      <p className={css.fine}>The leave and work-from-home policies say the rest. <Link href="/me?tab=policies&kind=leave">Leave policy <ArrowUpRight size={12} aria-hidden="true" /></Link> · <Link href="/me?tab=policies&kind=wfh">Work-from-home policy <ArrowUpRight size={12} aria-hidden="true" /></Link></p>
      {d.canSet ? <Policy policy={d.policy} /> : null}
    </section>

    {d.canSet || d.up.length ? <section className={`${styles.panel} ${css.wide}`} aria-labelledby="cover-up">
      <h2 id="cover-up" className={css.h}>Needs someone else</h2>
      {d.up.length ? <ul className={css.list}>{d.up.map((a) => <li key={a.id} className={css.row}>
        <span className={css.main}><b>{a.personName} · {what(a.kind)} · {span(a)}</b>
          <small>{a.coverName} {a.escalatedWhy === "declined" ? `can’t cover${a.answerNote ? `: “${a.answerNote}”` : ""}` : "did not answer in time"}</small></span>
        <NameCover kind={a.kind} sourceId={a.sourceId} people={d.people.filter((p) => p.id !== a.personId && p.id !== a.coverId)} label="Ask someone else" />
      </li>)}</ul> : <Empty compact icon={ShieldCheck} title="Every day away is covered or waiting for an answer" text="An ask that is declined or not answered in time shows here for the manager and HR." />}
    </section> : null}
  </div>;
}
