"use client";
// FLOW-C: the boards. Request board (Task · take requests): raise one (for whom, what kind, why), answer it with a
// committed first-drop date, columns by state. Production planning (Meet · plan a shoot or visit): date, call time,
// place, people, needs, shot list, equipment, the call sheet Pulse writes from them, consent and casting. A collecting
// step (a list of personas, facts, words, ideas … or a company's own type): its records as cards with their status.
import { useState } from "react";
import { CalendarCheck, Camera, Check, ClipboardCopy, Inbox, Plus, Printer } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../ui";
import { RecordCard, RecordForm, RecordTable, RecordsInline } from "./records";
import { ListEdit } from "./session";
import type { Work } from "./work";
import { collectType, dayText, str, strList, todayIso } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";
import { DateField } from "../kit/date-field";

export function RequestBoard({ w }: { w: Work }) {
  const { d } = w, s = d.step, t = w.types.find((x) => x.key === "request");
  const [form, setForm] = useState({ title: "", client: d.run.name.replace(/^Demo · /, ""), kind: "", why: "" });
  const [drop, setDrop] = useState<Record<string, string>>({});
  const mine = w.runRecords.filter((r) => r.type === "request");
  const open = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped";
  if (!t) return null;
  async function raise() {
    if (await w.act(`steps/${s.id}/actions/raise`, form, "Raised: it needs a first-drop date within a working day")) setForm({ ...form, title: "", kind: "", why: "" });
  }
  return <div className={m.stack}>
    {open ? <section className={m.card} aria-label="Raise a request">
      <h3><Inbox size={15} aria-hidden="true" />Raise a request</h3>
      <form className={m.boardForm} onSubmit={(e) => { e.preventDefault(); void raise(); }}>
        <label className={m.lab}>What is asked<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Two more image ads for the festive offer" required maxLength={200} /></label>
        <label className={m.lab}>For whom<input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} maxLength={200} /></label>
        <label className={m.lab}>Kind<input value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} placeholder="e.g. Image set, video, landing page" maxLength={80} /></label>
        <label className={m.lab}>Why<textarea rows={2} value={form.why} onChange={(e) => setForm({ ...form, why: e.target.value })} placeholder="What it is for, what changed" /></label>
        <footer><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !form.title.trim()}><Plus size={14} aria-hidden="true" />Raise it</button></footer>
      </form>
    </section> : null}
    <div className={m.board} role="list" aria-label="Requests by state">{t.statuses.map((st) => { const here = mine.filter((r) => r.status === st.key);
      return <section key={st.key} className={m.column} data-tone={st.tone ?? "neutral"} role="listitem" aria-label={st.label}>
        <header><i />{st.label}<small>{here.length}</small></header>
        <ul>{here.map((r) => <li key={r.id} className={m.ticket}>
          <b>{r.title}</b>
          {str(r.data.why) ? <p>{str(r.data.why)}</p> : null}
          <small>{[str(r.data.client), str(r.data.kind), r.data.raised_on ? `raised ${dayText(str(r.data.raised_on))}` : ""].filter(Boolean).join(" · ")}</small>
          {r.data.first_drop ? <small><CalendarCheck size={11} aria-hidden="true" /> First drop {dayText(str(r.data.first_drop))}</small> : null}
          {open && r.status === "raised" ? <form onSubmit={(e) => { e.preventDefault(); if (drop[r.id]) void w.act(`steps/${s.id}/actions/answer`, { recordId: r.id, firstDrop: drop[r.id] }, "Answered with a first-drop date"); }}>
            <DateField min={todayIso()} value={drop[r.id] ?? ""} onChange={(e) => setDrop({ ...drop, [r.id]: e.target.value })} aria-label={`First-drop date for ${r.title}`} />
            <button type="submit" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={w.busy || !drop[r.id]}>Answer</button></form> : null}
          {open && st.next.filter((n) => n !== "answered").length && r.status !== "raised" ? <span className={css.moves}>{st.next.map((n) => { const to = t.statuses.find((x) => x.key === n);
            return <button key={n} type="button" disabled={w.busy} data-tone={to?.tone ?? "neutral"} onClick={() => void w.act(`records/${r.id}/status`, { status: n }, `${r.title}: ${to?.label ?? n}`)}>{to?.label ?? n}</button>; })}</span> : null}
        </li>)}</ul>
      </section>; })}</div>
    {w.live ? <div className={css.finishBar}><span>{mine.filter((r) => r.status === "raised").length ? `${mine.filter((r) => r.status === "raised").length} waiting for a first-drop date` : "Every request has its date"}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Done: the requests go to the steps that need them")}><Check size={14} aria-hidden="true" />Done for now</button></div> : null}
  </div>;
}

