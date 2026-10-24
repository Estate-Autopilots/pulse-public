"use client";
// FLOW-E: the work screens of App action steps (Settings → Apps lists the apps). Put it in the calendar: a time slot
// becomes an event (a Google Calendar link with the people, and an .ics). The project's Drive folder, and a file from it.
// Send to another app: the run's values posted to the company's address, signed, and the reply kept. Each says what
// Pulse does and what it does not, and where to connect the app when it is not.
import { useEffect, useState } from "react";
import { CalendarCheck, Check, Download, ExternalLink, FileInput, FolderOpen, Webhook } from "lucide-react";
import { styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import type { Work } from "./work";
import { str, strList } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";

const made = (w: Work, kind: string) => w.d.values.find((v) => v.side === "makes" && (v.kind === kind || kind === "any"))?.value as Record<string, unknown> | undefined;
const handed = (w: Work, port: string) => w.d.values.find((v) => v.side === "needs" && v.port === port)?.value as Record<string, unknown> | undefined;

export function CalendarScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, slot = handed(w, "slot"), event = made(w, "slot");
  const [e, setE] = useState({ on: str(slot?.on), time: str(slot?.time) || "11:00", minutes: String(d.settings.minutes ?? 30), place: str(slot?.place), people: strList(slot?.people).join(", ") });
  const ics = str(event?.ics);
  return <div className={m.stack}><section className={m.card} aria-label="The calendar event">
    <h3><CalendarCheck size={15} aria-hidden="true" />The calendar event{event ? <span className={css.chip} data-tone="good">Made</span> : null}<small>Google Calendar and Meet</small></h3>
    {event ? <div className={m.row}>
      <a className={`${styles.btn} ${styles.btnPrimary}`} href={str(event.calendarUrl)} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />Add to Google Calendar</a>
      {ics ? <a className={styles.btn} href={`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`} download="event.ics"><Download size={14} aria-hidden="true" />The .ics file</a> : null}
      <small className={css.quiet}>{str(event.title)} · {str(event.on)} {str(event.time)} ({str(event.zone)})</small></div> : <>
      <div className={m.grid3}>
        <label className={m.lab}>Date<input type="date" value={e.on} disabled={!w.live} onChange={(x) => setE({ ...e, on: x.target.value })} /></label>
        <label className={m.lab}>Time<input type="time" value={e.time} disabled={!w.live} onChange={(x) => setE({ ...e, time: x.target.value })} /></label>
        <label className={m.lab}>Minutes<input type="number" min={5} max={600} value={e.minutes} disabled={!w.live} onChange={(x) => setE({ ...e, minutes: x.target.value })} /></label>
      </div>
      <label className={m.lab}>Place or Meet link<input value={e.place} disabled={!w.live} onChange={(x) => setE({ ...e, place: x.target.value })} placeholder="https://meet.google.com/… or the address" /></label>
      <label className={m.lab}>Guests<input value={e.people} disabled={!w.live} onChange={(x) => setE({ ...e, people: x.target.value })} placeholder="E-mail addresses, separated by commas" /></label>
      {w.live ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !e.on || !e.time}
        onClick={() => void w.act(`steps/${s.id}/actions/event`, { on: e.on, time: e.time, minutes: Number(e.minutes) || 30, place: e.place || undefined, people: e.people.split(",").map((x) => x.trim()).filter(Boolean) }, "The event is made: add it to the calendar")}>
        <Check size={14} aria-hidden="true" />Make the event</button><small className={css.quiet}>Pulse makes the event for you to add; it does not write to calendars or invite anyone itself.</small></div> : null}
    </>}
  </section></div>;
}

