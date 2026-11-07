"use client";
// PR-STUDIO: PR Studio's interactive parts: briefs, the streak, done-but-not-told, a draft (copy, images, open an app with
// the text in, plan, posted), the content calendar (drag a draft to another day), the Story (chapters and lines, edited
// in place), audiences and the PR team templates. Nothing is sent from here: the person copies and sends.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type DragEvent, type FormEvent } from "react";
import { CalendarDays, Check, Copy, EyeOff, Flame, Mail, MessageCircle, Pencil, Plus, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { post } from "../orgs/client";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";
import { CHANNEL_WORDS, KIND_WORDS, RATIO_WORDS, TONE_WORDS, dayName, monthGrid, monthName, plainText, shareHref, shiftMonth, streakWords, weekGrid } from "../lib/pr-studio.mjs";
import { PrImage, useBrandLook } from "./pr-image";
import type { Agent, Audience, Brief, Channel, Draft, Entry, Kind, Month, Ratio, Tone } from "./types";
import css from "./pr.module.css";

const APPROVAL: Record<string, string> = { draft: "Draft", review: "In review", approved: "Approved", posted: "Posted" };
const errorText = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act<T>(path: string, body: unknown, then?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await post<T>(path, body); then?.(r); router.refresh(); return r; }
    catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  }
  return { busy, error, act, router };
}

function CopyButton({ text, label = "Copy text" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={css.btn} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); } catch { setDone(false); } }}>
    {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{done ? "Copied" : label}
  </button>;
}

function OpenIn({ channel, text, subject }: { channel: Channel; text: string; subject: string }) {
  const words = channel === "whatsapp" || channel === "telegram" ? text : plainText(text);
  const Icon = channel === "email" ? Mail : channel === "whatsapp" ? MessageCircle : Send;
  return <a className={css.btn} href={shareHref(channel, words, subject)} target="_blank" rel="noreferrer"><Icon size={14} aria-hidden="true" />Open {CHANNEL_WORDS[channel]}</a>;
}

// ------------------------------------------------------------------------------------------------ dashboard parts
export function Streak({ streak, toldLast30, activeDaysLast30, toldToday, untold }: { streak: number; toldLast30: number; activeDaysLast30: number; toldToday: boolean; untold: number }) {
  return <section className={css.streak} aria-label="Days told" data-lit={streak > 0 ? "yes" : undefined}>
    <span className={css.flame} data-today={toldToday ? "yes" : undefined}><Flame size={26} aria-hidden="true" /></span>
    <span>
      <strong>{streakWords(streak)}</strong>
      <span className={css.muted}>{toldLast30} of the last 30 days told · work happened on {activeDaysLast30}{untold ? ` · ${untold} done but not yet told` : ""}</span>
    </span>
    {toldToday ? <span className={css.badge}>Told today</span> : <Link className={css.btn} href="/pr?tab=today#untold">Tell something today</Link>}
  </section>;
}

export function BriefCard({ brief, channel = "whatsapp" }: { brief: Brief; channel?: Channel }) {
  const [open, setOpen] = useState(false);
  const text = `*${brief.title}*\n\n${brief.body}`;
  const who = brief.writtenBy === "auto" ? "Written by Pulse from the Story" : brief.writtenBy === "ai" ? `Written by ${brief.author ?? "an AI employee"}` : `Written by ${brief.author ?? "a person"}`;
  return <article className={css.card} data-kind={brief.kind}>
    <header className={css.cardHead}>
      <span className={css.chip}>{brief.kind === "morning" ? "Morning brief" : brief.kind === "evening" ? "Evening brief" : brief.kind === "weekly" ? "Weekly brief" : "Update"}</span>
      <span className={css.muted}>{dayName(brief.day)}</span>
    </header>
    <h3 className={css.cardTitle}>{brief.title}</h3>
    <pre className={css.copy} data-open={open ? "yes" : undefined}>{brief.body}</pre>
    {brief.body.split("\n").length > 7 ? <button type="button" className={css.link} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button> : null}
    <footer className={css.actions}>
      <CopyButton text={text} />
      <OpenIn channel={channel} text={text} subject={brief.title} />
      <span className={css.muted}>{who}</span>
    </footer>
  </article>;
}

