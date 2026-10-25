"use client";
// FLOW-C: the Meeting screen (Meet): any call, meeting or interview. When and who (with the call link), the recording
// and the transcript (pasted, or a transcript file from the laptop recorder or Wispr read in the browser), the moments
// tagged in it, Pip's summary and follow-ups (kept as open items the person chooses), and the client's score. Pulse does
// not record or transcribe audio itself: the person brings the text. Done when the transcript or the notes are in.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, ExternalLink, FileUp, ScanSearch, Sparkles, Tag, Video } from "lucide-react";
import type { Call, CallDetail, CallPage, Status } from "../apps/sales-xray/types";
import { Rating } from "../kit";
import { styles } from "../ui";
import { RecordsInline, peopleOf } from "./records";
import type { Work } from "./work";
import { dayText, needValues, str, strList, timeText, todayIso } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";

type Moment = { tag: string; line: string };

export function MeetingScreen({ w }: { w: Work }) {
  const { d } = w, rec = w.rec?.record ?? null, s = d.step;
  const data = (rec?.data ?? {}) as Record<string, unknown>;
  const slot = needValues(d).find((v) => v.kind === "slot")?.value ?? null;
  // A role named in the step's settings reads as the person holding it on this run (or the role's name).
  const named = (x: string) => { const p = d.run.people[x]; return p && "name" in p ? p.name : d.run.roles.find((r) => r.key === x)?.label ?? x; };
  const [when, setWhen] = useState({ at: str(data.at) || str(slot?.on), time: str(data.time) || str(slot?.time), place: str(data.place) || str(slot?.place), people: (strList(data.people).length ? strList(data.people) : strList(slot?.people)).map(named) });
  const [person, setPerson] = useState("");
  const [recording, setRecording] = useState(str(data.recording_url));
  const [transcript, setTranscript] = useState(str(data.transcript));
  const [editing, setEditing] = useState(!str(data.transcript));
  // The summary follows what Pip last wrote until the person changes it.
  const [summaryEdit, setSummaryEdit] = useState<string | null>(null);
  const summary = summaryEdit ?? str(data.summary);
  const [keep, setKeep] = useState<string[]>([]);
  const [moment, setMoment] = useState<Moment>({ tag: "", line: "" });
  const tags = (Array.isArray(data.tags) ? data.tags : []) as Moment[];
  const followups = strList(data.followups);
  const tagWords = [...new Set([...strList(d.settings.tags), ...tags.map((t) => t.tag)])];
  const score = (data.score ?? null) as { info?: number | null; behaviour?: number | null; note?: string | null } | null;
  const [info, setInfo] = useState<number | null>(score?.info ?? null), [behaviour, setBehaviour] = useState<number | null>(score?.behaviour ?? null), [scoreNote, setScoreNote] = useState(str(score?.note));
  const wantsScore = d.settings.score === true || s.module === "transcribe" || !!score;
  const kept = w.runRecords.filter((r) => r.type === "open_item" && r.stepKey === s.key).map((r) => str(r.data.question) || r.title);
  const people = peopleOf(w);
  if (!rec) return <div className={css.emptyWork}><Video size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The meeting opens when the step does" : "No meeting here yet"}</b><span>{s.state === "waiting" ? s.stateText : "Its person opens it."}</span></div>;
  const link = /^https:\/\//.test(when.place) ? when.place : null;

  async function readFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 2_000_000) { setTranscript("That file is over 2 MB. Paste the transcript's text instead."); return; }
    const raw = await f.text();
    // Subtitles (.vtt/.srt): keep the spoken lines, drop the numbering and the timings.
    const clean = /\.(vtt|srt)$/i.test(f.name) ? raw.split(/\r?\n/).filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join("\n") : raw;
    setTranscript(clean); setEditing(true);
  }
  const saveWhen = () => w.act(`records/${rec.id}`, { data: { at: when.at || null, time: when.time || null, place: when.place || null, people: when.people } }, "Saved: when and who");

  return <div className={m.stack}>
    <section className={m.card} aria-label="When and who">
      <h3><Video size={15} aria-hidden="true" />When and who{rec.statusLabel ? <span className={css.chip} data-tone={rec.status === "summarised" || rec.status === "transcribed" ? "good" : "neutral"}>{rec.statusLabel}</span> : null}</h3>
      <div className={m.grid3}>
        <label className={m.lab}>Date<input type="date" value={when.at} disabled={!w.live} onChange={(e) => setWhen({ ...when, at: e.target.value })} /></label>
        <label className={m.lab}>Time<input type="time" value={when.time} disabled={!w.live} onChange={(e) => setWhen({ ...when, time: e.target.value })} /></label>
        <label className={m.lab} data-wide="">Call link or place<input type="text" value={when.place} disabled={!w.live} placeholder="https://meet.google.com/… or the office" onChange={(e) => setWhen({ ...when, place: e.target.value })} /></label>
      </div>
      <div className={m.chips} aria-label="People">{when.people.map((p) => <span key={p} className={m.person}>{p}{w.live ? <button type="button" aria-label={`Remove ${p}`} onClick={() => setWhen({ ...when, people: when.people.filter((x) => x !== p) })}>×</button> : null}</span>)}
        {w.live ? <form className={m.addPerson} onSubmit={(e) => { e.preventDefault(); if (person.trim() && !when.people.includes(person.trim())) setWhen({ ...when, people: [...when.people, person.trim()] }); setPerson(""); }}>
          <input list={`people-${s.id}`} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Add someone" aria-label="Add someone" />
          <datalist id={`people-${s.id}`}>{people.map((p) => <option key={p.id} value={p.name} />)}</datalist></form> : null}
        {!when.people.length && !w.live ? <span className={css.quiet}>Nobody listed</span> : null}</div>
      <div className={m.row}>
        {link ? <a className={styles.btn} href={link} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Join the call</a> : null}
        {when.at ? <small className={css.quiet}>{dayText(when.at)}{when.time ? ` at ${when.time}` : ""}</small> : null}
        {w.live ? <button type="button" className={styles.btn} disabled={w.busy} onClick={() => void saveWhen()}>Save</button> : null}
      </div>
    </section>

    {s.module === "sales_xray" && w.live ? <SalesXrayPick w={w} /> : null}

    <section className={m.card} aria-label="Recording and transcript">
      <h3><FileUp size={15} aria-hidden="true" />Recording and transcript{data.transcript ? <small>{str(data.transcript).trim().split(/\s+/).length} words</small> : null}</h3>
      <label className={m.lab}>Recording link<input type="url" value={recording} disabled={!w.live} placeholder="https://drive.google.com/… (the recording where the team keeps it)" onChange={(e) => setRecording(e.target.value)} /></label>
      {editing && w.live ? <>
        <textarea className={m.transcript} rows={10} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Paste the transcript (from the laptop recording, Wispr or the call's notes)" aria-label="Transcript" maxLength={200000} />
        <div className={m.row}>
          <label className={styles.btn}><FileUp size={14} aria-hidden="true" />Upload a transcript file<input type="file" accept=".txt,.vtt,.srt,.md,text/plain" hidden onChange={(e) => void readFile(e.target.files?.[0])} /></label>
          <small className={css.quiet}>.txt, .vtt or .srt; read here, nothing else is uploaded</small>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || (!transcript.trim() && !/^https:\/\//.test(recording))}
            onClick={async () => { if (await w.act(`steps/${s.id}/actions/transcript`, { transcript, recordingUrl: recording || undefined }, "Transcript saved")) setEditing(false); }}>Save the transcript</button>
        </div>
      </> : <>
        {recording ? <a className={m.link} href={recording} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} aria-hidden="true" />The recording</a> : null}
        {data.transcript ? <div className={m.transcriptRead}>{str(data.transcript).split(/\n+/).slice(0, 400).map((l, i) => <p key={i}>{l}</p>)}</div> : <p className={css.quiet}>No transcript yet.</p>}
        {w.live ? <button type="button" className={css.linkBtn} onClick={() => setEditing(true)}>Change the transcript</button> : null}
      </>}
    </section>

    <section className={m.card} aria-label="Summary and follow-ups">
      <h3><Sparkles size={15} aria-hidden="true" />Summary and follow-ups<small>Pip writes them from the transcript; you keep what is right</small></h3>
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy || !str(data.transcript).trim()} onClick={() => void w.act(`steps/${s.id}/actions/summarise`, {}, "Pip summarised it")}>
        <Sparkles size={14} aria-hidden="true" />{data.summary ? "Summarise again" : "Summarise with Pip"}</button>{!str(data.transcript).trim() ? <small className={css.quiet}>Save the transcript first</small> : null}</div> : null}
      {data.summary || w.live ? <label className={m.lab}>Summary<textarea rows={5} value={summary} disabled={!w.live} onChange={(e) => setSummaryEdit(e.target.value)}
        onBlur={() => { if (summaryEdit !== null && summaryEdit !== str(data.summary)) void w.act(`records/${rec.id}`, { data: { summary: summaryEdit } }, "Summary saved").then((ok) => { if (ok) setSummaryEdit(null); }); }} /></label> : null}
      {followups.length ? <div className={m.followups}>
        <b>Follow-ups</b>
        <ul>{followups.map((f) => { const has = kept.includes(f);
          return <li key={f}><label><input type="checkbox" disabled={!w.live || has} checked={has || keep.includes(f)} onChange={(e) => setKeep(e.target.checked ? [...keep, f] : keep.filter((x) => x !== f))} />{f}{has ? <small> · kept</small> : null}</label></li>; })}</ul>
        {w.live && keep.length ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={async () => {
          for (const f of keep) await w.act("records", { type: "open_item", runId: d.run.id, stepKey: s.key, data: { question: f, tag: /conflict/i.test(f) ? "CONFLICT" : /pending/i.test(f) ? "PENDING" : "FOLLOW-UP" } }, null);
          setKeep([]); }}>Keep {keep.length} as open item{keep.length > 1 ? "s" : ""}</button> : null}
      </div> : null}
      <RecordsInline w={w} type="open_item" title="Open items" compact />
    </section>

    <section className={m.card} aria-label="Tagged moments">
      <h3><Tag size={15} aria-hidden="true" />Tagged moments<small>{tags.length || "none yet"}</small></h3>
      {tagWords.length ? <div className={m.chips}>{tagWords.map((t) => <span key={t} className={m.tagChip}>{t}<small>{tags.filter((x) => x.tag === t).length}</small></span>)}</div> : null}
      {tags.length ? <ul className={m.moments}>{tags.map((t, i) => <li key={i}><b>{t.tag}</b><span>{t.line}</span></li>)}</ul> : null}
      {w.live ? <form className={m.row} onSubmit={(e) => { e.preventDefault(); if (!moment.tag.trim() || !moment.line.trim()) return;
        void w.act(`records/${rec.id}`, { data: { tags: [...tags, { tag: moment.tag.trim().toUpperCase(), line: moment.line.trim() }] } }, "Tagged").then((ok) => { if (ok) setMoment({ tag: moment.tag, line: "" }); }); }}>
        <input className={m.tagInput} list={`tags-${s.id}`} value={moment.tag} onChange={(e) => setMoment({ ...moment, tag: e.target.value })} placeholder="Tag" aria-label="Tag" />
        <datalist id={`tags-${s.id}`}>{tagWords.map((t) => <option key={t} value={t} />)}</datalist>
        <input className={m.grow} value={moment.line} onChange={(e) => setMoment({ ...moment, line: e.target.value })} placeholder="The line or moment (paste it from the transcript)" aria-label="The moment" />
        <button type="submit" className={styles.btn} disabled={w.busy || !moment.tag.trim() || !moment.line.trim()}>Tag it</button>
      </form> : null}
    </section>

    {wantsScore ? <section className={m.card} aria-label="Client score">
      <h3>Score after the meeting{score?.info || score?.behaviour ? <small>Scored {dayText(str((score as Record<string, unknown>).on)) || ""}</small> : null}</h3>
      <div className={m.grid2}>
        <div className={m.lab}>Quality of the information<Rating value={info} onChange={w.live ? setInfo : undefined} readOnly={!w.live} label="Quality of the information" words={["Poor", "Thin", "Fair", "Good", "Complete"]} /></div>
        <div className={m.lab}>How they worked with us<Rating value={behaviour} onChange={w.live ? setBehaviour : undefined} readOnly={!w.live} label="How they worked with us" words={["Hard", "Slow", "Fair", "Good", "Great"]} /></div>
      </div>
      <label className={m.lab}>Note<input value={scoreNote} disabled={!w.live} onChange={(e) => setScoreNote(e.target.value)} placeholder="What stood out" /></label>
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy || !info || !behaviour} onClick={() => void w.act(`steps/${s.id}/actions/score`, { info, behaviour, note: scoreNote || undefined }, "Scored")}>Save the score</button></div> : null}
    </section> : null}

    {w.live ? <div className={css.finishBar}>
      <span>{data.transcript ? `Transcript in · ${timeText(rec.updatedAt)}` : "Done when the transcript or the notes are in"}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || (!str(data.transcript).trim() && !str(data.recording_url))} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Done: the transcript goes to the steps that need it")}><Check size={14} aria-hidden="true" />Done</button>
    </div> : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done {dayText(s.doneAt) || todayIso()}; the steps that needed the transcript have it.</p> : null}
  </div>;
}

