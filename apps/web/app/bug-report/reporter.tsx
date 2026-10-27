"use client";
// BUG-REPORT (owner, 27 Oct 2026: "a Report a bug in Pulse, Ctrl+B on desktop and web, shake in the mobile app; copy
// Sales X-Ray's and make it far better"). Mounted once in the app frame for a signed-in person.
//   Opens on: Ctrl+B / ⌘B (Ctrl+Shift+B inside a text editor, where Ctrl+B is bold), a deliberate shake in the phone
//   app, the account menu's "Report a bug", the command palette, and an error screen's "Report this".
//   Write: what went wrong (a draft survives closing), "This stops my work".
//   What goes with it, each shown and removable before sending: a picture of the screen taken on the device as the
//   reporter opens (typed values are dots, private areas grey; draw on it or blur more), an optional screen recording
//   (up to 30 s, computers), recent errors, failed network calls (paths and statuses only), recent app steps (from
//   telemetry) and the screen, app version and device. Who sent it and from which company the API knows from sign-in.
//   Signed out (sign-in, team setup, password, invitation and error pages): the same, plus an optional name and e-mail
//   or phone; no recording, a smaller picture, sent to /api/v0/auth/bug-report.
//   Sent: the report's number, "We'll tell you when it's fixed"; Your reports: what they sent and where each stands.
// The picture and the lists are taken when the reporter opens, so the reporter itself is never in them.
import { Bug, Camera, CheckCircle2, ChevronDown, Circle, ImagePlus, ListChecks, PenLine, Smartphone, Square, TriangleAlert, Video, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, Switch } from "../kit";
import { STATUS_WORDS, shakeDetector, shortcutLabel } from "../lib/bug-report.mjs";
import { haptic, shell } from "../lib/native-shell";
import { recentSteps, telemetryEvent } from "../lib/telemetry.mjs";
import { Badge, styles as ui } from "../ui";
import styles from "./bug-report.module.css";
import { captureScreen } from "./capture";
import { reportContext } from "./device";
import { MarkupEditor } from "./markup";
import { installReportShortcut, isMac, REPORT_BUG_EVENT, openBugReport, type ReportAbout } from "./open";
import { installRecorder, recentCalls, recentErrors, type FailedCall, type RecentError } from "./recorder";
import { canRecord, MAX_SECONDS, startRecording, type Clip, type Recorder } from "./recording";

type Step = ReturnType<typeof recentSteps>[number];
type Picture = { state: "none" } | { state: "taking" } | { state: "failed" } | { state: "ready"; blob: Blob; url: string; marked: boolean; source: "auto" | "upload" };
type View = "write" | "markup" | "sent" | "mine";
type Mine = { id: string; number: number; words: string; route: string; status: string; statusAt: string; createdAt: string; duplicateNumber: number | null };
type Snapshot = { errors: readonly RecentError[]; calls: readonly FailedCall[]; steps: Step[]; where: ReturnType<typeof reportContext> };
type Include = { screenshot: boolean; recording: boolean; errors: boolean; calls: boolean; steps: boolean; device: boolean };
const ALL: Include = { screenshot: true, recording: true, errors: true, calls: true, steps: true, device: true };
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PICTURE = 4 * 1024 * 1024;
// Signed out: a smaller picture (the API refuses a larger one) and no recording.
const SIGNED_OUT_PICTURE = 1536 * 1024;
const SHAKE_KEY = "pulse-shake-to-report";
const SEEN_KEY = "pulse-bug-reports-seen";
const LOOKED_KEY = "pulse-bug-reports-looked";

// What was typed stays for the next opening until it is sent.
const draft = { words: "", blocksWork: false };
const commandId = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); };
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result ?? "")); r.onerror = () => reject(new Error("unreadable")); r.readAsDataURL(blob); });
const store = { get: (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } } };
const when = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? "" : t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };
const timeOf = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? "" : t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