export function WriteBrief() {
  const { busy, error, act } = useAct();
  return <div className={css.actions}>
    {(["morning", "evening", "update"] as const).map((k) => <button key={k} type="button" className={css.btn} disabled={busy} onClick={() => act("pr/briefs", { kind: k })}>
      <Sparkles size={14} aria-hidden="true" />{k === "update" ? "Write an update now" : `Write the ${k} brief now`}</button>)}
    {error ? <span className={css.error} role="alert">{error}</span> : null}
  </div>;
}

/** Done but not yet told: pick lines and an audience, and get a draft. */
export function Untold({ entries, audiences, count }: { entries: Entry[]; audiences: Audience[]; count: number }) {
  const { busy, error, act, router } = useAct();
  const [picked, setPicked] = useState<string[]>([]);
  const [audience, setAudience] = useState(audiences[0]?.id ?? "");
  if (!entries.length) return <p className={css.empty}>Everything done has been told. New work shows up here as it happens.</p>;
  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  return <div className={css.stack}>
    <ul className={css.lines}>{entries.map((e) => <li key={e.id}>
      <label className={css.pick}><input type="checkbox" checked={picked.includes(e.id)} onChange={() => toggle(e.id)} />
        <span className={css.kind} data-kind={e.kind}>{KIND_WORDS[e.kind]}</span>
        <span className={css.lineTitle}>{e.title}</span>
        <span className={css.muted}>{dayName(e.happenedOn)}</span>
      </label>
    </li>)}</ul>
    {count > entries.length ? <p className={css.muted}>{count - entries.length} more in the Story.</p> : null}
    {audiences.length ? <div className={css.actions}>
      <label className={css.inline}>Draft for
        <select value={audience} onChange={(e) => setAudience(e.target.value)}>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      </label>
      <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy || !audience}
        onClick={() => act<{ draft: Draft }>("pr/drafts", { audienceId: audience, entryIds: picked }, (r) => router.push(`/pr?tab=drafts&draft=${r.draft.id}`))}>
        <Sparkles size={14} aria-hidden="true" />{picked.length ? `Draft from ${picked.length} picked` : "Draft from all of these"}
      </button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </div> : <p className={css.empty}>Add an audience first (<Link href="/pr?tab=audiences">Audiences</Link>): who you tell, in which tone and channel.</p>}
  </div>;
}

