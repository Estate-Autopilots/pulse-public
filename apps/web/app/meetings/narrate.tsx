"use client";
// MEETING-CAPTURE (1946; MEETING-DEEP C #20, the feedback loop): "Narrate a problem". A staff member types or pastes what
// went wrong ("this doesn't scroll on the tasks page"), or records it (the server's own Whisper writes it down). Pulse
// drafts a bug report, or a task, with the page named; nothing is sent until the person presses the button. A bug report
// is filed as their own (it gets its task, and KAZUK-REST slice 5 sends it to the Pulse team's board); a task goes to
// their Work. The narration is kept as a meeting, line by line, so the report links back to the words.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bug, CircleCheck, ListTodo, Loader2, MapPin, Megaphone, Mic, PartyPopper, ShieldCheck } from "lucide-react";
import { Segmented } from "../kit";
import { Skeleton, celebrate } from "../kit/game";
import { post, type Preview } from "./importer";
import { Recorder } from "./recorder";
import css from "./meetings.module.css";

type Kind = "bug" | "task";
type Action = { id: string; title: string; kind: Kind; state: string; route: string | null };
type Sent = { kind: Kind; title: string; bugNumber?: number; taskId?: string };
const PAGES: Record<string, string> = { "/tasks": "Tasks", "/tasks/projects": "Projects", "/my-day": "My day", "/dashboard": "Home", "/chats": "Chats", "/calls": "Calls", "/meetings": "Meetings",
  "/docs": "Docs", "/processes": "Processes", "/clients": "Clients", "/contacts": "Contacts", "/acquisition": "Leads", "/erp": "Billing", "/erp/documents": "Quotes", "/erp/catalog": "Catalogue",
  "/finance": "Finance", "/contracts": "Agreements", "/people": "Team", "/me": "My desk", "/hr": "HR desk", "/goals": "Goals", "/pr": "PR Studio", "/settings": "Settings",
  "/notifications": "Notifications", "/search": "Search", "/login": "Sign-in", "/people/ai": "AI employees", "/bug-reports": "Bug reports" };
const pageName = (r: string | null | undefined) => r ? PAGES[r] ?? r : null;