/** One thing that goes with the report: its name, a count, a switch to leave it out, and what exactly goes, behind a toggle. */
function Attachment({ icon, title, note, on, onChange, children }: { icon: ReactNode; title: string; note: string; on: boolean; onChange: (on: boolean) => void; children?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return <li className={styles.attachment} data-off={on ? undefined : ""}>
    <div className={styles.attachmentHead}>
      <span className={styles.attachmentIcon} aria-hidden="true">{icon}</span>
      <span className={styles.attachmentText}><b>{title}</b><small>{on ? note : "Left out"}</small></span>
      {children ? <button type="button" className={styles.peek} aria-expanded={shown} onClick={() => setShown(!shown)}>
        {shown ? "Hide" : "See what goes"}<ChevronDown size={14} aria-hidden="true" data-open={shown || undefined} /></button> : null}
      <Switch label={`Include ${title.toLowerCase()}`} hideLabel checked={on} onChange={onChange} />
    </div>
    {shown && children ? <div className={styles.attachmentBody}>{children}</div> : null}
  </li>;
}

function Lines({ rows, empty }: { rows: string[]; empty: string }) {
  return rows.length ? <ol className={styles.lines}>{rows.map((r, i) => <li key={i}>{r}</li>)}</ol> : <p className={styles.fine}>{empty}</p>;
}

function MyReports() {
  const [rows, setRows] = useState<Mine[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/v0/bug-reports/mine", { signal: ctl.signal, cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("load")))).then((d: { rows: Mine[] }) => setRows(d.rows)).catch((e) => { if ((e as Error).name !== "AbortError") setFailed(true); });
    return () => ctl.abort();
  }, []);
  if (failed) return <p className={styles.fine} role="status">Your reports can’t load right now. Try again in a moment.</p>;
  if (!rows) return <div className={styles.mine} aria-busy="true">{[0, 1, 2].map((k) => <span key={k} className={styles.skeleton} />)}</div>;
  if (!rows.length) return <p className={styles.fine}>Nothing sent yet. When something goes wrong, report it here and we’ll tell you when it’s fixed.</p>;
  return <ul className={styles.mine}>{rows.map((r) => <li key={r.id} className={styles.mineRow}>
    <span className={styles.mineWords}><b>#{r.number}</b> {r.words}</span>
    <span className={styles.mineMeta}><Badge tone={r.status === "fixed" ? "success" : r.status === "fixing" ? "accent" : r.status === "wontfix" ? "neutral" : "warning"}>{r.duplicateNumber ? `Same as #${r.duplicateNumber}` : STATUS_WORDS[r.status] ?? "Sent"}</Badge><small>{when(r.statusAt)}</small></span>
  </li>)}</ul>;
}