// ------------------------------------------------------------------------------------------------ a draft
export function DraftCard({ draft, company, today, open = false }: { draft: Draft; company: string; today: string; open?: boolean }) {
  const { busy, error, act } = useAct();
  const look = useBrandLook(company);
  const [edit, setEdit] = useState(false);
  const [headline, setHeadline] = useState(draft.headline);
  const [copy, setCopy] = useState(draft.copy);
  const [longPost, setLongPost] = useState(draft.longPost);
  const [show, setShow] = useState(open);
  const save = () => act("pr/drafts/" + draft.id, { headline, copy, longPost }, () => setEdit(false));
  const slug = draft.headline.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "creative";
  return <article className={css.card} id={`draft-${draft.id}`} data-status={draft.status}>
    <header className={css.cardHead}>
      <span className={css.chip}>{draft.audience} · {CHANNEL_WORDS[draft.channel]} · {TONE_WORDS[draft.tone]}</span>
      <span className={css.muted}>{draft.status === "posted" ? `Posted ${draft.postedAt ? dayName(draft.postedAt.slice(0, 10)) : ""}` : draft.status === "skipped" ? "Skipped"
        : draft.planOn ? `Planned for ${dayName(draft.planOn)}${draft.planOn < today ? " (overdue)" : ""}` : "Not planned yet"}</span>
    </header>
    {edit ? <div className={css.stack}>
      <label className={css.field}>Headline<input value={headline} maxLength={160} onChange={(e) => setHeadline(e.target.value)} /></label>
      <label className={css.field}>Message (WhatsApp: *bold*, _italic_)<textarea rows={10} value={copy} maxLength={4000} onChange={(e) => setCopy(e.target.value)} /></label>
      <label className={css.field}>Long post (LinkedIn, e-mail)<textarea rows={10} value={longPost} maxLength={8000} onChange={(e) => setLongPost(e.target.value)} /></label>
      <div className={css.actions}>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className={css.btn} onClick={() => { setEdit(false); setHeadline(draft.headline); setCopy(draft.copy); setLongPost(draft.longPost); }}>Cancel</button>
      </div>
    </div> : <>
      <h3 className={css.cardTitle}>{draft.headline}</h3>
      <pre className={css.copy} data-open={show ? "yes" : undefined}>{draft.copy}</pre>
      <div className={css.actions}>
        <CopyButton text={draft.copy} />
        <OpenIn channel={draft.channel === "linkedin" || draft.channel === "x" ? "whatsapp" : draft.channel} text={draft.copy} subject={draft.headline} />
        {draft.channel !== "whatsapp" ? <OpenIn channel="whatsapp" text={draft.copy} subject={draft.headline} /> : <OpenIn channel="telegram" text={draft.copy} subject={draft.headline} />}
        <OpenIn channel="email" text={draft.longPost || draft.copy} subject={draft.headline} />
        <button type="button" className={css.link} onClick={() => setShow(!show)}>{show ? "Less" : "Long post and images"}</button>
        <button type="button" className={css.btn} onClick={() => setEdit(true)}><Pencil size={14} aria-hidden="true" />Edit</button>
      </div>
      {show ? <div className={css.stack}>
        <h4 className={css.sub}>Long post</h4>
        <pre className={css.copy} data-open="yes">{draft.longPost}</pre>
        <div className={css.actions}>
          <CopyButton text={plainText(draft.longPost)} label="Copy long post" />
          <OpenIn channel="linkedin" text={plainText(draft.longPost)} subject={draft.headline} />
          <OpenIn channel="x" text={plainText(draft.headline)} subject={draft.headline} />
        </div>
        <h4 className={css.sub}>Images · {RATIO_WORDS[draft.ratio]}</h4>
        <div className={css.images}>{draft.images.map((spec, i) => <PrImage key={i} spec={spec} look={look} day={dayName(draft.planOn ?? today)} name={`${slug}-${i + 1}`} />)}</div>
      </div> : null}
    </>}
    <footer className={css.actions}>
      <label className={css.inline}><CalendarDays size={14} aria-hidden="true" />Post on
        <input type="date" defaultValue={draft.planOn ?? ""} onChange={(e) => act("pr/drafts/" + draft.id, { planOn: e.target.value || null })} />
      </label>
      {draft.status !== "posted" ? <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy} onClick={() => act("pr/drafts/" + draft.id, { status: "posted" })}>
        <Check size={14} aria-hidden="true" />I posted it</button> : <button type="button" className={css.btn} disabled={busy} onClick={() => act("pr/drafts/" + draft.id, { status: draft.planOn ? "planned" : "draft" })}>Not posted after all</button>}
      {draft.status !== "skipped" && draft.status !== "posted" ? <button type="button" className={css.btn} disabled={busy} onClick={() => act("pr/drafts/" + draft.id, { status: "skipped" })}><X size={14} aria-hidden="true" />Skip</button> : null}
      {draft.taskId ? <Link className={css.link} href={`/tasks/${draft.taskId}`}>Task on My day</Link> : null}
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </footer>
  </article>;
}

