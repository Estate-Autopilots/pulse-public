import Link from "next/link";
import { FileText, FileUp, Megaphone, Mic, NotebookPen, Search } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { day, dayTime } from "../lib/format";
import { Badge, Empty, Page, PageHeader, Panel } from "../ui";
import { EmptyState } from "../kit/game";
import css from "./meetings.module.css";

/** KAZUK-REST slice 4 + MEETING-CAPTURE (1946): meetings recorded in Pulse, pasted or uploaded transcripts (Wispr Flow,
 *  Loom, Otter, .txt, .vtt, .srt) and narrated problems; their transcripts kept line by line, searchable by the people who
 *  may see each meeting (row security per meeting), and the tasks drafted from them. Data: GET /api/v0/meetings,
 *  GET /api/v0/meetings/search?q=. */
type Row = { id: string; title: string; kind: "recording" | "notes"; state: string; seconds: number | null; startedAt: string; byName: string; project: string | null; client: string | null;
  transcriptState: string; drafts: number; tasks: number; source?: string; purpose?: string; heldOn?: string | null; summary?: string | null; lines?: number };
type Hit = { meetingId: string; title: string; startedAt: string; heldOn?: string; purpose?: string; n: number; speaker?: string; at?: number; text: string };

const length = (s: number | null) => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : null;
const transcriptBadge = (r: Row) => r.transcriptState === "queued" || r.transcriptState === "working" ? <Badge>Transcribing</Badge>
  : r.transcriptState === "done" ? null : r.transcriptState === "failed" ? <Badge tone="warning">No transcript</Badge> : <Badge>Notes to write</Badge>;
const icon = (r: Row) => r.purpose === "problem" ? <Megaphone size={16} aria-hidden="true" /> : r.kind === "recording" ? <Mic size={16} aria-hidden="true" />
  : r.source === "file" || r.source === "paste" ? <FileUp size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />;
const stamp = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** The line around the first word searched for, that word marked. */
function marked(text: string, q: string): ReactNode {
  const low = text.toLowerCase();
  const hit = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).map((w) => ({ w, at: low.indexOf(w) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0];
  if (!hit) return text;
  const start = Math.max(0, hit.at - 70), end = hit.at + hit.w.length;
  const part = text.slice(start, end + 160), words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Every match marked, not only the first.
  const bits = part.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{start ? "…" : ""}{bits.map((b, i) => i % 2 ? <mark key={i}>{b}</mark> : b)}{end + 160 < text.length ? "…" : ""}</>;
}

export default async function Meetings({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = String((await searchParams).q ?? "").trim().slice(0, 120);
  const [r, s] = await Promise.all([api<{ meetings: Row[]; transcripts: boolean }>("meetings"),
    q.length >= 2 ? api<{ results: Hit[] }>(`meetings/search?q=${encodeURIComponent(q)}`) : Promise.resolve(null)]);
  const add = <Link href="/meetings/new" className={css.primary} data-start-meeting=""><FileUp size={16} aria-hidden="true" />Add a meeting</Link>;
  if (!r.data) return <Page><PageHeader title="Meetings" actions={r.status === 403 ? undefined : add} />
    <Empty icon={NotebookPen} title={r.status === 403 ? "Meetings are for staff" : "Meetings could not be loaded"} text={r.status === 403 ? "Sign in with your staff account to add a meeting." : r.error ?? "Try again in a moment."} /></Page>;
  const rows = r.data.meetings;
  const hits = s?.data?.results ?? [];
  return <Page>
    <PageHeader title="Meetings" />
    <p className={css.lede}>Every meeting, kept line by line. Pulse finds the to-dos, and you pick which become tasks.</p>
    {/* While searching, the results come first (the ways in step aside). */}
    {q.length >= 2 ? null : <nav className={css.ways} aria-label="Ways to add a meeting">
      <Link href="/meetings/new" className={`${css.way} ${css.wayMain}`}><FileUp size={18} aria-hidden="true" /><span><b>Paste or upload</b><small>A transcript, as text or a file</small></span></Link>
      <Link href="/meetings/new?mode=record" className={css.way}><Mic size={18} aria-hidden="true" /><span><b>Record</b><small>In the room, with everyone told</small></span></Link>
      <Link href="/meetings/new?mode=problem" className={css.way} data-narrate-link=""><Megaphone size={18} aria-hidden="true" /><span><b>Narrate a problem</b><small>“This doesn’t scroll on Tasks”</small></span></Link>
    </nav>}
    {rows.length || q ? <form className={css.searchRow} role="search" action="/meetings">
      <label className={css.find}><Search size={15} aria-hidden="true" /><input type="search" name="q" defaultValue={q} placeholder="Search transcripts" aria-label="Search transcripts" /></label>
      <button type="submit" className={css.ghost}>Search</button>
    </form> : null}
    {q.length >= 2 ? <Panel title={hits.length ? `${hits.length >= 60 ? "60+" : hits.length} ${hits.length === 1 ? "line" : "lines"} with “${q}”` : `Nothing found for “${q}”`} sub="Only meetings you were in, or lead">
      {hits.length ? <ul className={css.rows} data-search-results="">{hits.map((h) => <li key={`${h.meetingId}-${h.n}`}><Link href={`/meetings/${h.meetingId}?line=${h.n}#line-${h.n}`} className={css.hit}>
        <span className={css.main}><b>{h.title}</b><small>{[h.heldOn ? day(h.heldOn) : dayTime(h.startedAt), `line ${h.n}`, h.at !== undefined ? stamp(h.at) : null, h.speaker].filter(Boolean).join(" · ")}</small>
          <span className={css.hitText}>{marked(h.text, q)}</span><span className={css.hitGo}>Open at line {h.n} →</span></span>
      </Link></li>)}</ul> : <Empty compact icon={Search} title="No line has those words" text="Try one word, or a name. Search looks only in meetings you may open." />}
    </Panel> : null}
    <Panel title="Recent meetings" sub="Meetings you can open">
      {/* VISUAL-QA (D138): the "Paste or upload" tile above is the view's one primary way in; the empty state does not add a
          second violet "Add a meeting" to the same page (it keeps it only while a search hides the tiles). */}
      {!rows.length ? <EmptyState art="nothing" title="No meetings yet" text={q.length >= 2 ? "Paste the transcript of your last call, or record the next one. Pulse finds the action items for you to confirm." : "Paste the transcript of your last call above, or record the next one. Pulse finds the action items for you to confirm."} action={q.length >= 2 ? { href: "/meetings/new", label: "Add a meeting" } : undefined} />
        : <ul className={css.rows}>{rows.map((m) => <li key={m.id}><Link href={`/meetings/${m.id}`} className={css.row}>
          {icon(m)}
          <span className={css.main}><b>{m.title}</b><small>{[m.heldOn ? day(m.heldOn) : dayTime(m.startedAt), length(m.seconds), m.lines ? `${m.lines} ${m.lines === 1 ? "line" : "lines"}` : null, m.project, m.client, m.byName].filter(Boolean).join(" · ")}</small>
            {m.summary ? <span className={css.rowSummary}>{m.summary}</span> : null}</span>
          <span className={css.tags}>{m.purpose === "problem" ? <Badge tone="accent">Problem</Badge> : null}{transcriptBadge(m)}{m.drafts ? <Badge tone="warning">{m.drafts} to confirm</Badge> : null}
            {m.tasks ? <Badge tone="success">{m.tasks} {m.purpose === "problem" ? "sent" : m.tasks === 1 ? "task" : "tasks"}</Badge> : null}</span>
        </Link></li>)}</ul>}
    </Panel>
  </Page>;
}