export function BugReportSheet({ about, onClose, release, signedOut = false }: { about: ReportAbout | null; onClose: () => void; release: string; signedOut?: boolean }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [view, setView] = useState<View>("write");
  const [words, setWords] = useState(draft.words);
  const [blocksWork, setBlocksWork] = useState(draft.blocksWork);
  const [picture, setPicture] = useState<Picture>({ state: "taking" });
  const [include, setInclude] = useState<Include>(ALL);
  const [snap] = useState<Snapshot>(() => ({ errors: recentErrors(), calls: recentCalls(), steps: recentSteps(50), where: reportContext(release) }));
  const [clip, setClip] = useState<Clip | null>(null);
  const [recording, setRecording] = useState<{ recorder: Recorder; seconds: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; number: number } | null>(null);
  const command = useRef(commandId());
  const file = useRef<HTMLInputElement>(null);
  const wordsId = useId(), formId = useId();
  const mac = isMac();
  const keys = shortcutLabel(mac);
  const recordable = canRecord() && !signedOut;
  const pictureLimit = signedOut ? SIGNED_OUT_PICTURE : MAX_PICTURE;

  // The picture is taken as the reporter opens (the reporter itself left out).
  useEffect(() => {
    let alive = true;
    void captureScreen().then((blob) => { if (alive) setPicture(blob ? { state: "ready", blob, url: URL.createObjectURL(blob), marked: false, source: "auto" } : { state: "failed" }); });
    return () => { alive = false; };
  }, []);
  // A picture's address is released when it is replaced or the reporter closes.
  useEffect(() => { const url = picture.state === "ready" ? picture.url : null; return () => { if (url) URL.revokeObjectURL(url); }; }, [picture]);
  useEffect(() => { const url = clip?.url; return () => { if (url) URL.revokeObjectURL(url); }; }, [clip]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    if (!PICTURE_TYPES.includes(f.type)) { setStatus("Choose a PNG, JPG or WebP picture."); return; }
    if (f.size > MAX_PICTURE) { setStatus("Choose a picture under 4 MB."); return; }
    setStatus(null);
    setInclude((i) => ({ ...i, screenshot: true }));
    setPicture({ state: "ready", blob: f, url: URL.createObjectURL(f), marked: false, source: "upload" });
  };

  const record = async () => {
    setStatus(null);
    try {
      const recorder = await startRecording((seconds) => setRecording((r) => (r ? { ...r, seconds } : r)));
      setRecording({ recorder, seconds: 0 });
      const got = await recorder.done;
      setRecording(null);
      if (got) { setClip(got); setInclude((i) => ({ ...i, recording: true })); }
      else setStatus("The recording was empty or too large. Try a shorter one.");
    } catch (error) {
      setRecording(null);
      if ((error as Error)?.name !== "NotAllowedError") setStatus("This browser could not record the screen.");
    }
  };

  const send = async () => {
    const text = words.trim();
    if (!text || sending) return;
    setSending(true); setStatus(null);
    try {
      const shot = include.screenshot && picture.state === "ready" && picture.blob.size <= pictureLimit ? await dataUrl(picture.blob) : null;
      const video = include.recording && clip ? await dataUrl(clip.blob) : null;
      const body = {
        commandId: command.current,
        words: about ? `${text}\n\n(About: ${about.title}${about.reference ? `, ref ${about.reference}` : ""})` : text,
        blocksWork, route: snap.where.route, platform: snap.where.platform, appVersion: snap.where.appVersion,
        context: include.device ? snap.where.context : { release: snap.where.context.release },
        errors: include.errors ? snap.errors : [], network: include.calls ? snap.calls : [], trail: include.steps ? snap.steps : [],
        screenshot: shot, recording: video, recordingSeconds: video ? clip?.seconds : undefined,
        ...(signedOut ? { name: name.trim(), contact: contact.trim(), website } : {}),
      };
      const r = await fetch(signedOut ? "/api/v0/auth/bug-report" : "/api/v0/bug-reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = await r.json().catch(() => ({})) as { id?: string; number?: number; error?: string; screenshot?: string; recording?: string };
      if (signedOut && r.ok && answer.id === null) { setSent({ id: "", number: 0 }); setView("sent"); return; }
      if (!r.ok || !answer.id) throw new Error(answer.error ?? (r.status === 413 ? "That is too large to send. Leave the recording out and send again." : "Your report didn’t go. Send again in a moment."));
      haptic("success");
      telemetryEvent("app.bug_report", { n: "sent", x: { shot: !!shot, clip: !!video } });
      const seen = (() => { try { return JSON.parse(store.get(SEEN_KEY) ?? "{}") as Record<string, string>; } catch { return {}; } })();
      store.set(SEEN_KEY, JSON.stringify({ ...seen, [answer.id]: "new" }));
      draft.words = ""; draft.blocksWork = false; command.current = commandId();
      setSent({ id: answer.id, number: answer.number ?? 0 }); setView("sent");
      if (answer.screenshot === "skipped" || answer.recording === "skipped") notify({ id: "bug-report-partial", tone: "info", title: "Your report went without one part", message: answer.screenshot === "skipped" ? "The picture didn’t go with it." : "The recording didn’t go with it." });
    } catch (error) {
      setStatus(error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Your report didn’t go. Check the connection and send again.");
    } finally { setSending(false); }
  };

  // While recording, the reporter steps aside: a small bar shows the time and Stop.
  if (recording) return <div className={styles.recordingBar} role="status" data-capture-skip="">
    <span className={styles.recDot} aria-hidden="true" /><span>Recording {recording.seconds}s / {MAX_SECONDS}s. Show the problem, then stop.</span>
    <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => recording.recorder.stop()}><Square size={12} aria-hidden="true" />Stop</button>
  </div>;

  const ready = picture.state === "ready";
  const footer = view === "write" ? <DrawerFooter status={status}
    primary={<button type="submit" form={formId} className={`${ui.btn} ${ui.btnPrimary}`} disabled={!words.trim() || sending} aria-busy={sending || undefined}>{sending ? "Sending…" : "Send report"}</button>}>
    <button type="button" className={ui.btn} onClick={onClose}>Cancel</button></DrawerFooter>
    : view === "sent" ? <DrawerFooter primary={<button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={onClose}>Done</button>}>{signedOut ? null : <button type="button" className={ui.btn} onClick={() => setView("mine")}>Your reports</button>}</DrawerFooter>
    : view === "mine" ? <DrawerFooter primary={<button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={onClose}>Done</button>}><button type="button" className={ui.btn} onClick={() => { setSent(null); setView("write"); }}>Report a bug</button></DrawerFooter>
    : undefined;
  const title = view === "markup" ? "Mark up the picture" : view === "sent" ? "Thanks for telling us" : view === "mine" ? "Your reports" : "Report a bug";

  return <Drawer title={title} onClose={onClose} size="lg" icon={<Bug size={18} aria-hidden="true" />} footer={footer}
    context={view === "write" ? <span className={styles.context}>The team sees it straight away · <kbd>{keys.open}</kbd> from any screen</span> : undefined}>
    <div data-bug-reporter="" className={styles.body}>
      {view === "markup" && ready ? <MarkupEditor source={picture.blob} onCancel={() => setView("write")} onDone={(marked) => {
        setPicture({ state: "ready", blob: marked, url: URL.createObjectURL(marked), marked: true, source: picture.source });
        setInclude((i) => ({ ...i, screenshot: true })); setView("write");
      }} /> : view === "sent" ? <div className={styles.sent} role="status">
        <span className={styles.sentIcon} aria-hidden="true"><CheckCircle2 size={30} /></span>
        <strong>{sent?.number ? `Sent as bug #${sent.number}. ` : "Sent. "}{signedOut ? "Thank you." : "We’ll tell you when it’s fixed."}</strong>
        <p>{signedOut ? (contact.trim() ? "The team sees it now and can reach you on what you typed." : "The team sees it now.") : "The team sees it now. When its status changes you’ll find it under Your reports, and a note appears here in Pulse when it’s fixed."}</p>
      </div> : view === "mine" ? <MyReports /> : <form id={formId} className={styles.form} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {about ? <p className={styles.about}><TriangleAlert size={15} aria-hidden="true" /><span>About: {about.title}</span></p> : null}
        <label className={styles.field} htmlFor={wordsId}>
          <span className={styles.label}>What went wrong?</span>
          <textarea id={wordsId} className={styles.words} value={words} rows={4} maxLength={4000} autoCapitalize="sentences"
            placeholder="What did you do, and what happened instead?" onChange={(e) => { setWords(e.target.value); draft.words = e.target.value; }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
        </label>
        <div className={styles.chips}>
          <button type="button" className={styles.chip} aria-pressed={blocksWork} onClick={() => { haptic("light"); setBlocksWork(!blocksWork); draft.blocksWork = !blocksWork; }}>
            <TriangleAlert size={15} aria-hidden="true" />This stops my work</button>
        </div>
        {signedOut ? <div className={styles.who}>
          <label className={styles.field}><span className={styles.label}>Your name <small>optional</small></span>
            <input className={styles.input} value={name} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>
          <label className={styles.field}><span className={styles.label}>E-mail or phone, to hear back <small>optional</small></span>
            <input className={styles.input} value={contact} maxLength={200} autoComplete="email" inputMode="email" onChange={(e) => setContact(e.target.value)} /></label>
          {/* No person sees or fills this; a form-filling bot does, and its report is dropped. */}
          <input className={styles.honey} tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div> : null}
        <section className={styles.goes} aria-label="What goes with your report">
          <h3 className={styles.goesHead}>What goes with it <small>Switch off anything you’d rather not send</small></h3>
          <ul className={styles.attachments}>
            <li className={styles.attachment} data-off={include.screenshot && ready ? undefined : ""}>
              <div className={styles.pictureRow}>
                {ready && include.screenshot ? <button type="button" className={styles.thumbButton} aria-label="Mark up or blur the picture" onClick={() => setView("markup")}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview */}
                  <img className={styles.thumb} src={picture.url} alt="Picture of the screen that goes with your report" />
                </button> : <span className={picture.state === "taking" ? styles.thumbLoading : styles.thumbEmpty} aria-hidden="true"><Camera size={18} /></span>}
                <span className={styles.attachmentText}>
                  <b>{ready && picture.source === "upload" ? "Your picture" : "Picture of this screen"}</b>
                  <small>{picture.state === "taking" ? "Taking it… you can start typing." : picture.state === "failed" ? "Couldn’t take one here. Choose a picture instead."
                    : !ready ? "No picture" : !include.screenshot ? "Left out" : picture.marked ? "Marked up. Typed values are hidden." : "Typed values and private areas are hidden. Blur anything else."}</small>
                  <span className={styles.inlineActions}>
                    {ready && include.screenshot ? <button type="button" className={styles.inlineAction} onClick={() => setView("markup")}><PenLine size={13} aria-hidden="true" />{picture.marked ? "Change mark-up" : "Draw or blur"}</button> : null}
                    <button type="button" className={styles.inlineAction} onClick={() => file.current?.click()}><ImagePlus size={13} aria-hidden="true" />{ready ? "Use another picture" : "Choose a picture"}</button>
                  </span>
                </span>
                {ready ? <Switch label="Include the picture" hideLabel checked={include.screenshot} onChange={(on) => setInclude((i) => ({ ...i, screenshot: on }))} /> : null}
                <input ref={file} className={styles.file} type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} aria-hidden="true" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            </li>
            {recordable || clip ? <li className={styles.attachment} data-off={clip && include.recording ? undefined : ""}>
              <div className={styles.attachmentHead}>
                <span className={styles.attachmentIcon} aria-hidden="true"><Video size={16} /></span>
                <span className={styles.attachmentText}><b>Screen recording</b><small>{clip ? (include.recording ? `${clip.seconds} s recorded` : "Left out") : `Optional: show the problem in up to ${MAX_SECONDS} seconds. You choose what to share.`}</small></span>
                {clip ? <Switch label="Include the recording" hideLabel checked={include.recording} onChange={(on) => setInclude((i) => ({ ...i, recording: on }))} />
                  : <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => void record()}><Circle size={12} aria-hidden="true" />Record</button>}
              </div>
              {clip && include.recording ? <div className={styles.attachmentBody}><video className={styles.clip} src={clip.url} controls muted playsInline />
                <button type="button" className={styles.inlineAction} onClick={() => { setClip(null); void record(); }}><Circle size={12} aria-hidden="true" />Record again</button></div> : null}
            </li> : null}
            <Attachment icon={<TriangleAlert size={16} />} title="Recent errors" note={snap.errors.length ? `${snap.errors.length} on this page` : "None on this page"} on={include.errors} onChange={(on) => setInclude((i) => ({ ...i, errors: on }))}>
              <Lines empty="No errors were recorded on this page." rows={snap.errors.map((e) => `${timeOf(e.at)} · ${e.kind} · ${e.message ?? ""}${e.source ? ` (${e.source}${e.line ? `:${e.line}` : ""})` : ""}${e.count ? ` ×${e.count}` : ""}`)} />
            </Attachment>
            <Attachment icon={<ListChecks size={16} />} title="Failed network calls" note={snap.calls.length ? `${snap.calls.length}: addresses and statuses only` : "None failed"} on={include.calls} onChange={(on) => setInclude((i) => ({ ...i, calls: on }))}>
              <Lines empty="No call failed on this page." rows={snap.calls.map((c) => `${timeOf(c.at)} · ${c.method} ${c.path} → ${c.status || "no connection"}`)} />
            </Attachment>
            <Attachment icon={<ListChecks size={16} />} title="Recent steps" note={snap.steps.length ? `Your last ${snap.steps.length} clicks, pages and calls` : "None recorded"} on={include.steps} onChange={(on) => setInclude((i) => ({ ...i, steps: on }))}>
              <Lines empty="No steps were recorded (usage tracking is off here)." rows={snap.steps.map((s) => `${timeOf(s.at)} · ${s.kind}${s.name ? ` ${s.name}` : ""}${s.page ? ` on ${s.page}` : ""}${s.ms !== undefined ? ` · ${s.ms} ms` : ""}${s.status !== undefined ? ` · ${s.status}` : ""}`)} />
            </Attachment>
            <Attachment icon={<Smartphone size={16} />} title="Screen, app and device" note={`${snap.where.route} · ${String(snap.where.context.browser ?? snap.where.platform)} · ${String(snap.where.context.viewport)}`} on={include.device} onChange={(on) => setInclude((i) => ({ ...i, device: on }))}>
              <Lines empty="" rows={[`Screen: ${snap.where.route}`, `App: ${snap.where.appVersion} (${snap.where.platform})`, ...Object.entries(snap.where.context).filter(([k]) => k !== "release").map(([k, v]) => `${k}: ${String(v)}`)]} />
            </Attachment>
          </ul>
        </section>
        {signedOut ? <p className={styles.fine}>You are not signed in, so only what you type above tells the team who you are. Never what you typed in fields or passwords.{picture.state === "ready" && picture.blob.size > pictureLimit ? " The picture is too large to send from here; it is left out." : ""}</p>
          : <p className={styles.fine}>Pulse also notes who you are and your company, so the team can reply. Never what you typed in fields, message text or passwords.{" "}
          <button type="button" className={styles.inlineAction} onClick={() => setView("mine")}>Your reports</button>
          {" · "}<Link className={styles.inlineAction} href="/bug-reports" onClick={onClose}>All on one page</Link></p>}
        {!mac && typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches ? <p className={styles.fine}>Shortcut: <kbd>{keys.open}</kbd>, or <kbd>{keys.editor}</kbd> while typing in a text editor.</p> : null}
        <ShakeSetting />
      </form>}
    </div>
  </Drawer>;
}