// ------------------------------------------------------------------------------------------------ the content calendar
/** PR-PIPELINE: meta (optional) gives each draft on a brand its brand and approval state (draft, review, approved, posted). */
export function Calendar({ drafts, month, today, meta = {} }: { drafts: Draft[]; month: string; today: string; meta?: Record<string, { brand: string; approval: string }> }) {
  const { error, act } = useAct();
  const [view, setView] = useState<"month" | "week">("month");
  const [over, setOver] = useState<string | null>(null);
  const weeks = view === "month" ? monthGrid(month, today) : [weekGrid(month === today.slice(0, 7) ? today : `${month}-01`, today)];
  const byDay = new Map<string, Draft[]>();
  for (const d of drafts) if (d.planOn) byDay.set(d.planOn, [...(byDay.get(d.planOn) ?? []), d]);
  const unplanned = drafts.filter((d) => !d.planOn && d.status === "draft");
  const drop = (day: string) => (e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) act("pr/drafts/" + id, { planOn: day }); };
  const chip = (d: Draft) => <Link key={d.id} href={`/pr?tab=drafts&draft=${d.id}`} className={css.post} data-status={d.status} data-approval={meta[d.id]?.approval} draggable={d.status !== "posted"}
    onDragStart={(e) => { e.dataTransfer.setData("text/plain", d.id); e.dataTransfer.effectAllowed = "move"; }}
    title={`${d.headline} · ${d.audience}${meta[d.id] ? ` · ${meta[d.id].brand} · ${APPROVAL[meta[d.id].approval] ?? meta[d.id].approval}` : ""}`}>
    {meta[d.id] ? <span className={css.postBrand}>{meta[d.id].brand} · {APPROVAL[meta[d.id].approval] ?? meta[d.id].approval}</span> : null}
    <span className={css.postAudience}>{d.audience}</span><span className={css.postTitle}>{d.headline}</span>
  </Link>;
  return <section className={css.stack} aria-label="Content calendar">
    <div className={css.calHead}>
      <Link className={css.btn} href={`/pr?tab=calendar&month=${shiftMonth(month, -1)}`} aria-label="Previous month">‹</Link>
      <h2>{monthName(month)}</h2>
      <Link className={css.btn} href={`/pr?tab=calendar&month=${shiftMonth(month, 1)}`} aria-label="Next month">›</Link>
      <span className={css.grow} />
      <div className={css.segmented} role="group" aria-label="Calendar view">
        <button type="button" aria-pressed={view === "month"} onClick={() => setView("month")}>Month</button>
        <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>Week</button>
      </div>
    </div>
    <p className={css.muted}>Drag a post to another day to move it. Each planned post is also a task on your My day.</p>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.cal} data-view={view}>
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} className={css.calDow}>{d}</span>)}
      {weeks.flat().map((c) => <div key={c.day} className={css.calDay} data-out={c.inMonth ? undefined : "yes"} data-today={c.today ? "yes" : undefined} data-over={over === c.day ? "yes" : undefined}
        onDragOver={(e) => { e.preventDefault(); setOver(c.day); }} onDragLeave={() => setOver((o) => o === c.day ? null : o)} onDrop={drop(c.day)} aria-label={dayName(c.day)}>
        <span className={css.calNum}>{Number(c.day.slice(8))}</span>
        {(byDay.get(c.day) ?? []).map(chip)}
      </div>)}
    </div>
    {unplanned.length ? <div className={css.stack}>
      <h3 className={css.sub}>Not planned yet: drag onto a day</h3>
      <div className={css.tray}>{unplanned.map(chip)}</div>
    </div> : null}
  </section>;
}

// ------------------------------------------------------------------------------------------------ the Story
function EntryRow({ entry }: { entry: Entry }) {
  const { busy, error, act } = useAct();
  const [edit, setEdit] = useState(false);
  if (edit) return <li><form className={css.stack} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    act("pr/story/" + entry.id, { title: String(f.get("title") ?? ""), body: String(f.get("body") ?? ""), happenedOn: String(f.get("happenedOn") ?? entry.happenedOn), kind: String(f.get("kind")) }, () => setEdit(false)); }}>
    <div className={css.row}>
      <label className={css.field}>What happened<input name="title" defaultValue={entry.title} maxLength={200} required /></label>
      <label className={css.field}>Day<input name="happenedOn" type="date" defaultValue={entry.happenedOn} required /></label>
      <label className={css.field}>Kind<select name="kind" defaultValue={entry.kind}>{(Object.keys(KIND_WORDS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}</select></label>
    </div>
    <label className={css.field}>More (optional)<textarea name="body" rows={3} defaultValue={entry.body} maxLength={4000} /></label>
    <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Save</button><button type="button" className={css.btn} onClick={() => setEdit(false)}>Cancel</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}</div>
  </form></li>;
  return <li className={css.entry} data-told={entry.toldAt ? "yes" : undefined}>
    <span className={css.kind} data-kind={entry.kind}>{KIND_WORDS[entry.kind]}</span>
    <span className={css.entryText}><span className={css.lineTitle}>{entry.title}</span>{entry.body ? <span className={css.entryBody}>{entry.body}</span> : null}</span>
    <span className={css.entryTools}>
      {entry.toldAt ? <span className={css.badge}>Told</span> : null}
      <button type="button" className={css.icon} aria-label="Edit" onClick={() => setEdit(true)}><Pencil size={14} aria-hidden="true" /></button>
      <button type="button" className={css.icon} aria-label="Hide from the Story" disabled={busy} onClick={() => act("pr/story/" + entry.id, { hidden: true })}><EyeOff size={14} aria-hidden="true" /></button>
    </span>
  </li>;
}