/** A Sales X-Ray call step: the person picks one of their own analysed calls (read live from Sales X-Ray as them); its
 *  summary, the items asked for, objections, promises and score go on the step's own ports and the step is done. */
function SalesXrayPick({ w }: { w: Work }) {
  const [status, setStatus] = useState<Status | null>(null), [calls, setCalls] = useState<Call[] | null>(null), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let on = true;
    const get = (p: string) => fetch(`/api/v0/sales-xray/${p}`, { cache: "no-store" }).then(async (r) => { const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error((x as { error?: string }).error ?? "Sales X-Ray did not answer."); return x; });
    get("status").then((x: Status) => { if (!on) return; setStatus(x); if (x.connected) return get("calls").then((p: CallPage) => { if (on) setCalls(p.calls ?? []); }); })
      .catch((e: Error) => { if (on) setErr(e.message); });
    return () => { on = false; }; }, []);
  async function pick(c: Call) {
    setBusy(c.id);
    try {
      const r = await fetch(`/api/v0/sales-xray/calls/${encodeURIComponent(c.id)}`, { cache: "no-store" }); if (!r.ok) throw new Error("That call did not open.");
      const d = await r.json() as CallDetail; const facts = d.facts ?? [];
      const line = (f: NonNullable<CallDetail["facts"]>[number]) => `${f.label ?? f.category ?? ""}${f.display ?? (typeof f.value === "string" || typeof f.value === "number" ? `: ${f.value}` : "")}`.trim();
      const of = (re: RegExp) => facts.filter((f) => re.test(`${f.category ?? ""} ${f.label ?? ""}`)).map(line).filter(Boolean);
      const score = facts.find((f) => /score/i.test(`${f.label ?? ""} ${f.category ?? ""}`));
      await w.act(`steps/${w.d.step.id}/actions/pick`, { callId: c.id, url: c.open_url ?? undefined, summary: [c.title, ...facts.slice(0, 12).map(line)].filter(Boolean).join("\n"),
        items: of(/item|ask|need|requirement|config/i), objections: of(/objection|concern/i), promises: of(/promise|commit|follow/i), score: typeof score?.value === "number" ? score.value : score?.display ?? null }, "Call used: its summary and items go on");
    } catch (e) { setErr(e instanceof Error ? e.message : "That did not work."); } finally { setBusy(null); }
  }
  return <section className={m.card} aria-label="The call in Sales X-Ray">
    <h3><ScanSearch size={15} aria-hidden="true" />The call in Sales X-Ray<small>your own calls, read as you; nothing is kept until you pick one</small></h3>
    {err ? <p className={css.quiet}>{err}</p> : !status ? <p className={css.quiet}>Asking Sales X-Ray…</p>
      : !status.configured ? <p className={css.quiet}>Sales X-Ray is not set up for this company. Type the call&apos;s analysis below.</p>
      : !status.connected ? <div className={m.row}><Link className={styles.btn} href="/apps/sales-xray"><ExternalLink size={14} aria-hidden="true" />Connect Sales X-Ray</Link><small className={css.quiet}>Then come back and pick the call.</small></div>
      : !calls ? <p className={css.quiet}>Loading your calls…</p> : !calls.length ? <p className={css.quiet}>No calls in Sales X-Ray yet.</p>
      : <ul className={m.submissions}>{calls.slice(0, 15).map((c) => <li key={c.id}><span><b>{c.title ?? "A call"}</b><small>{c.created_at ? timeText(c.created_at) : ""}{c.duration_seconds ? ` · ${Math.round(c.duration_seconds / 60)} min` : ""}{c.has_report === false ? " · no analysis yet" : ""}</small></span>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy || w.busy || c.has_report === false} onClick={() => void pick(c)}>{busy === c.id ? "Reading…" : "Use this call"}</button></li>)}</ul>}
  </section>;
}