export function DriveFolderScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, folder = made(w, "media");
  const [url, setUrl] = useState("");
  return <div className={m.stack}><section className={m.card} aria-label="The project's Drive folder">
    <h3><FolderOpen size={15} aria-hidden="true" />The project&apos;s Drive folder{folder ? <span className={css.chip} data-tone="good">Found</span> : null}<small>Google Drive, read by Pulse</small></h3>
    {folder ? <div className={m.row}><a className={styles.btn} href={str(folder.url)} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />{str(folder.name) || "Open the folder"}</a>
      <small className={css.quiet}>From {str(folder.from) || "the project"}; every later step has it.</small></div> : w.live ? <>
      <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/folder`, {}, "The project's folder is on the run")}>
        <FolderOpen size={14} aria-hidden="true" />Use the project&apos;s folder</button><small className={css.quiet}>The folder Pulse knows for {d.run.name}.</small></div>
      <div className={m.row}><input className={m.grow} value={url} onChange={(x) => setUrl(x.target.value)} placeholder="Or paste a folder link: https://drive.google.com/drive/folders/…" aria-label="Folder link" />
        <button type="button" className={styles.btn} disabled={w.busy || !url} onClick={() => void w.act(`steps/${s.id}/actions/folder`, { url }, "The folder is on the run")}>Use this folder</button></div>
      <small className={css.quiet}>Pulse reads Drive; it does not make folders there.</small></> : null}
  </section></div>;
}

type DriveFile = { id: string; storeId: string; name: string | null; mime: string | null; at: string | null };
export function DriveFileScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, file = made(w, "media");
  const [list, setList] = useState<{ folderId: string | null; files: DriveFile[]; upload: boolean } | null>(null), [err, setErr] = useState<string | null>(null), [q, setQ] = useState(""), [url, setUrl] = useState("");
  useEffect(() => { if (!w.live || file) return; let on = true;
    flow<{ folderId: string | null; files: DriveFile[]; upload: boolean }>(`steps/${s.id}/actions/candidates`, "POST", { q }).then((r) => { if (on) setList(r); }).catch((e) => { if (on) setErr(why(e)); });
    return () => { on = false; }; }, [w.live, file, s.id, q]);
  return <div className={m.stack}><section className={m.card} aria-label="A file from Drive">
    <h3><FileInput size={15} aria-hidden="true" />A file from Drive{file ? <span className={css.chip} data-tone="good">Picked</span> : null}<small>Google Drive</small></h3>
    {file ? <div className={m.row}><a className={styles.btn} href={str(file.url)} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />{str(file.name) || "Open the file"}</a></div>
      : !w.live ? null : <>
      <input className={m.grow} value={q} onChange={(x) => setQ(x.target.value)} placeholder="Search the folder by name" aria-label="Search files" />
      {err ? <p className={css.quiet}>{err}</p> : !list ? <p className={css.quiet}>Reading the folder…</p> : !list.files.length
        ? <p className={css.quiet}>{list.folderId ? "No file in the project's folder matches yet." : "This project has no Drive folder Pulse knows: search by name, or paste the file's link."}</p>
        : <ul className={m.submissions}>{list.files.map((f) => <li key={f.id}><span><b>{f.name ?? "A file"}</b><small>{f.mime ?? ""}</small></span>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/pick`, { fileId: f.id }, "File picked: later steps have it")}>Use this</button></li>)}</ul>}
      <div className={m.row}><input className={m.grow} value={url} onChange={(x) => setUrl(x.target.value)} placeholder="Or paste the file's link" aria-label="File link" />
        <button type="button" className={styles.btn} disabled={w.busy || !/^https:\/\//.test(url)} onClick={() => void w.act(`steps/${s.id}/actions/pick`, { url, name: "Linked file" }, "File linked")}>Use this link</button></div>
      <small className={css.quiet}>{list?.upload ? "Uploading into the project's folder is on: use the project's Upload, then pick it here." : "Pulse reads the project's folder; uploading into Drive from Pulse is off here."}</small></>}
  </section></div>;
}

export function WebhookScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, reply = made(w, "any");
  return <div className={m.stack}><section className={m.card} aria-label="Send to another app">
    <h3><Webhook size={15} aria-hidden="true" />Send to another app{reply ? <span className={css.chip} data-tone="good">Sent</span> : null}<small>a signed post with the run&apos;s values</small></h3>
    {reply ? <><p className={css.quiet}>It answered {String(reply.status ?? "")} from {str(reply.to)}.</p>
      <pre className={m.message} style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body, null, 2)}</pre></>
      : w.live ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/send`, {}, "Sent: the app's reply is on the run")}>
        <Webhook size={14} aria-hidden="true" />Send now</button><small className={css.quiet}>To {str(d.settings.url) || "the company's address (Settings → Apps)"}, signed with the company&apos;s secret.</small></div> : null}
  </section></div>;
}