function ChapterHead({ period, startsOn, title, summary, level }: { period: "week" | "month"; startsOn: string; title: string; summary: string; level: 2 | 3 }) {
  const { busy, error, act } = useAct();
  const [edit, setEdit] = useState(false);
  const H = level === 2 ? "h2" : "h3";
  if (edit) return <form className={css.stack} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    act("pr/chapters", { period, startsOn, title: String(f.get("title") ?? ""), summary: String(f.get("summary") ?? "") }, () => setEdit(false)); }}>
    <label className={css.field}>Chapter title<input name="title" defaultValue={title} maxLength={120} /></label>
    <label className={css.field}>What it was about<textarea name="summary" rows={3} defaultValue={summary} maxLength={4000} /></label>
    <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Save chapter</button><button type="button" className={css.btn} onClick={() => setEdit(false)}>Cancel</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}</div>
  </form>;
  return <header className={css.chapter} data-level={level}>
    <H>{title} <button type="button" className={css.icon} aria-label={`Edit the chapter ${title}`} onClick={() => setEdit(true)}><Pencil size={13} aria-hidden="true" /></button></H>
    <p>{summary}</p>
  </header>;
}

export function StoryBook({ months, today }: { months: Month[]; today: string }) {
  const { busy, error, act } = useAct();
  const [adding, setAdding] = useState(false);
  return <div className={css.stack}>
    <div className={css.actions}>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setAdding(!adding)}><Plus size={14} aria-hidden="true" />Add to the Story</button>
      <button type="button" className={css.btn} disabled={busy} onClick={() => act("pr/story/collect", {})}><RefreshCw size={14} aria-hidden="true" />Collect the last 30 days</button>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </div>
    {adding ? <form className={css.form} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
      act("pr/story", { title: String(f.get("title") ?? ""), body: String(f.get("body") ?? ""), happenedOn: String(f.get("happenedOn") ?? today), kind: String(f.get("kind")) }, () => setAdding(false)); }}>
      <div className={css.row}>
        <label className={css.field}>What happened<input name="title" maxLength={200} required autoFocus placeholder="For example: Clients can now pay from their phone" /></label>
        <label className={css.field}>Day<input name="happenedOn" type="date" defaultValue={today} required /></label>
        <label className={css.field}>Kind<select name="kind" defaultValue="feature">{(Object.keys(KIND_WORDS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}</select></label>
      </div>
      <label className={css.field}>More (optional)<textarea name="body" rows={3} maxLength={4000} placeholder="Why it matters, in a line or two. Never code." /></label>
      <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Add</button></div>
    </form> : null}
    {months.length ? months.map((m) => <section key={m.startsOn} className={css.month}>
      <ChapterHead period="month" startsOn={m.startsOn} title={m.title} summary={m.summary} level={2} />
      {m.weeks.map((w) => <section key={w.startsOn} className={css.week}>
        <ChapterHead period="week" startsOn={w.startsOn} title={w.title} summary={w.summary} level={3} />
        {w.days.map((d) => <div key={d.day} className={css.day}>
          <span className={css.dayName}>{dayName(d.day)}</span>
          <ul className={css.lines}>{d.entries.map((e) => <EntryRow key={e.id} entry={e} />)}</ul>
        </div>)}
      </section>)}
    </section>) : <p className={css.empty}>The Story is empty for these days. Collect what the company&apos;s records say happened, or add a line yourself.</p>}
  </div>;
}