export function Narrate({ from }: { from: string | null }) {
  const [text, setText] = useState(""), [read, setRead] = useState<{ text: string; preview: Preview | null; error: string } | null>(null), [error, setError] = useState("");
  const [kinds, setKinds] = useState<Record<number, Kind>>({}), [titles, setTitles] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false), [sent, setSent] = useState<{ meetingId: string; items: Sent[] } | null>(null);
  const [voice, setVoice] = useState(false), [canRecord, setCanRecord] = useState<boolean | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (sent) celebrate(doneRef.current, { id: `narrate-${sent.meetingId}` }); }, [sent]);
  useEffect(() => { fetch("/api/v0/meetings/options").then((r) => r.ok ? r.json() : null).then((d) => setCanRecord(!!d?.transcripts)).catch(() => setCanRecord(false)); }, []);
  useEffect(() => {
    if (!text.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      post<Preview>("meetings/preview", { text, purpose: "problem", from }).then((p) => { if (live) setRead({ text, preview: p, error: "" }); })
        .catch((e) => { if (live) setRead({ text, preview: null, error: (e as Error).message }); });
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [text, from]);
  const has = !!text.trim(), current = has && read?.text === text, reading = has && !current;
  const preview = has ? read?.preview ?? null : null, readError = current ? read!.error : "";

  const drafts = preview?.drafts ?? [];
  const kindOf = (i: number) => kinds[i] ?? (drafts[i]?.kind === "task" ? "task" : "bug");
  const allBugs = drafts.every((_, i) => kindOf(i) === "bug"), allTasks = drafts.every((_, i) => kindOf(i) === "task");
  const label = drafts.length > 1 ? `Send all ${drafts.length}` : allTasks ? "Make the task" : "Send bug report";

  async function send() {
    if (!drafts.length || sending) return; setSending(true); setError("");
    let meetingId = "";
    try {
      const r = await post<{ id: string; meeting: { actions: Action[] } }>("meetings/import", { text, purpose: "problem", from });
      meetingId = r.id;
      const items: Sent[] = [];
      for (const [i, a] of r.meeting.actions.filter((x) => x.state === "draft").entries()) {
        const kind = kindOf(i), title = (titles[i] ?? a.title).trim() || a.title;
        const x = await post<{ result: { bugNumber?: number; taskId?: string } }>(`meetings/${r.id}/actions/${a.id}/confirm`, { kind, title });
        items.push({ kind, title, bugNumber: x.result.bugNumber, taskId: x.result.taskId });
      }
      setSent({ meetingId, items });
    } catch (e) {
      setError(`${(e as Error).message}${meetingId ? " What you said is kept: open it from Meetings to send the rest." : ""}`);
    } finally { setSending(false); }
  }
  function again() { setSent(null); setText(""); setRead(null); setKinds({}); setTitles({}); }

  if (sent) return <section className={`${css.card} ${css.doneCard}`} role="status" data-narrate-sent="">
    <p className={css.doneHead} ref={doneRef}><PartyPopper size={22} aria-hidden="true" /><span><b>Thanks, that helps.</b><small>{sent.items.some((x) => x.kind === "bug") ? "Bug reports go to the team that fixes Pulse. You can follow each one from its task." : "The task is in your Work."}</small></span></p>
    <ul className={css.items}>{sent.items.map((x, i) => <li key={i} className={css.item} data-state="confirmed">
      <CircleCheck size={16} aria-hidden="true" />
      <span className={css.main}><b>{x.title}</b><small>{x.kind === "bug" ? `Bug report${x.bugNumber ? ` #${x.bugNumber}` : ""} sent` : "Task made"}</small></span>
      {x.taskId ? <Link href={`/tasks/${x.taskId}`} className={css.ghost}>Open the task</Link> : null}
    </li>)}</ul>
    <div className={css.actions}><Link href={`/meetings/${sent.meetingId}`} className={css.ghost}>See what you said</Link>
      <button type="button" className={css.primaryBtn} onClick={again}><Megaphone size={16} aria-hidden="true" />Narrate another</button></div>
  </section>;

  if (voice) return <div className={css.view}>
    <Recorder project={null} client={null} purpose="problem" />
    <p><button type="button" className={css.link} onClick={() => setVoice(false)}>Type it instead</button></p>
  </div>;

  return <div className={css.view}>
    <section className={css.card} data-narrate="">
      <div className={css.cardHead}><h2 className={css.h2}>What went wrong, and where?</h2>
        {canRecord ? <button type="button" className={css.ghost} onClick={() => setVoice(true)}><Mic size={16} aria-hidden="true" />Record it</button> : null}</div>
      <textarea className={css.bigText} value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={20000} aria-label="What went wrong" data-narration=""
        placeholder={"Say it the way you would tell a colleague. For example:\nThis doesn’t scroll on the Tasks page.\nThe Save button is cut off on my phone in Billing."} />
      <p className={css.private}><ShieldCheck size={14} aria-hidden="true" /><span>Name the page if you can, so the team finds it fast. Nothing is sent until you press the button.</span></p>
      {error || readError ? <p className={css.error} role="alert">{error || readError}</p> : null}
    </section>

    {reading && !preview ? <section className={css.card} aria-busy="true"><p className={css.note} role="status"><Loader2 size={15} aria-hidden="true" className={css.spin} />Writing the draft…</p>
      <Skeleton width="70%" height={14} /><Skeleton width="45%" height={14} /></section> : null}

    {preview && drafts.length ? <section className={css.card} aria-labelledby="draft-h" data-problem-drafts="">
      <div className={css.cardHead}><h2 id="draft-h" className={css.h2}>{drafts.length > 1 ? `Pulse found ${drafts.length} things` : "Pulse’s draft"}</h2><small className={css.note}>Check it, then send</small></div>
      <ul className={css.items}>{drafts.map((d, i) => <li key={i} className={css.draft} data-problem-draft="">
        <div className={css.draftTop}>
          <Segmented<Kind> label="Send it as" size="sm" value={kindOf(i)} onChange={(v) => setKinds((x) => ({ ...x, [i]: v }))}
            options={[{ value: "bug", label: "Bug report", icon: Bug }, { value: "task", label: "Task", icon: ListTodo }]} />
          <span className={css.pageChip} data-page={d.route ?? ""}><MapPin size={14} aria-hidden="true" />{d.route ? <>Page: <b>{pageName(d.route)}</b></> : "No page named"}</span>
        </div>
        <label className={css.field}><span>{kindOf(i) === "bug" ? "What’s wrong" : "Task"}</span><input value={titles[i] ?? d.title} onChange={(e) => setTitles((x) => ({ ...x, [i]: e.target.value }))} maxLength={300} /></label>
        {d.quote && d.quote !== d.title ? <q className={css.quote}>{d.quote}</q> : null}
      </li>)}</ul>
      <div className={css.actions}>
        <span className={css.note}>{allBugs ? "Goes to the team that fixes Pulse." : allTasks ? "Goes to your Work." : "Bug reports go to the Pulse team; tasks to your Work."}</span>
        <button type="button" className={css.primaryBtn} onClick={() => void send()} disabled={sending || reading} data-send-problem="">
          {sending ? <Loader2 size={16} aria-hidden="true" className={css.spin} /> : allTasks ? <ListTodo size={16} aria-hidden="true" /> : <Bug size={16} aria-hidden="true" />}{sending ? "Sending…" : label}</button>
      </div>
    </section> : null}
  </div>;
}
