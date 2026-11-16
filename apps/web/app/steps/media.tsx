"use client";
// FLOW-C: the Media review screen (Review · a cut or photos), also where files and cuts are handed in. The player (a
// Drive or YouTube link plays in place, a video file link plays here, a file on this computer plays without leaving it)
// or the photo grid of a field visit (each photo with the time it was taken and where, from the phone's camera), comments
// at a moment of the cut, the change list with who makes each change and by when, the versions, and Freeze.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock3, ExternalLink, Film, Image as ImageIcon, MapPin, Snowflake, Upload } from "lucide-react";
import { styles } from "../ui";
import { peopleOf } from "./records";
import type { Work } from "./work";
import { dayText, needValues, str, timeText, type FlowComment } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";

type Version = { url: string; note?: string | null; at?: string; by?: string };
type Photo = { id: string; field: string; name: string; capturedAt: string | null; lat: number | null; lng: number | null; accuracy: number | null };

/** How a link plays: inside a frame (Drive, YouTube), as a video, as a picture, or only by opening it. */
export function playable(url: string, image = false): { kind: "frame" | "video" | "image" | "link"; src: string } {
  const drive = /drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]{10,})/.exec(url);
  if (drive) return { kind: "frame", src: `https://drive.google.com/file/d/${drive[1]}/preview` };
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/.exec(url);
  if (yt) return { kind: "frame", src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  // Pictures show from Pulse itself or this computer; a picture elsewhere opens beside the page.
  if (image || /^\/api\/v0\//.test(url)) return { kind: "image", src: url };
  if (/^blob:|\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return { kind: "video", src: url };
  return { kind: "link", src: url };
}
const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const seconds = (at: string | null) => { const p = (at ?? "").split(":").map(Number); return p.length === 2 && p.every(Number.isFinite) ? p[0] * 60 + p[1] : null; };

export function MediaScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null, mod = s.module;
  const versions = (Array.isArray(rec?.data.versions) ? rec!.data.versions : []) as Version[];
  // What it was handed: a field visit's photos (a sent form), or another step's cut.
  const subs = needValues(d).filter((v) => typeof v.value?.submissionId === "string").map((v) => v.value as { submissionId: string; form?: string; location?: { lat: number; lng: number; accuracy?: number | null } | null });
  const handedCuts = useMemo(() => w.runRecords.filter((r) => r.type === "media_set" && r.id !== rec?.id && needValues(d).some((v) => v.value?.recordId === r.id)), [w.runRecords, rec?.id, d]);
  const allVersions = [...handedCuts.flatMap((r) => ((Array.isArray(r.data.versions) ? r.data.versions : []) as Version[]).map((v, i) => ({ ...v, label: `${r.title} · V${i + 1}` }))),
    ...versions.map((v, i) => ({ ...v, label: `V${i + 1}` }))];
  const [pick, setPick] = useState(allVersions.length - 1);
  const [local, setLocal] = useState<string | null>(null), [localImage, setLocalImage] = useState(false);
  const current = local ? { url: local, label: "File on this computer" } : allVersions[pick] ?? null;
  const play = current ? playable(current.url, !!local && localImage) : null;
  const video = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState(""), [text, setText] = useState(""), [change, setChange] = useState(true), [owner, setOwner] = useState(""), [due, setDue] = useState("");
  const [url, setUrl] = useState(""), [vnote, setVnote] = useState("");
  const comments = (w.rec?.comments ?? []) as FlowComment[];
  const changes = comments.filter((c) => c.kind === "change"), notes = comments.filter((c) => c.kind === "comment");
  const people = peopleOf(w);
  const frozen = !!rec?.frozenAt, live = w.live && !frozen;
  useEffect(() => () => { if (local) URL.revokeObjectURL(local); }, [local]);
  if (!rec && !subs.length) return <div className={css.emptyWork}><Film size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The review opens when the cut or photos are in" : "Nothing to review yet"}</b><span>{s.state === "waiting" ? s.stateText : "Its person adds the first version."}</span></div>;
  const stamp = () => { if (video.current) setAt(clock(video.current.currentTime)); };
  async function comment() {
    if (!rec || !text.trim()) return;
    const body = { at: at || undefined, text: text.trim(), change, ownerId: change && owner ? owner : undefined, due: change && due ? due : undefined, version: current?.label };
    const ok = mod === "media_review" ? await w.act(`steps/${s.id}/actions/comment`, body, change ? "Added to the change list" : "Comment added")
      : await w.act(`records/${rec.id}/comments`, { body: body.text, section: body.version, anchor: body.at, kind: change ? "change" : "comment", ownerId: body.ownerId, dueOn: body.due }, change ? "Added to the change list" : "Comment added");
    if (ok) { setText(""); setAt(""); }
  }
  const seek = (a: string | null) => { const t = seconds(a); if (t !== null && video.current) { video.current.currentTime = t; void video.current.play().catch(() => undefined); } };

  return <div className={m.stack}>
    {subs.map((sub) => <PhotoSet key={sub.submissionId} id={sub.submissionId} form={sub.form ?? "Field visit"} place={sub.location ?? null} />)}

    {rec ? <section className={m.card} aria-label="Player">
      <h3><Film size={15} aria-hidden="true" />{current ? current.label : "No version yet"}{frozen ? <span className={css.chip} data-tone="good"><Snowflake size={11} aria-hidden="true" /> Final · frozen</span> : rec.statusLabel ? <span className={css.chip}>{rec.statusLabel}</span> : null}</h3>
      {play?.kind === "frame" ? <div className={m.player}><iframe src={play.src} title={current!.label} allow="autoplay; fullscreen" allowFullScreen referrerPolicy="no-referrer" /></div>
        : play?.kind === "video" ? <div className={m.player}><video ref={video} src={play.src} controls playsInline preload="metadata" /></div>
        : play?.kind === "image" ? <div className={m.player}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a stored photo or a file on this computer, shown as it is */}
          <img src={play.src} alt={current!.label} /></div>
        : play ? <p className={m.linkOnly}><a href={play.src} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open {current!.label}</a><small>This link does not play inside Pulse (Frame.io, a folder): open it beside this page.</small></p>
        : <p className={css.quiet}>Add the first version below: a Drive or YouTube link, or a video file link.</p>}
      <div className={m.row}>
        {allVersions.length > 1 || local ? <SelectField aria-label="Version" value={local ? "local" : String(pick)} onChange={(e) => { if (e.target.value === "local") return; setLocal(null); setPick(Number(e.target.value)); }}>
          {allVersions.map((v, i) => <option key={i} value={i}>{v.label}{v.at ? ` · ${dayText(v.at)}` : ""}</option>)}{local ? <option value="local">File on this computer</option> : null}</SelectField> : null}
        <label className={styles.btn}><Upload size={14} aria-hidden="true" />Watch a file from this computer<input type="file" accept="video/*,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { if (local) URL.revokeObjectURL(local); setLocalImage(f.type.startsWith("image/")); setLocal(URL.createObjectURL(f)); } }} /></label>
        {current && play?.kind !== "link" ? <a className={css.linkBtn} href={current.url.startsWith("blob:") ? undefined : current.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden="true" />Open it</a> : null}
      </div>
    </section> : null}

    {rec ? <section className={m.card} aria-label="Comment">
      <h3>{change ? "Add a change" : "Add a comment"}<small>at a moment of {current?.label ?? "the cut"}</small></h3>
      {live || (w.d.canAct && !frozen) ? <form className={m.commentForm} onSubmit={(e) => { e.preventDefault(); void comment(); }}>
        <div className={m.row}>
          <span className={m.at}><Clock3 size={13} aria-hidden="true" /><input value={at} onChange={(e) => setAt(e.target.value)} placeholder="00:00" aria-label="At (minutes:seconds)" maxLength={8} /></span>
          {play?.kind === "video" ? <button type="button" className={styles.btn} onClick={stamp}>Now</button> : null}
          <span className={m.switch} role="group" aria-label="Kind"><button type="button" aria-pressed={change} onClick={() => setChange(true)}>A change</button><button type="button" aria-pressed={!change} onClick={() => setChange(false)}>A comment</button></span>
        </div>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={change ? "What has to change (e.g. cut the second shot by a second; the price card is the old one)" : "What you think"} aria-label="The comment" maxLength={4000} />
        <div className={m.row}>
          {change ? <><SelectField value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Who makes it"><option value="">Who makes it</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField>
            <DateField value={due} onChange={(e) => setDue(e.target.value)} aria-label="By when" /></> : null}
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !text.trim()}>{change ? "Add to the change list" : "Comment"}</button>
        </div>
      </form> : <p className={css.quiet}>{frozen ? "Frozen: the final version does not change." : "Its person and the run's people comment here."}</p>}
    </section> : null}

    {rec ? <section className={m.card} aria-label="Change list">
      <h3>Change list<small>{changes.filter((c) => !c.resolvedAt).length} open · {changes.filter((c) => c.resolvedAt).length} done</small></h3>
      {changes.length ? <ul className={m.changes}>{changes.map((c) => <li key={c.id} data-done={c.resolvedAt ? "" : undefined}>
        <button type="button" className={m.atBtn} disabled={!c.anchor} onClick={() => seek(c.anchor)}>{c.anchor ?? "—"}</button>
        <span><b>{c.body}</b><small>{c.owner ? `${c.owner}` : "Nobody named"}{c.dueOn ? ` · by ${dayText(c.dueOn)}` : ""}{c.section ? ` · ${c.section}` : ""} · {c.by ?? "Someone"}</small></span>
        {w.d.canAct ? <button type="button" className={css.linkBtn} disabled={w.busy} onClick={() => void w.act(`comments/${c.id}/resolve`, { resolved: !c.resolvedAt }, c.resolvedAt ? "Opened again" : "Done")}>{c.resolvedAt ? "Open again" : <><Check size={12} aria-hidden="true" />Done</>}</button> : null}
      </li>)}</ul> : <p className={css.quiet}>No changes asked for.</p>}
      {notes.length ? <><h3>Comments</h3><ul className={m.changes}>{notes.map((c) => <li key={c.id}><button type="button" className={m.atBtn} disabled={!c.anchor} onClick={() => seek(c.anchor)}>{c.anchor ?? "—"}</button>
        <span><b>{c.body}</b><small>{c.by ?? "Someone"} · {timeText(c.at)}</small></span></li>)}</ul></> : null}
    </section> : null}

    {rec ? <section className={m.card} aria-label="Versions">
      <h3>Versions<small>{versions.length}</small></h3>
      {versions.length ? <ol className={m.versionList}>{versions.map((v, i) => <li key={i}><b>V{i + 1}</b><a href={v.url} target="_blank" rel="noopener noreferrer">{v.url.replace(/^https:\/\//, "").slice(0, 60)}</a><small>{v.note ? `${v.note} · ` : ""}{timeText(v.at)}</small></li>)}</ol> : null}
      {live ? <form className={m.row} onSubmit={(e) => { e.preventDefault(); void w.act(`steps/${s.id}/actions/version`, { url, note: vnote || undefined }, `Version ${versions.length + 1} added`).then((ok) => { if (ok) { setUrl(""); setVnote(""); setPick(allVersions.length); } }); }}>
        <input className={m.grow} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// link to the new cut or the photo folder" aria-label="Link to the new version" />
        <input value={vnote} onChange={(e) => setVnote(e.target.value)} placeholder="What changed" aria-label="What changed" />
        <button type="submit" className={styles.btn} disabled={w.busy || !/^https:\/\//.test(url)}>Add version</button>
      </form> : null}
    </section> : null}

    {w.live && rec ? <div className={css.finishBar}><span>{changes.filter((c) => !c.resolvedAt).length ? `${changes.filter((c) => !c.resolvedAt).length} change${changes.filter((c) => !c.resolvedAt).length === 1 ? "" : "s"} still open` : versions.length ? `V${versions.length} is the latest` : "No version yet"}</span>
      {mod === "media_review" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || frozen || !versions.length} onClick={() => void w.act(`steps/${s.id}/actions/freeze`, {}, "Frozen: the final goes to the steps that need it")}><Snowflake size={14} aria-hidden="true" />Freeze the final</button>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !versions.length} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Handed in: the steps that need it open")}><Check size={14} aria-hidden="true" />Hand it in</button>}
    </div> : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done; the steps that needed it have it.</p> : null}
  </div>;
}

/** A field visit's photos: each with the time the camera took it and where the phone was. */
function PhotoSet({ id, form, place }: { id: string; form: string; place: { lat: number; lng: number; accuracy?: number | null } | null }) {
  const [files, setFiles] = useState<Photo[] | null>(null), [error, setError] = useState<string | null>(null), [big, setBig] = useState<Photo | null>(null);
  useEffect(() => { let on = true;
    fetch(`/api/v0/forms/submissions/${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "This visit's form is not there any more." : "The photos did not load.")))
      .then((x: { files: Photo[] }) => { if (on) setFiles(x.files ?? []); }).catch((e: Error) => { if (on) setError(e.message); });
    return () => { on = false; }; }, [id]);
  return <section className={m.card} aria-label={form}>
    <h3><ImageIcon size={15} aria-hidden="true" />{form}<small>{files ? `${files.length} photo${files.length === 1 ? "" : "s"}` : ""}{place ? ` · sent from ${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}` : ""}</small></h3>
    {error ? <p className={css.quiet}>{error}</p> : !files ? <p className={css.quiet}>Loading the photos…</p> : !files.length ? <p className={css.quiet}>No photos on this visit.</p>
      : <ul className={m.photos}>{files.map((f) => <li key={f.id}><button type="button" onClick={() => setBig(big?.id === f.id ? null : f)} aria-label={`${f.name}, taken ${timeText(f.capturedAt)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a field photo served by Pulse */}
        <img src={`/api/v0/forms/files/${f.id}`} alt="" loading="lazy" /></button>
        <small><Clock3 size={11} aria-hidden="true" />{f.capturedAt ? timeText(f.capturedAt) : "time not known"}</small>
        <small><MapPin size={11} aria-hidden="true" />{f.lat !== null && f.lng !== null ? <a href={`https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lng}#map=18/${f.lat}/${f.lng}`} target="_blank" rel="noopener noreferrer">{f.lat.toFixed(5)}, {f.lng.toFixed(5)}{f.accuracy ? ` ±${Math.round(f.accuracy)} m` : ""}</a> : "no place"}</small></li>)}</ul>}
    {big ? <div className={m.photoBig}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a field photo served by Pulse */}
      <img src={`/api/v0/forms/files/${big.id}`} alt={big.name} /><button type="button" className={styles.btn} onClick={() => setBig(null)}>Close</button></div> : null}
  </section>;
}