// ------------------------------------------------------------------------------------------------ audiences
export function Audiences({ audiences }: { audiences: Audience[] }) {
  const words = useWords();
  const { busy, error, act } = useAct();
  const quickStart: { name: string; tone: Tone; channel: Channel; ratio: Ratio; note: string }[] = [
    { name: say("Our {team}", words), tone: "warm", channel: "whatsapp", ratio: "1:1", note: "The people who build it: what moved and who to thank." },
    { name: "Testers", tone: "bold", channel: "telegram", ratio: "4:5", note: "Early users: what is new to try and how to report a bug." },
    { name: "Clients", tone: "formal", channel: "email", ratio: "16:9", note: "Customers: what is better for them, in their words." },
    { name: "Public", tone: "bold", channel: "linkedin", ratio: "4:5", note: "Everyone: progress, built in public." },
  ];
  const presets = quickStart.filter((p) => !audiences.some((a) => a.name.toLowerCase() === p.name.toLowerCase()));
  const save = (e: FormEvent<HTMLFormElement>, id?: string) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    act(id ? `pr/audiences/${id}` : "pr/audiences", { name: String(f.get("name") ?? ""), tone: String(f.get("tone")), channel: String(f.get("channel")), ratio: String(f.get("ratio")), note: String(f.get("note") ?? "") }); };
  const fields = (a?: Audience) => <>
    <div className={css.row}>
      <label className={css.field}>Name<input name="name" defaultValue={a?.name} maxLength={80} required placeholder="For example: Testers" /></label>
      <label className={css.field}>Tone<select name="tone" defaultValue={a?.tone ?? "warm"}>{Object.entries(TONE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className={css.field}>Channel<select name="channel" defaultValue={a?.channel ?? "whatsapp"}>{Object.entries(CHANNEL_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className={css.field}>Image shape<select name="ratio" defaultValue={a?.ratio ?? "1:1"}>{Object.entries(RATIO_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
    </div>
    <label className={css.field}>Who they are and what they care about<input name="note" defaultValue={a?.note} maxLength={500} /></label>
  </>;
  return <div className={css.stack}>
    {audiences.map((a) => <details key={a.id} className={css.card} data-archived={a.archived ? "yes" : undefined}>
      <summary className={css.cardHead}><strong>{a.name}</strong><span className={css.muted}>{TONE_WORDS[a.tone]} · {CHANNEL_WORDS[a.channel]} · {RATIO_WORDS[a.ratio]}{a.archived ? " · archived" : ""}</span></summary>
      <form className={css.stack} onSubmit={(e) => save(e, a.id)}>{fields(a)}
        <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}>Save</button>
          <button type="button" className={css.btn} disabled={busy} onClick={() => act(`pr/audiences/${a.id}`, { archived: !a.archived })}>{a.archived ? "Bring back" : "Archive"}</button></div>
      </form>
    </details>)}
    <form className={css.form} onSubmit={(e) => save(e)} aria-label="New audience">
      <h3 className={css.sub}>New audience</h3>
      {fields()}
      <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy}><Plus size={14} aria-hidden="true" />Add audience</button></div>
    </form>
    {presets.length ? <div className={css.actions}><span className={css.muted}>Quick start:</span>{presets.map((p) => <button key={p.name} type="button" className={css.btn} disabled={busy}
      onClick={() => act("pr/audiences", p)}><Plus size={14} aria-hidden="true" />{p.name}</button>)}</div> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </div>;
}

// ------------------------------------------------------------------------------------------------ the PR team
export function PrTeam({ agents, hired, me }: { agents: Agent[]; hired: string[]; me: string | null }) {
  const { busy, error, act } = useAct();
  return <div className={css.stack}>
    <p className={css.muted}>AI employees who keep the Story, write the briefs and draft the creatives with PR Studio&apos;s tools (API, MCP and the pulse command, area “pr”). They read and draft; you post. Each one is yours: you own it and approve what it does, and only people in this company see it.</p>
    <div className={css.grid}>{agents.map((a) => {
      const added = hired.includes(a.title.toLowerCase());
      return <article key={a.key} className={css.card}>
        <h3 className={css.cardTitle}>{a.name}</h3>
        <span className={css.chip}>{a.title} · {a.lane === "thinking" ? "thinking lane" : "quick lane"}</span>
        <p>{a.duty}</p>
        <div className={css.actions}>
          {added ? <span className={css.badge}>On your AI team</span> : me ? <button type="button" className={`${css.btn} ${css.primary}`} disabled={busy}
            onClick={() => act("agents", { name: a.name, title: a.title, lane: a.lane, ownerId: me })}><Plus size={14} aria-hidden="true" />Add to my AI team</button> : null}
          <CopyButton text={`${a.name}\n${a.title}\n\n${a.duty}\n\nTools: PR Studio (read the Story, add to it, write briefs, draft creatives, plan the calendar). Never send anything: drafts are posted by a person.`} label="Copy the job" />
        </div>
      </article>;
    })}</div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <p className={css.muted}>Adding one needs an admin. Then give it its AI connection under People → AI employees.</p>
  </div>;
}
