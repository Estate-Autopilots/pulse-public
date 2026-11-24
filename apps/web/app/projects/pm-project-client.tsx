"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarClock, Megaphone } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
const post_ = post;
import { Drawer, DrawerFooter } from "../kit";
import { styles } from "../ui";
import css from "./pm-project.module.css";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));

/** The next step's one button, the one that fits the viewer: Start (theirs, not started), Mark done (theirs, under way;
 *  a gate or going live is recorded on its own step), else Open. Never for an AI: the server refuses that anyway. */
export function NextStepAction({ step }: { step: { id: string; title: string; status: string; mine: boolean; tone: string; gate: boolean } }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const act = step.mine && step.status === "open" && step.tone !== "client" ? { label: "Start", to: "in_progress" }
    : step.mine && step.status === "in_progress" && !step.gate ? { label: "Mark done", to: "done" } : null;
  const run = async () => {
    if (!act) return; setBusy(true);
    try { await post(`tasks/${step.id}/move`, { status: act.to }); notify({ id: "pm-next", tone: "success", title: act.to === "done" ? `Done: ${step.title}` : `Started: ${step.title}` }); router.refresh(); }
    catch (e) { notify({ id: "pm-next", tone: "error", title: "Not changed", message: msg(e) }); }
    finally { setBusy(false); }
  };
  return <div className={css.nextActions}>
    {act ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.primary}`} onClick={run} disabled={busy}>{busy ? "Saving…" : act.label}</button>
      : <Link href={`/tasks/${step.id}`} className={`${styles.btn} ${styles.btnPrimary} ${css.primary}`}>{step.tone === "turn" ? "Review it" : "Open the step"}</Link>}
    {act ? <Link href={`/tasks/${step.id}`} className={css.open}>Open</Link> : null}
  </div>;
}

type Clock = { key: string; label: string; on: string | null; happened: boolean };
type Move = { id: string; code: string | null; title: string; clock: string; from: string; to: string };
type Preview = { clock: string; label: string; from: string; to: string; days: number; happened: boolean; steps: number; moves: Move[]; later: { clock: string; label: string; from: string; to: string }[]; applied: boolean; told?: number };

/** SPEC §1.9 / the Mac's screen 11: move a clock. Pick the clock and the new day; the sheet shows what moves ("41 steps
 *  move +3 days", each date before → after), a reason from the plan's list is required, then Save. A clock that already
 *  happened can only be corrected to a day that has passed. */
export function ClockMoveButton({ projectId, clocks, reasons, today }: { projectId: string; clocks: Clock[]; reasons: { key: string; label: string }[]; today: string }) {
  const [open, setOpen] = useState(false);
  const movable = clocks.filter((c) => c.on);
  if (!movable.length) return null;
  return <>
    <button type="button" className={`${styles.btn} ${css.moveBtn}`} onClick={() => setOpen(true)}><CalendarClock size={15} aria-hidden="true" />Move a date</button>
    {open ? <ClockMoveSheet projectId={projectId} clocks={movable} reasons={reasons} today={today} onClose={() => setOpen(false)} /> : null}
  </>;
}

function ClockMoveSheet({ projectId, clocks, reasons, today, onClose }: { projectId: string; clocks: Clock[]; reasons: { key: string; label: string }[]; today: string; onClose: () => void }) {
  const router = useRouter();
  const [clock, setClock] = useState(clocks[0].key);
  const cur = clocks.find((c) => c.key === clock)!;
  const [on, setOn] = useState(cur.on ?? today);
  const [reason, setReason] = useState(""); const [note, setNote] = useState(""); const [all, setAll] = useState(false);
  const [got, setPreview] = useState<Preview | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [tried, setTried] = useState(false);
  useEffect(() => {
    let live = true;
    if (!on || on === cur.on) return;
    const t = setTimeout(() => { post<Preview>(`projects/${projectId}/clock-move`, { clock, on, apply: false }).then((p) => { if (live) { setPreview(p); setErr(null); } }).catch((e) => { if (live) { setPreview(null); setErr(msg(e)); } }); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [projectId, clock, on, cur.on]);
  // The preview shown is the one for the clock and day now chosen (an older answer is not shown).
  const preview = got && got.clock === clock && got.to === on && on !== cur.on ? got : null;
  const save = async () => {
    setTried(true);
    if (!reason) return;
    setBusy(true);
    try { const r = await post<Preview>(`projects/${projectId}/clock-move`, { clock, on, reason, note: note.trim() || null, apply: true });
      notify({ id: "clock-move", tone: "success", title: `${r.label} moved to ${day(r.to)}`, message: `${r.steps} ${r.steps === 1 ? "step moves" : "steps move"} ${r.days > 0 ? "+" : ""}${r.days} days${r.told ? ` · ${r.told} ${r.told === 1 ? "person" : "people"} told` : ""}` });
      onClose(); router.refresh(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const sign = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
  return <Drawer title={`Move ${cur.label}`} onClose={onClose} size="md" icon={<CalendarClock size={18} />}
    footer={<DrawerFooter status={err} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy || !preview || !preview.days}>{busy ? "Saving…" : "Move the dates"}</button>}>
      <button type="button" className={styles.btn} onClick={onClose}>Cancel</button></DrawerFooter>}>
    <div className={css.sheet}>
      {clocks.length > 1 ? <div className={css.seg} role="radiogroup" aria-label="Which date">{clocks.map((c) => <button key={c.key} type="button" role="radio" aria-checked={c.key === clock}
        onClick={() => { setClock(c.key); setOn(c.on ?? today); setPreview(null); setErr(null); }}>{c.label}</button>)}</div> : null}
      <label className={css.field}><span>New day</span><input type="date" value={on} max={cur.happened ? today : undefined} onChange={(e) => setOn(e.target.value)} /></label>
      <p className={css.fromTo}>{cur.happened ? "Happened on" : "Planned for"} <b>{cur.on ? day(cur.on) : "—"}</b>{on && on !== cur.on ? <> → <b className={css.newDay}>{day(on)}</b></> : null}</p>
      {preview && preview.days ? <section className={css.preview} aria-label="What moves">
        <p className={css.previewHead}><b>{preview.steps} {preview.steps === 1 ? "step moves" : "steps move"} {sign(preview.days)} {Math.abs(preview.days) === 1 ? "day" : "days"}</b>
          {preview.happened ? " (their stored dates)" : " (their planned dates)"}</p>
        {preview.later.map((l) => <p key={l.clock} className={css.laterLine}>{l.label}: {day(l.from)} → <b>{day(l.to)}</b></p>)}
        <ul className={css.moves}>{preview.moves.slice(0, all ? 200 : 5).map((m) => <li key={m.id}><span>{m.code ? m.title.replace(new RegExp(`^${m.code}\\s+`), "") : m.title}</span><span className={css.moveDates}>{day(m.from)} → <b>{day(m.to)}</b></span></li>)}</ul>
        {preview.moves.length > 5 && !all ? <button type="button" className={css.showAll} onClick={() => setAll(true)}>Show all {preview.moves.length}</button> : null}
        <p className={css.stays}>Steps that are done, and dates a person set by hand, stay as they are.</p>
      </section> : on && on !== cur.on && !err ? <p className={css.more}>Working out what moves…</p> : null}
      <label className={css.field}><span>Why the dates change</span>
        <select value={reason} onChange={(e) => { setReason(e.target.value); setErr(null); }} aria-invalid={tried && !reason ? true : undefined}>
          <option value="">Choose a reason</option>{reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
        {tried && !reason ? <small className={css.fieldError} role="alert">Reason is required</small> : null}</label>
      <label className={css.field}><span>Note (optional)</span><input type="text" value={note} maxLength={250} onChange={(e) => setNote(e.target.value)} placeholder="What happened, in a few words" /></label>
      <p className={css.told}>Everyone whose steps move is told once.</p>
    </div>
  </Drawer>;
}

type Draft = { done: string[]; next: string[]; help: string[] };
const HEALTHS = [["on_track", "On track"], ["at_risk", "At risk"], ["late", "Late"], ["waiting_client", "Waiting on client"]] as const;
const RANK = ["late", "at_risk", "waiting_client", "needs_setup", "not_started", "on_track", "paused", "done"];
const rowsFor = (t: string, min: number) => Math.min(10, Math.max(min, t.split("\n").length + 1));
const bullets = (xs: string[]) => xs.map((x) => `• ${x}`).join("\n");

/** The Mac's screen 13: this week's update. The draft comes from the week's steps (done, coming, needing help); the lead
 *  edits it, picks the health (the system's view shows beside it; better than the system needs a reason) and posts. Only
 *  a person posts it; nothing posts by itself. */
export function UpdateButton({ projectId, draft, system, late }: { projectId: string; draft: Draft; system: { health: string; word: string; reason: string | null }; late: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={`${styles.btn} ${css.moveBtn}`} onClick={() => setOpen(true)}>{late ? "Write this week's update" : "Write an update"}</button>
    {open ? <UpdateSheet projectId={projectId} draft={draft} system={system} onClose={() => setOpen(false)} /> : null}
  </>;
}

function UpdateSheet({ projectId, draft, system, onClose }: { projectId: string; draft: Draft; system: { health: string; word: string; reason: string | null }; onClose: () => void }) {
  const router = useRouter();
  const [done, setDone] = useState(bullets(draft.done)); const [next, setNext] = useState(bullets(draft.next)); const [help, setHelp] = useState(bullets(draft.help));
  const pickable = HEALTHS.some(([k]) => k === system.health) ? system.health : "on_track";
  const [health, setHealth] = useState<string>(pickable); const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const better = RANK.indexOf(health) > RANK.indexOf(system.health);
  const post = async () => {
    if (better && !reason.trim()) { setErr("Say why it is better than the system says"); return; }
    const body = [["Done this week", done], ["Next week", next], ["Needs help", help]].filter(([, t]) => t.trim()).map(([h, t]) => `${h}\n${t.trim()}`).join("\n\n");
    if (!body.trim()) { setErr("Write what happened this week"); return; }
    setBusy(true);
    try { await post_(`projects/${projectId}/update`, { body, health, system: system.health, reason: better ? reason.trim() : null });
      notify({ id: "pm-update", tone: "success", title: "Update posted" }); onClose(); router.refresh(); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return <Drawer title="This week's update" onClose={onClose} size="md" icon={<Megaphone size={18} />}
    footer={<DrawerFooter status={err} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={post} disabled={busy}>{busy ? "Posting…" : "Post update"}</button>}>
      <button type="button" className={styles.btn} onClick={onClose}>Cancel</button></DrawerFooter>}>
    <div className={css.sheet}>
      <p className={css.draftNote}>Drafted from this week&apos;s steps. Change anything; nothing is posted until you press Post.</p>
      <fieldset className={css.healthPick}><legend>How is the project doing?</legend>
        <div className={css.seg} role="radiogroup" aria-label="Health">{HEALTHS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={health === k} onClick={() => { setHealth(k); setErr(null); }}>{label}</button>)}</div>
        <small className={css.systemSays}>System says: {system.word}{system.reason ? ` · ${system.reason}` : ""}</small>
      </fieldset>
      <label className={css.field}><span>Done this week</span><textarea rows={rowsFor(done, 3)} value={done} onChange={(e) => setDone(e.target.value)} placeholder="• What got done" /></label>
      <label className={css.field}><span>Next week</span><textarea rows={rowsFor(next, 3)} value={next} onChange={(e) => setNext(e.target.value)} placeholder="• What comes next" /></label>
      <label className={css.field}><span>Needs help</span><textarea rows={rowsFor(help, 2)} value={help} onChange={(e) => setHelp(e.target.value)} placeholder="• Anything stuck (leave empty if nothing)" /></label>
      {better ? <label className={css.field}><span>Why it is better than the system says</span><input type="text" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="For example: the client sent the plans this morning" /></label> : null}
    </div>
  </Drawer>;
}