// ------------------------------------------------------------------------------------------------ shake to report
const inPhoneApp = () => !!shell() || (typeof navigator !== "undefined" && /\bPulseShell\//.test(navigator.userAgent));
const shakeOn = () => store.get(SHAKE_KEY) !== "off";
type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

function ShakeSetting() {
  const [on, setOn] = useState(shakeOn);
  if (!inPhoneApp()) return null;
  return <Switch label="Shake the phone to report a bug" hint="Three quick shakes open this from any screen." checked={on} onChange={async (next) => {
    // iPhone asks once for motion access, from a tap.
    const ask = (globalThis.DeviceMotionEvent as unknown as MotionPermission | undefined)?.requestPermission;
    if (next && ask) { try { if ((await ask()) !== "granted") return; } catch { return; } }
    store.set(SHAKE_KEY, next ? "on" : "off"); setOn(next); window.dispatchEvent(new Event("pulse:shake-setting"));
  }} />;
}

/** In the phone app: three quick shakes open the reporter, over a menu or a sheet too, never over the reporter itself. */
function useShakeToReport(active: boolean) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(inPhoneApp() && shakeOn());
    read();
    window.addEventListener("pulse:shake-setting", read);
    return () => window.removeEventListener("pulse:shake-setting", read);
  }, []);
  useEffect(() => {
    if (!active || !on) return;
    const shaken = shakeDetector();
    const listen = (event: DeviceMotionEvent) => {
      const a = event.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null || document.hidden) return;
      if (!shaken(a.x, a.y, a.z)) return;
      haptic("warning");
      telemetryEvent("app.bug_report", { n: "shake" });
      openBugReport();
    };
    window.addEventListener("devicemotion", listen);
    return () => window.removeEventListener("devicemotion", listen);
  }, [active, on]);
}