export function ShootScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null, data = (rec?.data ?? {}) as Record<string, unknown>;
  const [plan, setPlan] = useState({ on: str(data.on), call_time: str(data.call_time), place: str(data.place) });
  const [people, setPeople] = useState(strList(data.people)), [needs, setNeeds] = useState(strList(data.needs)), [shots, setShots] = useState(strList(data.shot_list)), [kit, setKit] = useState(strList(data.equipment));
  const [one, setOne] = useState({ people: "", needs: "", shots: "", kit: "" });
  const sheet = str(data.call_sheet);
  if (!rec) return <div className={css.emptyWork}><Camera size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The plan opens when the step does" : "No plan yet"}</b><span>{s.state === "waiting" ? s.stateText : "Its person plans it."}</span></div>;
  const save = () => w.act(`steps/${s.id}/actions/plan`, { ...plan, people, needs, shot_list: shots, equipment: kit }, plan.on ? `Planned for ${dayText(plan.on)}` : "Plan saved");
  async function copy() { try { await navigator.clipboard.writeText(sheet); notify({ id: "copy", tone: "success", title: "Call sheet copied", timeout: 2000 }); } catch { /* it stays on screen */ } }
  return <div className={m.stack}>
    <section className={m.card} aria-label="The plan">
      <h3><Camera size={15} aria-hidden="true" />The plan<span className={css.chip} data-tone={rec.status === "scheduled" || rec.status === "wrapped" ? "good" : "neutral"}>{rec.statusLabel}</span></h3>
      <div className={m.grid3}>
        <label className={m.lab}>Date<DateField value={plan.on} disabled={!w.live} onChange={(e) => setPlan({ ...plan, on: e.target.value })} /></label>
        <label className={m.lab}>Call time<input type="time" value={plan.call_time} disabled={!w.live} onChange={(e) => setPlan({ ...plan, call_time: e.target.value })} /></label>
        <label className={m.lab}>Place<input value={plan.place} disabled={!w.live} onChange={(e) => setPlan({ ...plan, place: e.target.value })} placeholder="The site, the sample flat, the studio" /></label>
      </div>
      <div className={m.grid2}>
        <ListEdit label="People (role, name, phone)" items={people} setItems={setPeople} value={one.people} setValue={(x) => setOne({ ...one, people: x })} live={w.live} placeholder="e.g. Presenter · Meera · 98…" />
        <ListEdit label="Needs" items={needs} setItems={setNeeds} value={one.needs} setValue={(x) => setOne({ ...one, needs: x })} live={w.live} placeholder="e.g. Sample flat keys, permission at the gate" />
        <ListEdit label="Shot list" ordered items={shots} setItems={setShots} value={one.shots} setValue={(x) => setOne({ ...one, shots: x })} live={w.live} placeholder="e.g. Wide of the tower at golden hour" />
        <ListEdit label="Equipment" items={kit} setItems={setKit} value={one.kit} setValue={(x) => setOne({ ...one, kit: x })} live={w.live} placeholder="e.g. Gimbal, two lapel mics" />
      </div>
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy} onClick={() => void save()}>Save the plan</button>
        <button type="button" className={styles.btn} disabled={w.busy} onClick={async () => { await save(); await w.act(`steps/${s.id}/actions/callsheet`, {}, "Call sheet written"); }}>Write the call sheet</button></div> : null}
    </section>
    {sheet ? <section className={m.card} aria-label="Call sheet">
      <h3>Call sheet<small>for the crew, the day before</small></h3>
      <pre className={m.sheet}>{sheet}</pre>
      <div className={m.row}><button type="button" className={styles.btn} onClick={() => void copy()}><ClipboardCopy size={14} aria-hidden="true" />Copy</button>
        <button type="button" className={styles.btn} onClick={() => window.print()}><Printer size={14} aria-hidden="true" />Print</button><small className={css.quiet}>Pulse sends nothing to the crew.</small></div>
    </section> : null}
    <section className={m.card} aria-label="Consent and casting">
      <h3>Consent and casting</h3>
      <RecordsInline w={w} type="consent" title="Consent forms" note="Who appears, for which channels, signed when and until when. Signatures come in through a form." />
      <RecordsInline w={w} type="talent" title="Casting" note="The shortlist with a backup for every part, the client's pick, agreements and usage dates." />
    </section>
    {w.live ? <div className={css.finishBar}><span>{plan.on ? `${dayText(plan.on)}${plan.call_time ? `, call ${plan.call_time}` : ""}` : "No date yet"}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !data.on} onClick={() => void w.act(`steps/${s.id}/finish`, { outputs: { slot: { on: plan.on, time: plan.call_time || null, place: plan.place || null, people } } }, "Planned: the shoot is on the run")}><Check size={14} aria-hidden="true" />The shoot is set</button></div>
      : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Set for {dayText(str(data.on))}.</p> : null}
  </div>;
}

