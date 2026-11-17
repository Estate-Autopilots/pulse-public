// DITASU-FIX (owner, 17 Nov 2026): "We need the full path like a video, and the patterns analysed." One person's day for
// leadership: the moments they struggled (found automatically: refused actions, pages that looked ready but did not
// respond, the same thing clicked again and again, slow waits, freezes, errors), each with its replay at that moment;
// the day step by step; and what was slow for them. Data: GET /api/v0/telemetry/day (services/api/src/telemetry-day.ts).
import { AlertTriangle, Ban, ChevronLeft, ChevronRight, Clock3, Hourglass, MousePointerClick, Play, Snowflake, Undo2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { EmptyState } from "../../kit/game";
import { Badge, Kpi, Message, Page, PageHeader, Panel, Tiles, styles } from "../../ui";
import type { ReplayMeta } from "../replay/load";
import { ReplayPlayer } from "../replay/player";
import css from "./day.module.css";

type Step = { at: string; sessionId: string | null; kind: string; label: string; page: string | null; ms: number | null; tone: "ok" | "slow" | "fail"; requestId: string | null };
type Struggle = { at: string; sessionId: string | null; kind: string; title: string; detail: string; page: string | null; ms: number | null; requestId: string | null };
type Slow = { name: string; n: number; p50: number; p90: number; max: number };
type Session = { id: string; start: string; end: string; platform: string | null; device: string | null; replay: { from: string; to: string; chunks: number } | null };
type Day = {
  zone: string; people: { id: string; name: string; days: number; last: string; refused?: number; slowStarts?: number }[]; person: { id: string; name: string } | null;
  date?: string; days?: { d: string; n: number }[]; sessions?: Session[]; truncated?: boolean; steps?: Step[]; struggles?: Struggle[]; slowPages?: Slow[]; slowActions?: Slow[];
  totals?: { sessions: number; loads: number; moves: number; actions: number; failed: number; struggles: number; activeMs: number };
};

const ICON: Record<string, ReactNode> = {
  refused: <Ban size={15} aria-hidden="true" />, dead_start: <Hourglass size={15} aria-hidden="true" />, early_clicks: <MousePointerClick size={15} aria-hidden="true" />,
  repeat: <MousePointerClick size={15} aria-hidden="true" />, slow: <Clock3 size={15} aria-hidden="true" />, freeze: <Snowflake size={15} aria-hidden="true" />,
  error: <AlertTriangle size={15} aria-hidden="true" />, rage: <MousePointerClick size={15} aria-hidden="true" />, dead_click: <MousePointerClick size={15} aria-hidden="true" />,
  gave_up: <Undo2 size={15} aria-hidden="true" />,
};
const KIND: Record<string, string> = { refused: "Refused", dead_start: "Not ready", early_clicks: "Not ready", repeat: "Clicked again", slow: "Slow", freeze: "Froze", error: "Error", rage: "Clicked again", dead_click: "No answer", gave_up: "Gave up" };
const time = (iso: string, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const stamp = (iso: string, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const dayName = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${d}T00:00:00Z`));
const secs = (ms: number | null | undefined) => ms === null || ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)}\u00a0ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}\u00a0s`;
const trouble = (refused: number, slow: number) => !refused && !slow ? "No trouble this week"
  : [refused ? `${refused} refused ${refused === 1 ? "click" : "clicks"}` : "", slow ? `${slow} slow page ${slow === 1 ? "load" : "loads"}` : ""].filter(Boolean).join(" · ");
const hours = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export default async function PersonDay({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const qs = new URLSearchParams();
  if (q.person) qs.set("person", q.person);
  if (q.date) qs.set("date", q.date);
  const r = await api<Day>(`telemetry/day${qs.size ? `?${qs}` : ""}`);
  if (r.error || !r.data) return <Message text={r.status === 403 ? "A person's day is for leadership" : r.error ?? "This day could not load"} />;
  const d = r.data;
  const href = (p: Record<string, string | undefined>) => { const s = new URLSearchParams(); for (const [k, v] of Object.entries({ person: d.person?.id ?? q.person, date: d.date, ...p })) if (v) s.set(k, v); return `/telemetry/day?${s}`; };

  const troubled = d.people.filter((p) => (p.refused ?? 0) + (p.slowStarts ?? 0) > 0).length;
  const peopleSorted = [...d.people].sort((a, b) => ((b.refused ?? 0) + (b.slowStarts ?? 0) > 0 ? 1 : 0) - ((a.refused ?? 0) + (a.slowStarts ?? 0) > 0 ? 1 : 0));
  if (!d.person) return <Page>
    <PageHeader title="A person's day" back={{ href: "/telemetry", label: "Telemetry" }} context={["Each step, where they struggled, and the replay"]} />
    <Panel title="Choose a person" sub={troubled ? `${troubled} ${troubled === 1 ? "person" : "people"} had trouble this week. Pick one to see their day.` : "Nobody had trouble this week. Pick one to see their day."}>
      {d.people.length ? <ul className={css.people}>{peopleSorted.map((p) => <li key={p.id}><Link className={css.person} href={`/telemetry/day?person=${p.id}`}>
        <b>{p.name}</b>
        <span className={css.trouble}>{p.refused || p.slowStarts ? <Badge tone="warning">{trouble(p.refused ?? 0, p.slowStarts ?? 0)}</Badge> : <Badge tone="success">{trouble(0, 0)}</Badge>}</span>
        <span className={css.seen}>Active {p.days === 1 ? "1 day" : `${p.days} days`} · last {stamp(p.last, d.zone)}</span>
        <ChevronRight className={css.chev} size={16} aria-hidden="true" /></Link></li>)}</ul>
        : <EmptyState title="Nobody yet" text="When people use Pulse, their days show here." />}
    </Panel>
  </Page>;

  const sessions = d.sessions ?? [], struggles = d.struggles ?? [], steps = d.steps ?? [], t = d.totals!;
  const dayList = d.days ?? [], at = dayList.findIndex((x) => x.d === d.date);
  const prev = at > 0 ? dayList[at - 1].d : null, next = at >= 0 && at < dayList.length - 1 ? dayList[at + 1].d : null;
  const replayOf = (sid: string | null, iso: string) => { const s = sessions.find((x) => x.id === sid); if (!s?.replay) return false; const ms = Date.parse(iso); return ms >= Date.parse(s.replay.from) - 30_000 && ms <= Date.parse(s.replay.to) + 30_000; };
  const watch = q.watch && sessions.some((s) => s.id === q.watch && s.replay) ? q.watch : null;
  const playing = watch ? struggles.find((s) => s.sessionId === watch && String(Date.parse(s.at)) === q.t) ?? null : null;
  const meta = watch ? await api<ReplayMeta>(`telemetry/replay/${encodeURIComponent(watch)}`) : null;
  const slowest = (d.slowPages ?? [])[0];
  const showAll = q.all === "1", shown = showAll ? steps : steps.slice(0, 160);

  return <Page>
    <PageHeader title={`${d.person.name.split(" ")[0]}'s day`} back={{ href: "/telemetry/day", label: "People" }}
      context={[dayName(d.date!), `${t.sessions} ${t.sessions === 1 ? "session" : "sessions"}`, t.activeMs ? `${hours(t.activeMs)} active` : ""]}
      meta={prev || next ? <span className={css.days}>
        {prev ? <Link className={css.dayBtn} href={href({ date: prev, watch: undefined, t: undefined, all: undefined })} aria-label="An earlier day"><ChevronLeft size={13} aria-hidden="true" />Earlier day</Link> : null}
        {next ? <Link className={css.dayBtn} href={href({ date: next, watch: undefined, t: undefined, all: undefined })} aria-label="A later day">Later day<ChevronRight size={13} aria-hidden="true" /></Link> : null}
      </span> : undefined} />

    <Tiles count={4} dense>
      <Kpi label="Struggle moments" value={struggles.length} tone={struggles.length ? "danger" : "success"} note={struggles.length ? "Each with its replay" : "A smooth day"} />
      <Kpi label="Refused actions" value={t.failed} tone={t.failed ? "danger" : "success"} note={`of ${t.actions} clicks and forms`} />
      <Kpi label="Slowest page" value={slowest ? secs(slowest.p90) : "–"} tone={slowest && slowest.p90 >= 3000 ? "warning" : "success"} note={slowest ? slowest.name : "No pages opened"} />
      <Kpi label="Pages opened" value={t.loads + t.moves} note={`${t.loads} full loads · ${t.moves} moves`} />
    </Tiles>

    {watch && meta?.data ? <Panel title="Replay" sub={playing ? "Starts 3 s before the moment" : `${time(meta.data.chunks[0].startedAt, d.zone)} – ${time(meta.data.chunks[meta.data.chunks.length - 1].endedAt, d.zone)} · from the start`}
      action={{ href: href({ watch: undefined, t: undefined }), label: "Close" }}>
      <div className={css.replay} id="replay">
        {playing ? <p className={css.moment1} data-kind={playing.kind}><span className={css.icon}>{ICON[playing.kind] ?? <AlertTriangle size={15} aria-hidden="true" />}</span>
          <span><b>{time(playing.at, d.zone)} · {playing.title}</b>{playing.detail ? <span>{playing.detail}</span> : null}</span></p> : null}
        <ReplayPlayer meta={meta.data} at={q.t} />
      </div>
    </Panel> : null}

    <Panel title="Where they struggled" sub={struggles.length ? "Found from what happened on screen, in time order" : undefined}>
      {struggles.length ? <ol className={css.moments}>{struggles.map((s, i) => <li key={`${s.at}-${i}`} className={css.moment} data-kind={s.kind} data-playing={playing === s ? "" : undefined} aria-current={playing === s ? "true" : undefined}>
        <span className={css.icon}>{ICON[s.kind] ?? <AlertTriangle size={15} aria-hidden="true" />}</span>
        <span className={css.when}>{time(s.at, d.zone)}</span>
        <span className={css.what}><b>{s.title}</b>{s.detail ? <span>{s.detail}</span> : null}</span>
        <span className={css.tags}><Badge tone={s.kind === "refused" || s.kind === "error" ? "danger" : "warning"}>{KIND[s.kind] ?? s.kind}</Badge>{s.ms ? <span className={css.ms}>{secs(s.ms)}</span> : null}</span>
        {replayOf(s.sessionId, s.at) ? <Link className={`${styles.btn} ${styles.btnSmall} ${css.watch}`} href={`${href({ watch: s.sessionId ?? undefined, t: String(Date.parse(s.at)) })}#replay`}><Play size={13} aria-hidden="true" />{playing === s ? "Playing" : "Watch"}</Link>
          : <span className={`${styles.btn} ${styles.btnSmall} ${css.watch} ${css.off}`} aria-disabled="true" title="The screen was not being recorded at that moment"><Play size={13} aria-hidden="true" />No replay</span>}
      </li>)}</ol> : <EmptyState title="No struggles found" text="No refused clicks, slow waits, frozen pages or repeated clicks on this day." />}
    </Panel>

    <div className={css.two}>
      <Panel title="Slowest pages for them" sub="The slowest 1 in 10, and the usual time">
        <SlowList rows={d.slowPages ?? []} empty="No pages opened." />
      </Panel>
      <Panel title="Slowest actions for them" sub="From the click to the screen settling">
        <SlowList rows={d.slowActions ?? []} empty="No clicks recorded." />
      </Panel>
    </div>

    <Panel title="The day, step by step" sub={`${steps.length} steps${d.truncated ? " (the day's first 8,000 events)" : ""}`}
      action={steps.length > shown.length ? { href: href({ all: "1" }), label: `Show all ${steps.length}` } : undefined}>
      {sessions.length ? <div className={css.sessions}>{sessions.map((s, n) => {
        const own = shown.filter((x) => x.sessionId === s.id);
        return <section key={s.id} className={css.session} aria-label={`Session ${n + 1}`}>
          <header className={css.sessionHead}><b>Session {n + 1}</b><span className={css.sessionWhen}>{time(s.start, d.zone)} – {time(s.end, d.zone)} · {s.device ?? s.platform ?? "web"}</span>
            {s.replay ? <Link className={`${styles.btn} ${styles.btnSmall}`} href={`${href({ watch: s.id, t: String(Date.parse(s.replay.from)) })}#replay`}><Play size={13} aria-hidden="true" />Replay</Link> : <span className={css.noReplay}>No replay</span>}
          </header>
          {!own.length ? <p className={css.empty}>{steps.some((x) => x.sessionId === s.id) ? "Its steps are further down: choose Show all." : "Only background work: no pages opened or clicks in this session."}</p> : null}
          <ol className={css.steps}>{own.map((x, i) => <li key={`${x.at}-${i}`} className={css.step} data-tone={x.tone}>
            <span className={css.when}>{time(x.at, d.zone)}</span><span className={css.dot} aria-hidden="true" />
            <span className={css.label}>{x.label}</span>
            <span className={css.ms}>{x.ms !== null ? secs(x.ms) : ""}</span>
          </li>)}</ol>
        </section>;
      })}</div> : <EmptyState title="Nothing on this day" text="Choose another day." />}
    </Panel>
    <div className={css.end} aria-hidden="true" />
  </Page>;
}

function SlowList({ rows, empty }: { rows: Slow[]; empty: string }) {
  if (!rows.length) return <p className={css.empty}>{empty}</p>;
  const most = Math.max(...rows.map((r) => r.p90), 1);
  return <ul className={css.slow}>{rows.slice(0, 6).map((r) => <li key={r.name}>
    <span className={css.slowName} title={r.name}>{r.name}</span>
    <span className={css.bar} aria-hidden="true"><i style={{ width: `${Math.max(4, Math.round((r.p90 / most) * 100))}%` }} data-slow={r.p90 >= 3000 ? "" : undefined} /></span>
    <span className={css.slowNums}><b>{secs(r.p90)}</b><em>usual {secs(r.p50)}</em></span>
  </li>)}</ul>;
}