// ------------------------------------------------------------------------------------------------ the host
/** Looks at the person's own reports now and then (only while one sent from this device is still open) and says so
 *  when one has been fixed since the last look. */
async function lookForFixes() {
  let seen: Record<string, string>;
  try { seen = JSON.parse(store.get(SEEN_KEY) ?? "null") as Record<string, string>; } catch { return; }
  if (!seen || !Object.values(seen).some((s) => !["fixed", "wontfix"].includes(s))) return;
  if (Date.now() - Number(store.get(LOOKED_KEY) ?? 0) < 30 * 60_000) return;
  const r = await fetch("/api/v0/bug-reports/mine", { cache: "no-store" });
  if (!r.ok) return;
  const rows = ((await r.json()) as { rows: Mine[] }).rows;
  store.set(LOOKED_KEY, String(Date.now()));
  store.set(SEEN_KEY, JSON.stringify(Object.fromEntries(rows.slice(0, 30).map((x) => [x.id, x.status]))));
  for (const fixed of rows.filter((x) => x.status === "fixed" && seen[x.id] !== undefined && seen[x.id] !== "fixed").slice(0, 2)) {
    notify({ id: `bug-fixed-${fixed.id}`, tone: "success", title: `Fixed: bug #${fixed.number}`, message: `“${fixed.words.slice(0, 80)}${fixed.words.length > 80 ? "…" : ""}”. Thanks for reporting it. If it still happens, tell us.`,
      timeout: 12_000, action: { label: "Report again", run: () => openBugReport() } });
  }
}

/** Mounted once in the app frame (layout.tsx) for a signed-in person: listens for the shortcut, a shake and the
 *  open event, records recent problems for a report, and says when a report has been fixed. */
export function BugReportHost({ release, signedOut = false }: { release: string; signedOut?: boolean }) {
  const [open, setOpen] = useState<{ about: ReportAbout | null; key: number } | null>(null);
  useEffect(() => {
    installRecorder();
    const off = installReportShortcut();
    let n = 0;
    const show = (event: Event) => { telemetryEvent("app.bug_report", { n: "open" }); setOpen((o) => o ?? { about: (event as CustomEvent<ReportAbout | null>).detail ?? null, key: (n += 1) }); };
    window.addEventListener(REPORT_BUG_EVENT, show);
    const look = signedOut ? 0 : window.setTimeout(() => { void lookForFixes().catch(() => {}); }, 8000);
    return () => { off(); window.removeEventListener(REPORT_BUG_EVENT, show); window.clearTimeout(look); };
  }, [signedOut]);
  useShakeToReport(!open);
  const close = useCallback(() => setOpen(null), []);
  return open ? <BugReportSheet key={open.key} about={open.about} onClose={close} release={release} signedOut={signedOut} /> : null;
}