/** A collecting step: the records of its type on the run, as cards, with Add. */
export function RecordsBoard({ w }: { w: Work }) {
  const { d } = w, s = d.step, type = collectType(d);
  const t = type ? w.types.find((x) => x.key === type) : null;
  const [adding, setAdding] = useState(false), [table, setTable] = useState(type === "message");
  if (!t) return <div className={css.emptyWork}><b>This step keeps records</b><span>Its record type is not set. Leadership chooses it in the builder.</span></div>;
  const here = w.runRecords.filter((r) => r.type === t.key);
  const mine = here.filter((r) => r.stepKey === s.key), others = here.filter((r) => r.stepKey !== s.key);
  const min = Number(d.settings.min) || 0;
  const editable = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped";
  return <div className={m.stack}>
    <section className={m.card} aria-label={t.plural}>
      <h3>{t.plural}<small>{mine.length} here{min ? ` · at least ${min}` : ""}</small>
        <span className={m.switch} role="group" aria-label="Show as"><button type="button" aria-pressed={!table} onClick={() => setTable(false)}>Cards</button><button type="button" aria-pressed={table} onClick={() => setTable(true)}>Table</button></span>
        {editable && !adding ? <button type="button" className={css.addBtn} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" />Add {t.name.toLowerCase()}</button> : null}</h3>
      <p className={css.quiet}>{t.summary}</p>
      {adding ? <RecordForm w={w} t={t} onDone={() => setAdding(false)} /> : null}
      {mine.length ? table ? <RecordTable w={w} t={t} rows={mine} editable={editable} /> : <ul className={css.recordList}>{mine.map((r) => <li key={r.id}><RecordCard w={w} t={t} r={r} editable={editable} /></li>)}</ul> : !adding ? <p className={css.quiet}>None yet.</p> : null}
    </section>
    {others.length ? <section className={m.card} aria-label={`${t.plural} from other steps`}><h3>From other steps<small>{others.length}</small></h3>
      <ul className={css.recordList}>{others.map((r) => <li key={r.id}><RecordCard w={w} t={t} r={r} editable={editable} /></li>)}</ul></section> : null}
    {w.live ? <div className={css.finishBar}><span>{min && mine.length < min ? `${min - mine.length} more to reach ${min}` : `${mine.length} ${mine.length === 1 ? t.name.toLowerCase() : t.plural.toLowerCase()}`}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || (min > 0 && mine.length < min)} onClick={() => void w.act(`steps/${s.id}/finish`, {}, `Done: the ${t.plural.toLowerCase()} go to the steps that need them`)}><Check size={14} aria-hidden="true" />Done</button></div>
      : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done; the steps after it have the {t.plural.toLowerCase()}.</p> : null}
  </div>;
}
