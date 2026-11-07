"use client";
// PR-STUDIO-2 (owner, 7 Nov 2026): PR Studio as one path per brand, left to right: Strategy -> Calendar -> Board ->
// Library -> Post kit -> Insights. The calendar is the main view (month, week and day, hourly slots, drag to move, a
// "what to post where today" panel); the board carries each post from idea to measured; the library holds every creative
// (a carousel is one item with its slides); the post kit is the one-click "ready to post" view. Nothing is posted or sent
// from Pulse: people download, copy and post, then mark it posted here. Goals live in Goals.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { AtSign, Briefcase, CalendarDays, Camera, Check, ChevronLeft, ChevronRight, Clock, Columns3, Compass, Copy, Download, ExternalLink, FileText, Flame, Images,
  Mail, MessageCircle, Send, ShieldAlert, Sparkles, Target, TrendingUp, X, type LucideIcon } from "lucide-react";
import { post as send } from "../orgs/client";
import { CHANNELS, CHANNEL_WORDS, DOW_SHORT, METRIC_WORDS, PILLAR_HUES, STAGES, STAGE_WORDS, VIEWS, VIEW_WORDS, addDays, bestTime, captionToCopy, dayTitle, dow, hourOf,
  linesOf, monthGrid, monthTitle, nextAction, num, rhythm, rowsOf, step, weekDays, weekTitle, type Channel, type Stage, type View } from "../lib/pr-flow.mjs";
import { kitPost, todays } from "./flow-pick";
import type { Asset, FlowData, Post, Strategy } from "./flow-types";
import css from "./flow.module.css";

type Cal = "month" | "week" | "day";
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6);
const CH_ICON: Record<Channel, LucideIcon> = { linkedin: Briefcase, x: AtSign, instagram: Camera, whatsapp_status: MessageCircle, newsletter: Mail };
const VIEW_ICON: Record<View, LucideIcon> = { strategy: Compass, calendar: CalendarDays, board: Columns3, library: Images, kit: Send, insights: TrendingUp };
const file = (id: string, download = false) => `/api/v0/pr/flow/files/${id}${download ? "?download=1" : ""}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const okNeeded = (a: Asset | undefined) => !!a && a.okState === "needs_ok" && !a.okGivenAt;

function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act<T>(path: string, body: unknown, then?: (r: T) => void) {
    setBusy(true); setError(null);
    try { const r = await send<T>(path, body); then?.(r); router.refresh(); return r; }
    catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  }
  return { busy, error, setError, act, router };
}

function Img({ id, alt, className }: { id: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a private image from the API, sized by CSS; next/image would only proxy it
  return <img className={className} src={file(id)} alt={alt} loading="lazy" draggable={false} />;
}
const thumbOf = (a: Asset | undefined) => a?.slides?.[0] ? a.slides[0].thumb ?? a.slides[0].file : null;

function ChannelTag({ c, small }: { c: Channel; small?: boolean }) {
  const I = CH_ICON[c] ?? Send;
  return <span className={css.channel} data-ch={c}><I size={small ? 12 : 14} aria-hidden="true" />{small ? <span className={css.chWord}>{CHANNEL_WORDS[c]}</span> : CHANNEL_WORDS[c]}</span>;
}
function StageTag({ s }: { s: Stage }) { return <span className={css.stage} data-stage={s}>{STAGE_WORDS[s]}</span>; }
function OkTag({ a }: { a: Asset | undefined }) {
  if (!a || a.okState === "ready") return null;
  if (a.okGivenAt) return <span className={css.okGiven}><Check size={12} aria-hidden="true" />OK given</span>;
  return <span className={css.okFlag} data-level={a.okState}><ShieldAlert size={12} aria-hidden="true" />{a.okState === "needs_ok" ? "Needs OK" : "Check first"}{a.okWho ? ` · ${a.okWho}` : ""}</span>;
}

// ------------------------------------------------------------------------------------------------ the frame
export function FlowStudio({ data, view, cal, date, post, asset, edit, adding }: { data: FlowData; view: View; cal: Cal; date: string; post: string | null; asset: string | null; edit: boolean; adding: boolean }) {
  const d = data;
  const href = (extra: Record<string, string>) => `/pr?${new URLSearchParams({ ...(d.brand ? { brand: d.brand.id } : {}), ...extra }).toString()}`;
  const assets = useMemo(() => new Map(d.assets.map((a) => [a.id, a])), [d.assets]);
  if (!d.brand) return <div className={css.studio}>
    <section className={`${css.glass} ${css.emptyHero}`}>
      <Sparkles size={28} aria-hidden="true" />
      <h2>No brand yet</h2>
      <p>Set up a brand (the company, a person or a client) and its strategy, then plan posts on the calendar.</p>
      <Link className={css.primaryBtn} href="/pr/more?tab=brands">Set up a brand</Link>
    </section>
  </div>;
  const counts: Record<View, string> = {
    strategy: `${d.strategy?.pillars.length ?? 0} pillars`,
    calendar: `${d.posts.filter((p) => p.day && p.day >= (d.today ?? "")).length} ahead`,
    board: `${d.posts.filter((p) => ["review"].includes(p.stage)).length} in review`,
    library: `${d.assets.length} creatives`,
    kit: `${todays(d).filter((p) => p.stage !== "posted" && p.stage !== "measured").length} today`,
    insights: d.insights ? `${d.insights.streak} wk streak` : "",
  };
  return <div className={css.studio}>
    <BrandRow d={d} />
    <nav className={css.flow} aria-label="PR Studio, step by step">
      {VIEWS.map((v, i) => { const I = VIEW_ICON[v];
        return <Link key={v} href={href({ view: v })} className={css.flowStep} data-on={v === view ? "yes" : undefined} aria-current={v === view ? "page" : undefined}>
          <span className={css.flowNum}>{i + 1}</span><I size={16} aria-hidden="true" /><span className={css.flowText}><b>{VIEW_WORDS[v]}</b><small>{counts[v]}</small></span>
        </Link>; })}
    </nav>
    {view === "strategy" ? <StrategyView d={d} href={href} edit={edit} date={date} /> : null}
    {view === "calendar" ? <CalendarView d={d} assets={assets} href={href} cal={cal} date={date} /> : null}
    {view === "board" ? <BoardView d={d} assets={assets} href={href} adding={adding} /> : null}
    {view === "library" ? <LibraryView d={d} href={href} open={asset} /> : null}
    {view === "kit" ? <KitView d={d} assets={assets} href={href} post={post} /> : null}
    {view === "insights" ? <InsightsView d={d} assets={assets} href={href} /> : null}
  </div>;
}

function BrandRow({ d }: { d: FlowData }) {
  const { busy, error, act } = useAct();
  const b = d.brand!;
  return <div className={css.brandRow}>
    <div className={css.brands} role="list" aria-label="Brands">
      {d.brands.map((x) => <Link role="listitem" key={x.id} href={`/pr?brand=${x.id}`} className={css.brandChip} data-on={x.id === b.id ? "yes" : undefined}>
        <span className={css.brandDot} data-status={x.status} aria-hidden="true" />{x.name}{x.status === "draft" ? <small>Draft</small> : null}
      </Link>)}
      <Link className={css.brandAdd} href="/pr/more?tab=brands">+ Brand</Link>
    </div>
    {b.status === "draft" ? <div className={`${css.glass} ${css.draftBar}`}>
      <span><b>{b.name} is a draft.</b> Its strategy, creatives and calendar are ready to look over; nothing counts until it is switched on.</span>
      {b.role === "manager" && d.side === "staff" ? <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => act(`pr/flow/brands/${b.id}/switch`, { on: true })}>Switch on</button>
        : <span className={css.muted}>A person who manages the brand switches it on.</span>}
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </div> : null}
  </div>;
}

// ------------------------------------------------------------------------------------------------ strategy
function StrategyView({ d, href, edit, date }: { d: FlowData; href: (x: Record<string, string>) => string; edit: boolean; date: string }) {
  const s = d.strategy;
  if (edit) return <StrategyEditor d={d} href={href} />;
  if (!s) return <section className={`${css.glass} ${css.emptyHero}`}><Compass size={28} aria-hidden="true" /><h2>No strategy yet</h2>
    <p>Write who the brand is for, its 3 to 5 content pillars, the channels and how often, and the plan by month and week.</p>
    <Link className={css.primaryBtn} href={href({ view: "strategy", edit: "1" })}>Write the strategy</Link></section>;
  const month = date.slice(0, 7);
  const weeks = s.weeks.filter((w) => w.start.slice(0, 7) === month || addDays(w.start, 6).slice(0, 7) === month);
  const perWeek = s.channels.reduce((n, c) => n + c.perWeek, 0);
  return <div className={css.stack}>
    <section className={`${css.hero} ${css.rise}`}>
      <p className={css.kicker}>Positioning</p>
      <p className={css.heroText}>{s.positioning || "Not written yet."}</p>
      {s.audiences.length ? <div className={css.chips}>{s.audiences.map((a) => <span key={a.name} className={css.heroChip} title={a.need}>{a.name}</span>)}</div> : null}
    </section>
    <section aria-label="Content pillars">
      <h2 className={css.h2}>Content pillars</h2>
      <div className={css.pillars}>{s.pillars.map((p, i) => <article key={p.key} className={`${css.glass} ${css.pillar} ${css.rise}`} style={{ ["--hue" as string]: PILLAR_HUES[i % PILLAR_HUES.length] }}>
        <header><span className={css.pillarDot} aria-hidden="true" /><h3>{p.name}</h3>{p.share ? <small>{p.share}%</small> : null}</header>
        <p>{p.about}</p>
        <span className={css.muted}>{d.posts.filter((x) => x.pillar === p.key || x.pillar === p.name).length} posts planned</span>
      </article>)}</div>
    </section>
    <div className={css.two}>
      <section className={`${css.glass} ${css.pad}`} aria-label="Channels and cadence">
        <h2 className={css.h2}>Channels and cadence <small className={css.muted}>{perWeek} a week</small></h2>
        <table className={css.table}><thead><tr><th>Channel</th><th>A week</th><th>Days</th><th>Best time</th></tr></thead>
          <tbody>{s.channels.map((c) => <tr key={c.key}><td><ChannelTag c={c.key} /></td><td>{c.perWeek}</td><td>{c.days.map((x) => DOW_SHORT[x - 1]).join(", ") || "Any"}</td><td>{c.times.join(", ") || "Any"}</td></tr>)}</tbody></table>
      </section>
      <section className={`${css.glass} ${css.pad}`} aria-label="KPIs">
        <h2 className={css.h2}>What we measure</h2>
        <ul className={css.kpiList}>{s.kpis.map((k) => <li key={k.label}><Target size={14} aria-hidden="true" /><span>{k.label}</span><b>{num(k.target)}</b><small className={css.muted}>{METRIC_WORDS[k.metric] ?? ""}</small></li>)}</ul>
        <p className={css.muted}>Company and personal goals live in <Link href="/goals">Goals</Link>; PR Studio tracks the posting numbers that feed them.</p>
      </section>
    </div>
    <section aria-label="The plan">
      <h2 className={css.h2}>The plan: month → week → day → hour</h2>
      <div className={css.months}>{s.months.map((m) => <Link key={m.month} href={href({ view: "strategy", date: `${m.month}-01` })} className={`${css.glass} ${css.month}`} data-on={m.month === month ? "yes" : undefined}>
        <small>{monthTitle(`${m.month}-01`)}</small><b>{m.theme}</b><span>{m.focus}</span></Link>)}</div>
      <div className={css.weeks}>{weeks.length ? weeks.map((w) => <Link key={w.start} className={`${css.glass} ${css.week}`} href={href({ view: "calendar", cal: "week", date: w.start })}>
        <small>{weekTitle(w.start)}</small><b>{w.theme}</b><span>{w.note}</span><span className={css.link}>See the week <ChevronRight size={12} aria-hidden="true" /></span></Link>)
        : <p className={css.empty}>No week themes for {monthTitle(`${month}-01`)} yet.</p>}</div>
      <div className={`${css.glass} ${css.pad}`}>
        <h3 className={css.h3}>A usual week, by the hour</h3>
        <div className={css.rhythm} role="table" aria-label="A usual week">
          <div role="row" className={css.rhythmRow}><span role="columnheader" />{DOW_SHORT.map((x) => <span role="columnheader" key={x}>{x}</span>)}</div>
          {s.channels.map((c) => <div role="row" key={c.key} className={css.rhythmRow}><span role="rowheader"><ChannelTag c={c.key} small /></span>
            {[1, 2, 3, 4, 5, 6, 7].map((x) => <span role="cell" key={x}>{c.days.includes(x) ? <span className={css.slotPill} data-ch={c.key}><Clock size={11} aria-hidden="true" />{c.times[0] ?? "Any"}</span> : null}</span>)}</div>)}
        </div>
      </div>
    </section>
    {s.rules.length ? <section className={`${css.glass} ${css.pad}`} aria-label="House rules"><h2 className={css.h2}>House rules</h2><ul className={css.rules}>{s.rules.map((r) => <li key={r}><Check size={14} aria-hidden="true" />{r}</li>)}</ul></section> : null}
  </div>;
}

function StrategyEditor({ d, href }: { d: FlowData; href: (x: Record<string, string>) => string }) {
  const { busy, error, act, router } = useAct();
  const s: Partial<Strategy> = d.strategy ?? {};
  const [chs, setChs] = useState(() => CHANNELS.map((key) => { const c = s.channels?.find((x) => x.key === key);
    return { key, on: !!c, perWeek: String(c?.perWeek ?? 1), days: c?.days ?? [2, 4], times: (c?.times ?? ["09:00"]).join(", ") }; }));
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const t = (k: string) => String(f.get(k) ?? "");
    const body = {
      positioning: t("positioning"),
      audiences: rowsOf(t("audiences"), ["name", "need"]),
      pillars: rowsOf(t("pillars"), ["name", "about", "share"]).map((p, i) => ({ ...p, key: s.pillars?.[i]?.name === p.name ? s.pillars?.[i]?.key : undefined, share: Number(p.share) || 0 })),
      channels: chs.filter((c) => c.on).map((c) => ({ key: c.key, perWeek: Number(c.perWeek) || 0, days: c.days, times: c.times })),
      kpis: rowsOf(t("kpis"), ["label", "metric", "target"]).map((k) => ({ ...k, target: Number(k.target) || 0 })),
      months: rowsOf(t("months"), ["month", "theme", "focus"]),
      weeks: rowsOf(t("weeks"), ["start", "theme", "note"]),
      rules: t("rules").split("\n").map((x) => x.trim()).filter(Boolean),
    };
    const r = await act(`pr/flow/brands/${d.brand!.id}/strategy`, body);
    if (r) router.push(href({ view: "strategy" }));
  }
  const area = (name: string, label: string, value: string, hint: string, rows = 4) => <label className={css.field}><span>{label}</span>
    <textarea name={name} defaultValue={value} rows={rows} /><small className={css.muted}>{hint}</small></label>;
  return <form className={`${css.glass} ${css.form}`} onSubmit={save} aria-label="Edit the strategy">
    {area("positioning", "Positioning", s.positioning ?? "", "One or two sentences: who this brand is for and what it stands for.", 3)}
    {area("audiences", "Audiences", linesOf(s.audiences, ["name", "need"]), "One a line: name — what they need.")}
    {area("pillars", "Content pillars (3 to 5)", linesOf(s.pillars, ["name", "about", "share"]), "One a line: name — what it covers — share of posts (%).")}
    <fieldset className={css.field}><legend>Channels and cadence</legend>
      {chs.map((c, i) => <div key={c.key} className={css.chEdit}>
        <label className={css.check}><input type="checkbox" checked={c.on} onChange={(e) => setChs(chs.map((x, j) => j === i ? { ...x, on: e.target.checked } : x))} />{CHANNEL_WORDS[c.key]}</label>
        <label>A week <input type="number" min={0} max={21} value={c.perWeek} onChange={(e) => setChs(chs.map((x, j) => j === i ? { ...x, perWeek: e.target.value } : x))} /></label>
        <span className={css.days}>{DOW_SHORT.map((w, k) => <button type="button" key={w} aria-pressed={c.days.includes(k + 1)} onClick={() => setChs(chs.map((x, j) => j === i
          ? { ...x, days: x.days.includes(k + 1) ? x.days.filter((y) => y !== k + 1) : [...x.days, k + 1].sort() } : x))}>{w.slice(0, 2)}</button>)}</span>
        <label>Times <input value={c.times} placeholder="08:30, 12:30" onChange={(e) => setChs(chs.map((x, j) => j === i ? { ...x, times: e.target.value } : x))} /></label>
      </div>)}
    </fieldset>
    {area("kpis", "What we measure", linesOf(s.kpis, ["label", "metric", "target"]), `One a line: label — measure — target. Measures: ${Object.keys(METRIC_WORDS).join(", ")}.`)}
    {area("months", "Month themes", linesOf(s.months, ["month", "theme", "focus"]), "One a line: 2026-11 — theme — focus.")}
    {area("weeks", "Week themes", linesOf(s.weeks, ["start", "theme", "note"]), "One a line: the Monday (2026-11-09) — theme — note.", 6)}
    {area("rules", "House rules", (s.rules ?? []).join("\n"), "One a line.")}
    <div className={css.actions}>
      <button className={css.primaryBtn} disabled={busy}>Save the strategy</button>
      <Link className={css.btn} href={href({ view: "strategy" })}>Cancel</Link>
      {error ? <span className={css.error} role="alert">{error}</span> : null}
    </div>
  </form>;
}

// ------------------------------------------------------------------------------------------------ calendar
function useMove() {
  const { busy, error, act } = useAct();
  const [moved, setMoved] = useState<Record<string, { day: string; time: string }>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  async function move(id: string, day: string, time: string) {
    setMoved((m) => ({ ...m, [id]: { day, time } }));
    const r = await act(`pr/flow/posts/${id}`, { day, time });
    if (!r) setMoved((m) => { const n = { ...m }; delete n[id]; return n; });
  }
  const at = (p: Post) => moved[p.id] ? { ...p, ...moved[p.id] } : p;
  return { busy, error, move, at, dragging, setDragging };
}
const canDrag = (p: Post) => p.stage !== "posted" && p.stage !== "measured";

function Chip({ p, a, href, compact, onDrag }: { p: Post; a: Asset | undefined; href: string; compact?: boolean; onDrag?: (id: string | null) => void }) {
  const t = thumbOf(a);
  const drag = onDrag && canDrag(p) ? { draggable: true, onDragStart: (e: DragEvent) => { e.dataTransfer.setData("text/plain", p.id); e.dataTransfer.effectAllowed = "move"; onDrag(p.id); }, onDragEnd: () => onDrag(null) } : {};
  return <Link href={href} className={css.chip} data-ch={p.channel} data-stage={p.stage} data-compact={compact ? "yes" : undefined} title={`${p.time ?? ""} ${CHANNEL_WORDS[p.channel]} · ${p.title} · ${STAGE_WORDS[p.stage]}`} {...drag}>
    {t ? <Img id={t} alt="" className={css.chipThumb} /> : <span className={css.chipThumb} aria-hidden="true" />}
    <span className={css.chipBody}>
      <span className={css.chipTop}><b>{p.time ?? ""}</b><ChannelTag c={p.channel} small /><span className={css.dot} data-stage={p.stage} aria-label={STAGE_WORDS[p.stage]} /></span>
      <span className={css.chipTitle}>{p.title}</span>
      {!compact ? <span className={css.chipMeta}>{p.pillar ? <span>{p.pillar}</span> : null}{p.format ? <span>{p.format}</span> : null}<StageTag s={p.stage} /><OkTag a={a} /></span> : null}
    </span>
  </Link>;
}

function CalendarView({ d, assets, href, cal, date }: { d: FlowData; assets: Map<string, Asset>; href: (x: Record<string, string>) => string; cal: Cal; date: string }) {
  const [only, setOnly] = useState<Channel[]>([]);
  const m = useMove();
  const shown = d.posts.map(m.at).filter((p) => p.day && (!only.length || only.includes(p.channel)));
  const byDay = new Map<string, Post[]>();
  for (const p of shown) { const k = p.day!; byDay.set(k, [...(byDay.get(k) ?? []), p].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))); }
  const channels = d.strategy?.channels ?? [];
  const kit = (p: Post) => href({ view: "kit", post: p.id });
  const drop = (day: string, hour?: number) => ({
    onDragOver: (e: DragEvent) => { if (m.dragging) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } },
    onDrop: (e: DragEvent) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); const p = d.posts.find((x) => x.id === id); m.setDragging(null);
      if (!p) return; const mm = (m.at(p).time ?? "09:00").slice(3, 5); const time = hour === undefined ? m.at(p).time ?? "09:00" : `${String(hour).padStart(2, "0")}:${mm}`;
      if (p.day !== day || p.time !== time) void m.move(id, day, time); },
  });
  const ghost = (day: string, hour?: number) => (d.today && day >= d.today ? rhythm(channels, day) : [])
    .filter((g) => (hour === undefined || hourOf(g.time) === hour) && !(byDay.get(day) ?? []).some((p) => p.channel === g.channel) && (!only.length || only.includes(g.channel)))
    .map((g) => <span key={g.channel + g.time} className={css.ghost} data-ch={g.channel}>Open slot · {CHANNEL_WORDS[g.channel]} {g.time}</span>);
  const title = cal === "month" ? monthTitle(date) : cal === "week" ? weekTitle(date) : dayTitle(date);
  return <div className={css.calWrap}>
    <TodayPanel d={d} assets={assets} href={href} />
    <section className={`${css.glass} ${css.cal}`} aria-label="Calendar">
      <div className={css.calBar}>
        <div className={css.seg} role="group" aria-label="Show">{(["month", "week", "day"] as Cal[]).map((c) => <Link key={c} href={href({ view: "calendar", cal: c, date })} aria-current={c === cal ? "true" : undefined}>{c === "month" ? "Month" : c === "week" ? "Week" : "Day"}</Link>)}</div>
        <div className={css.calNav}>
          <Link className={css.iconBtn} href={href({ view: "calendar", cal, date: step(cal, date, -1) })} aria-label="Earlier"><ChevronLeft size={16} /></Link>
          <h2 className={css.calTitle}>{title}</h2>
          <Link className={css.iconBtn} href={href({ view: "calendar", cal, date: step(cal, date, 1) })} aria-label="Later"><ChevronRight size={16} /></Link>
          {d.today && d.today !== date ? <Link className={css.btn} href={href({ view: "calendar", cal, date: d.today })}>Today</Link> : null}
        </div>
        <div className={css.filters} role="group" aria-label="Channels">{(channels.length ? channels.map((c) => c.key) : CHANNELS).map((c) => <button key={c} type="button" aria-pressed={only.includes(c)}
          onClick={() => setOnly(only.includes(c) ? only.filter((x) => x !== c) : [...only, c])}><ChannelTag c={c} small /></button>)}</div>
      </div>
      {m.error ? <p className={css.error} role="alert">{m.error}</p> : null}
      {cal === "month" ? <div className={css.month7}>
        {DOW_SHORT.map((x) => <span key={x} className={css.dowHead}>{x}</span>)}
        {monthGrid(date).map((day) => { const ps = byDay.get(day) ?? [];
          return <div key={day} className={css.dayCell} data-out={day.slice(0, 7) !== date.slice(0, 7) ? "yes" : undefined} data-today={day === d.today ? "yes" : undefined} data-weekend={dow(day) > 5 ? "yes" : undefined} {...drop(day)}>
            <Link className={css.dayNum} href={href({ view: "calendar", cal: "day", date: day })} aria-label={dayTitle(day)}>{Number(day.slice(8))}</Link>
            {ps.slice(0, 3).map((p) => <Chip key={p.id} p={p} a={assets.get(p.assetId ?? "")} href={kit(p)} compact onDrag={m.setDragging} />)}
            {ps.length > 3 ? <Link className={css.more} href={href({ view: "calendar", cal: "day", date: day })}>+{ps.length - 3} more</Link> : null}
            {!ps.length ? ghost(day) : null}
          </div>; })}
      </div> : null}
      {cal === "week" ? <div className={css.weekScroll}><div className={css.weekGrid}>
        <span className={css.hourHead} />
        {weekDays(date).map((day) => <Link key={day} href={href({ view: "calendar", cal: "day", date: day })} className={css.dowHead} data-today={day === d.today ? "yes" : undefined}>{dayTitle(day)}</Link>)}
        {HOURS.map((h) => <Row key={h}>
          <span className={css.hourHead}>{String(h).padStart(2, "0")}:00</span>
          {weekDays(date).map((day) => { const ps = (byDay.get(day) ?? []).filter((p) => hourOf(p.time) === h);
            return <div key={day} className={css.hourCell} data-today={day === d.today ? "yes" : undefined} {...drop(day, h)}>
              {ps.map((p) => <Chip key={p.id} p={p} a={assets.get(p.assetId ?? "")} href={kit(p)} compact onDrag={m.setDragging} />)}
              {!ps.length ? ghost(day, h) : null}
            </div>; })}
        </Row>)}
      </div></div> : null}
      {cal === "day" ? <div className={css.dayList}>
        {HOURS.map((h) => { const ps = (byDay.get(date) ?? []).filter((p) => hourOf(p.time) === h); const g = ghost(date, h);
          return <div key={h} className={css.dayHour} data-empty={!ps.length && !g.length ? "yes" : undefined} {...drop(date, h)}>
            <span className={css.hourHead}>{String(h).padStart(2, "0")}:00</span>
            <div className={css.dayHourBody}>{ps.map((p) => <Chip key={p.id} p={p} a={assets.get(p.assetId ?? "")} href={kit(p)} onDrag={m.setDragging} />)}{!ps.length ? g : null}</div>
          </div>; })}
      </div> : null}
      <p className={css.muted}>Drag a post to another day or hour to move it. Times are {d.tz ?? "the brand's time zone"}.</p>
    </section>
  </div>;
}
function Row({ children }: { children: ReactNode }) { return <>{children}</>; }

function TodayPanel({ d, assets, href }: { d: FlowData; assets: Map<string, Asset>; href: (x: Record<string, string>) => string }) {
  const list = todays(d);
  const next = kitPost(d, null);
  const plan = d.today ? rhythm(d.strategy?.channels, d.today) : [];
  return <aside className={`${css.glass} ${css.today}`} aria-label="What to post where today">
    <h2 className={css.h2}><Sparkles size={16} aria-hidden="true" />Today{d.today ? <small className={css.muted}>{dayTitle(d.today)}</small> : null}</h2>
    {list.length ? <ol className={css.todayList}>{list.map((p) => { const a = assets.get(p.assetId ?? ""); const t = thumbOf(a);
      return <li key={p.id}><Link href={href({ view: "kit", post: p.id })} className={css.todayItem} data-stage={p.stage}>
        {t ? <Img id={t} alt="" className={css.todayThumb} /> : <span className={css.todayThumb} />}
        <span><b>{p.time}</b> <ChannelTag c={p.channel} small /><span className={css.todayTitle}>{p.title}</span><span className={css.chipMeta}><StageTag s={p.stage} /><OkTag a={a} /></span></span>
      </Link></li>; })}</ol>
      : <p className={css.muted}>Nothing to post today.{plan.length ? ` The plan says ${plan.map((g) => `${CHANNEL_WORDS[g.channel]} at ${g.time}`).join(", ")}: attach a creative from the Library.` : ""}</p>}
    {next && !list.some((p) => p.id === next.id) ? <Link className={css.nextUp} href={href({ view: "kit", post: next.id })}>
      <small>Next up</small><b>{next.day ? dayTitle(next.day) : ""} · {next.time} · {CHANNEL_WORDS[next.channel]}</b><span>{next.title}</span></Link> : null}
  </aside>;
}

// ------------------------------------------------------------------------------------------------ board
function BoardView({ d, assets, href, adding }: { d: FlowData; assets: Map<string, Asset>; href: (x: Record<string, string>) => string; adding: boolean }) {
  const { busy, error, act, router } = useAct();
  const [dragging, setDragging] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, Stage>>({});
  const posts = d.posts.map((p) => moved[p.id] ? { ...p, stage: moved[p.id] } : p);
  async function moveTo(id: string, to: Stage) {
    const p = d.posts.find((x) => x.id === id);
    if (!p || p.stage === to) return;
    setMoved((m) => ({ ...m, [id]: to }));
    const r = await act(`pr/flow/posts/${id}/move`, { to });
    if (!r) setMoved((m) => { const n = { ...m }; delete n[id]; return n; });
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await act<{ post: Post }>("pr/flow/posts", { brandId: d.brand!.id, title: f.get("title"), channel: f.get("channel"), pillar: f.get("pillar"), stage: "idea" });
    if (r) router.push(href({ view: "board" }));
  }
  return <div className={css.stack}>
    {adding ? <form className={`${css.glass} ${css.form} ${css.rise}`} onSubmit={add} aria-label="New idea">
      <div className={css.formRow}>
        <label className={css.field}><span>The idea</span><input name="title" required maxLength={200} placeholder="What is the post about?" autoFocus /></label>
        <label className={css.field}><span>Channel</span><select name="channel" defaultValue={d.strategy?.channels[0]?.key ?? "linkedin"}>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_WORDS[c]}</option>)}</select></label>
        <label className={css.field}><span>Pillar</span><select name="pillar" defaultValue=""><option value="">None</option>{(d.strategy?.pillars ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>
      </div>
      <div className={css.actions}><button className={css.primaryBtn} disabled={busy}>Add the idea</button><Link className={css.btn} href={href({ view: "board" })}>Cancel</Link></div>
    </form> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.board} aria-label="Board">
      {STAGES.map((s) => { const col = posts.filter((p) => p.stage === s);
        return <section key={s} className={css.col} data-stage={s} aria-label={STAGE_WORDS[s]}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
          onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); setDragging(null); if (id) void moveTo(id, s); }}>
          <header className={css.colHead}><StageTag s={s} /><span className={css.muted}>{col.length}</span></header>
          {col.map((p) => { const a = assets.get(p.assetId ?? ""); const t = thumbOf(a); const n = nextAction(p, okNeeded(a));
            return <article key={p.id} className={css.card} draggable={canDrag(p)} onDragStart={(e) => { e.dataTransfer.setData("text/plain", p.id); setDragging(p.id); }} onDragEnd={() => setDragging(null)}>
              {t ? <Img id={t} alt="" className={css.cardThumb} /> : null}
              <Link href={href({ view: "kit", post: p.id })} className={css.cardTitle}>{p.title}</Link>
              <span className={css.chipMeta}><ChannelTag c={p.channel} small />{p.pillar ? <span>{p.pillar}</span> : null}</span>
              <span className={css.muted}>{p.day ? `${dayTitle(p.day)} · ${p.time}` : "No slot yet"}</span>
              <OkTag a={a} />
              {n.to && n.to !== "posted" && n.to !== "measured" ? <button type="button" className={css.linkBtn} disabled={busy} onClick={() => moveTo(p.id, n.to!)}>{n.label} <ChevronRight size={12} aria-hidden="true" /></button>
                : <Link className={css.linkBtn} href={href({ view: "kit", post: p.id })}>{n.label} <ChevronRight size={12} aria-hidden="true" /></Link>}
            </article>; })}
          {!col.length ? <p className={css.colEmpty}>Drop here</p> : null}
        </section>; })}
    </div>
  </div>;
}

// ------------------------------------------------------------------------------------------------ library
function LibraryView({ d, href, open }: { d: FlowData; href: (x: Record<string, string>) => string; open: string | null }) {
  const [group, setGroup] = useState<string>("");
  const groups = [...new Set(d.assets.map((a) => a.collection).filter(Boolean))];
  const list = d.assets.filter((a) => !group || a.collection === group);
  const shown = open ? d.assets.find((a) => a.id === open) : undefined;
  const used = (a: Asset) => d.posts.filter((p) => p.assetId === a.id);
  return <div className={css.stack}>
    <div className={css.filters} role="group" aria-label="Collections">
      <button type="button" aria-pressed={!group} onClick={() => setGroup("")}>All <small>{d.assets.length}</small></button>
      {groups.map((g) => <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>{g} <small>{d.assets.filter((a) => a.collection === g).length}</small></button>)}
    </div>
    {!d.assets.length ? <p className={css.empty}>No creatives yet.</p> : null}
    <div className={css.gallery}>
      {list.map((a) => { const t = thumbOf(a); const u = used(a);
        return <Link key={a.id} href={href({ view: "library", asset: a.id })} className={`${css.glass} ${css.tile} ${css.rise}`} data-on={a.id === open ? "yes" : undefined}>
          <span className={css.tileImg}>{t ? <Img id={t} alt={a.slides[0]?.alt || a.title} /> : null}
            {a.slides.length > 1 ? <span className={css.badge}><Images size={12} aria-hidden="true" />{a.slides.filter((s) => !s.variant).length} slides</span> : null}
            {a.pdfFileId ? <span className={css.badge} data-pos="left"><FileText size={12} aria-hidden="true" />PDF</span> : null}</span>
          <span className={css.tileBody}><b>{a.title}</b><span className={css.chipMeta}>{a.format ? <span>{a.format}</span> : null}{a.channel ? <ChannelTag c={a.channel} small /> : null}<OkTag a={a} /></span>
            <small className={css.muted}>{u.length ? `On the calendar: ${u.filter((p) => p.day).map((p) => dayTitle(p.day!)).join(", ") || "on the board"}` : "Not planned yet"}</small></span>
        </Link>; })}
    </div>
    {shown ? <AssetDrawer d={d} a={shown} href={href} /> : null}
  </div>;
}

function Copier({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={css.btn} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1800); } catch { setDone(false); } }}>
    {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{done ? "Copied" : label}</button>;
}

function Slides({ a }: { a: Asset }) {
  const [i, setI] = useState(0);
  const slides = a.slides;
  const s = slides[Math.min(i, slides.length - 1)];
  if (!s) return <div className={css.viewer} />;
  return <div className={css.viewerWrap}>
    <div className={css.viewer}><Img id={s.file} alt={s.alt || a.title} className={css.viewerImg} />
      {slides.length > 1 ? <><button type="button" className={css.navL} aria-label="Previous slide" disabled={i === 0} onClick={() => setI(i - 1)}><ChevronLeft size={18} /></button>
        <button type="button" className={css.navR} aria-label="Next slide" disabled={i >= slides.length - 1} onClick={() => setI(i + 1)}><ChevronRight size={18} /></button>
        <span className={css.counter}>{i + 1} / {slides.length}{s.variant === "B" ? " · hook B" : s.variant === "safe" ? " · names nobody" : ""}</span></> : null}
    </div>
    {slides.length > 1 ? <div className={css.strip}>{slides.map((x, k) => <button key={x.file + k} type="button" aria-label={`Slide ${k + 1}`} aria-pressed={k === i} onClick={() => setI(k)}><Img id={x.thumb ?? x.file} alt="" /></button>)}</div> : null}
    <div className={css.actions}>
      <a className={css.btn} href={file(s.file, true)} download><Download size={14} aria-hidden="true" />This image</a>
      {a.pdfFileId ? <a className={css.btn} href={file(a.pdfFileId, true)} download><FileText size={14} aria-hidden="true" />The PDF</a> : null}
      {a.pdfSafeFileId ? <a className={css.btn} href={file(a.pdfSafeFileId, true)} download><FileText size={14} aria-hidden="true" />PDF that names nobody</a> : null}
    </div>
  </div>;
}

function AssetDrawer({ d, a, href }: { d: FlowData; a: Asset; href: (x: Record<string, string>) => string }) {
  const { busy, error, act, router } = useAct();
  const manager = d.brand?.role === "manager";
  const [ch, setCh] = useState<Channel>(a.channel ?? d.strategy?.channels[0]?.key ?? "linkedin");
  async function attach(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await act<{ post: Post }>("pr/flow/posts", { brandId: d.brand!.id, assetId: a.id, day: f.get("day"), time: f.get("time"), channel: ch, stage: manager ? "scheduled" : "draft" });
    if (r?.post) router.push(href({ view: "kit", post: r.post.id }));
  }
  async function ok(e: FormEvent<HTMLFormElement>) { e.preventDefault(); await act(`pr/flow/assets/${a.id}/ok`, { note: new FormData(e.currentTarget).get("note") }); }
  return <div className={css.drawerBack}>
    <aside className={`${css.drawer} ${css.rise}`} role="dialog" aria-label={a.title}>
      <header className={css.drawerHead}><div><small className={css.muted}>{a.collection}{a.size ? ` · ${a.size}` : ""}</small><h2>{a.title}</h2></div>
        <Link className={css.iconBtn} href={href({ view: "library" })} aria-label="Close"><X size={18} /></Link></header>
      <div className={css.drawerBody}>
        <Slides a={a} />
        <div className={css.stack}>
          <OkBox a={a} busy={busy} onOk={ok} canOk={manager || d.brand?.role === "approver"} />
          <section className={css.box}><header className={css.boxHead}><h3>Caption</h3><Copier text={captionToCopy(a.caption, a.hashtags)} label="Copy caption" /></header>
            <pre className={css.caption}>{a.caption}</pre>
            {a.captionSafe ? <details><summary>The version that names nobody</summary><pre className={css.caption}>{a.captionSafe}</pre><Copier text={a.captionSafe} label="Copy this version" /></details> : null}
            {a.hashtags.length ? <div className={css.chips}>{a.hashtags.map((t) => <span key={t} className={css.tag}>{t}</span>)}</div> : null}
          </section>
          <form className={css.box} onSubmit={attach} aria-label="Attach to a slot">
            <h3>Attach to a slot</h3>
            <div className={css.formRow}>
              <label className={css.field}><span>Day</span><input type="date" name="day" required defaultValue={d.today ?? ""} /></label>
              <label className={css.field}><span>Time</span><input type="time" name="time" required defaultValue={bestTime(d.strategy?.channels, ch) ?? "09:00"} key={ch} /></label>
              <label className={css.field}><span>Channel</span><select value={ch} onChange={(e) => setCh(e.target.value as Channel)}>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_WORDS[c]}</option>)}</select></label>
            </div>
            <button className={css.primaryBtn} disabled={busy}><CalendarDays size={14} aria-hidden="true" />Put it on the calendar</button>
            {error ? <span className={css.error} role="alert">{error}</span> : null}
          </form>
          {a.why ? <section className={css.box}><h3>Why this works</h3><p>{a.why}</p></section> : null}
          {a.hooks?.A ? <section className={css.box}><h3>Two hooks to test</h3><p><b>A</b> {a.hooks.A}</p>{a.hooks.B ? <p><b>B</b> {a.hooks.B}</p> : null}{a.hooks.why ? <p className={css.muted}>{a.hooks.why}</p> : null}</section> : null}
          {a.brief?.audience ? <section className={css.box}><h3>For whom</h3><p>{a.brief.audience}</p>{a.brief.goal ? <p className={css.muted}>Aim: {a.brief.goal}</p> : null}{a.brief.kpi ? <p className={css.muted}>Watch: {a.brief.kpi}</p> : null}</section> : null}
          <details className={css.box}><summary>Alt text ({a.slides.length})</summary><ol className={css.alts}>{a.slides.map((s) => <li key={s.file}><b>{s.name}</b> {s.alt}</li>)}</ol></details>
        </div>
      </div>
    </aside>
  </div>;
}

function OkBox({ a, busy, onOk, canOk }: { a: Asset; busy: boolean; onOk: (e: FormEvent<HTMLFormElement>) => void; canOk: boolean }) {
  if (a.okState === "ready") return null;
  if (a.okGivenAt) return <section className={css.okBox} data-given="yes"><Check size={16} aria-hidden="true" /><span><b>OK given.</b> {a.okGivenNote}</span></section>;
  return <section className={css.okBox} data-level={a.okState}>
    <ShieldAlert size={16} aria-hidden="true" />
    <div className={css.stack}>
      <span><b>{a.okState === "needs_ok" ? `Needs ${a.okWho || "their"} OK before posting.` : `Check with ${a.okWho || "them"} first.`}</b> {a.okNote}</span>
      {a.okState === "needs_ok" && canOk ? <form onSubmit={onOk} className={css.inlineForm}><input name="note" required minLength={3} maxLength={500} placeholder='How they said OK, e.g. "on WhatsApp, 8 Nov"' aria-label="How they gave their OK" />
        <button className={css.btn} disabled={busy}>Record the OK</button></form> : null}
    </div>
  </section>;
}

// ------------------------------------------------------------------------------------------------ post kit
function KitView({ d, assets, href, post }: { d: FlowData; assets: Map<string, Asset>; href: (x: Record<string, string>) => string; post: string | null }) {
  const p = kitPost(d, post);
  const { busy, error, act } = useAct();
  if (!p) return <section className={`${css.glass} ${css.emptyHero}`}><Send size={28} aria-hidden="true" /><h2>Nothing to post yet</h2>
    <p>Put a creative on the calendar from the Library, and its post kit opens here.</p><Link className={css.primaryBtn} href={href({ view: "library" })}>Open the Library</Link></section>;
  const a = assets.get(p.assetId ?? "");
  const tags = a?.hashtags ?? [];
  const caption = p.caption || a?.caption || "";
  const n = nextAction(p, okNeeded(a));
  const best = bestTime(d.strategy?.channels, p.channel);
  const upcoming = d.posts.filter((x) => x.id !== p.id && x.day && x.day >= (d.today ?? "") && x.stage !== "posted" && x.stage !== "measured")
    .sort((x, y) => `${x.day} ${x.time}`.localeCompare(`${y.day} ${y.time}`)).slice(0, 4);
  async function posted(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const url = String(new FormData(e.currentTarget).get("url") ?? "").trim(); await act(`pr/flow/posts/${p!.id}/move`, { to: "posted", url: url || null }); }
  async function measured(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await act(`pr/flow/posts/${p!.id}/move`, { to: "measured", metrics: Object.fromEntries(["impressions", "reactions", "comments", "shares", "saves", "clicks"].map((k) => [k, f.get(k)])) });
  }
  async function reschedule(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget); await act(`pr/flow/posts/${p!.id}`, { day: f.get("day"), time: f.get("time") }); }
  return <div className={css.kit}>
    <section className={`${css.glass} ${css.kitPreview}`} aria-label="The creative">{a ? <Slides a={a} /> : <p className={css.empty}>No creative attached. Pick one in the <Link href={href({ view: "library" })}>Library</Link>.</p>}</section>
    <section className={`${css.glass} ${css.kitPanel} ${css.rise}`} aria-label="Ready to post">
      <header className={css.kitHead}><StageTag s={p.stage} /><OkTag a={a} /><h2>{p.title}</h2></header>
      <div className={css.where}>
        <ChannelTag c={p.channel} />
        <span><CalendarDays size={14} aria-hidden="true" />{p.day ? dayTitle(p.day) : "No day yet"}</span>
        <span><Clock size={14} aria-hidden="true" />{p.time ?? "No time yet"}{best && p.time !== best ? <small className={css.muted}> · best {best}</small> : null}</span>
        {p.pillar ? <span className={css.tag}>{d.strategy?.pillars.find((x) => x.key === p.pillar)?.name ?? p.pillar}</span> : null}
      </div>
      {okNeeded(a) ? <OkBox a={a!} busy={busy} canOk={d.brand?.role === "manager" || d.brand?.role === "approver"} onOk={async (e) => { e.preventDefault(); await act(`pr/flow/assets/${a!.id}/ok`, { note: new FormData(e.currentTarget).get("note") }); }} /> : a ? <OkBox a={a} busy={busy} canOk={false} onOk={() => {}} /> : null}
      <div className={css.box}><header className={css.boxHead}><h3>1 · Caption</h3><Copier text={captionToCopy(caption, tags)} label="Copy caption" /></header>
        <pre className={css.caption}>{caption || "No caption yet."}</pre>
        {tags.length ? <div className={css.chips}>{tags.map((t) => <span key={t} className={css.tag}>{t}</span>)}</div> : null}</div>
      <div className={css.box}><h3>2 · {p.channel === "linkedin" && a?.pdfFileId ? "Upload the PDF as a document post" : "Download the image"}</h3>
        <div className={css.actions}>{a?.pdfFileId && p.channel === "linkedin" ? <a className={css.btn} href={file(a.pdfFileId, true)} download><FileText size={14} aria-hidden="true" />Download the PDF</a> : null}
          {a?.slides[0] ? <a className={css.btn} href={file(a.slides[0].file, true)} download><Download size={14} aria-hidden="true" />{a.slides.length > 1 ? "Download the first slide" : "Download the image"}</a> : null}</div></div>
      <div className={css.box}><h3>3 · {p.stage === "posted" || p.stage === "measured" ? "Posted" : "Post it, then mark it posted"}</h3>
        {p.stage === "posted" || p.stage === "measured" ? <p>{p.postedUrl ? <a href={p.postedUrl} target="_blank" rel="noreferrer">Open the post <ExternalLink size={12} aria-hidden="true" /></a> : "Posted."}{p.postedDay ? ` ${dayTitle(p.postedDay)}.` : ""}</p>
          : n.to === "posted" ? <form onSubmit={posted} className={css.inlineForm}><input name="url" type="url" pattern="https://.*" placeholder="The post's link (https://…)" aria-label="The post's link" />
            <button className={css.primaryBtn} disabled={busy}><Check size={14} aria-hidden="true" />Mark posted</button></form>
          : n.to ? <button type="button" className={css.primaryBtn} disabled={busy} onClick={() => act(`pr/flow/posts/${p.id}/move`, { to: n.to })}>{n.label}</button>
          : <p className={css.muted}>{n.label}.</p>}
      </div>
      {p.stage === "posted" || p.stage === "measured" ? <form className={css.box} onSubmit={measured} aria-label="The numbers">
        <h3>4 · The numbers {p.measuredAt ? <small className={css.muted}>last logged</small> : null}</h3>
        <div className={css.metricGrid}>{(["impressions", "reactions", "comments", "shares", "saves", "clicks"] as const).map((k) => <label key={k} className={css.field}><span>{k[0].toUpperCase() + k.slice(1)}</span>
          <input name={k} type="number" min={0} inputMode="numeric" defaultValue={p.metrics?.[k] ?? ""} /></label>)}</div>
        <button className={p.stage === "posted" ? css.primaryBtn : css.btn} disabled={busy}>Save the numbers</button>
      </form> : <details className={css.box}><summary>Move it to another day or time</summary>
        <form onSubmit={reschedule} className={css.inlineForm}><input type="date" name="day" required defaultValue={p.day ?? d.today ?? ""} aria-label="Day" /><input type="time" name="time" required defaultValue={p.time ?? best ?? "09:00"} aria-label="Time" />
          <button className={css.btn} disabled={busy}>Move</button></form></details>}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      {upcoming.length ? <div className={css.upNext}><h3 className={css.h3}>Up next</h3>{upcoming.map((x) => <Link key={x.id} href={href({ view: "kit", post: x.id })}><b>{dayTitle(x.day!)} · {x.time}</b> <ChannelTag c={x.channel} small /> {x.title}</Link>)}</div> : null}
    </section>
  </div>;
}

// ------------------------------------------------------------------------------------------------ insights
function InsightsView({ d, assets, href }: { d: FlowData; assets: Map<string, Asset>; href: (x: Record<string, string>) => string }) {
  const s = d.insights;
  if (!s) return null;
  const thisWeek = s.weeks.filter((w) => w.started).at(-1);
  const max = Math.max(1, s.plan, ...s.weeks.map((w) => Math.max(w.planned, w.posted)));
  return <div className={css.stack}>
    <div className={css.tiles}>
      <article className={`${css.glass} ${css.tileStat} ${css.rise}`}><small>This week</small><b>{thisWeek?.posted ?? 0}<span> / {s.plan || "–"}</span></b><span className={css.muted}>posted of the plan</span></article>
      <article className={`${css.glass} ${css.tileStat} ${css.rise}`} data-lit={s.streak ? "yes" : undefined}><small>On plan</small><b><Flame size={22} aria-hidden="true" />{s.streak}</b><span className={css.muted}>{s.streak === 1 ? "week" : "weeks"} in a row</span></article>
      <article className={`${css.glass} ${css.tileStat} ${css.rise}`}><small>Last 28 days</small><b>{num(s.last28.posted)}</b><span className={css.muted}>posts out</span></article>
      <article className={`${css.glass} ${css.tileStat} ${css.rise}`}><small>Impressions a post</small><b>{s.last28.measured ? num(Math.round(s.last28.impressions / s.last28.measured)) : "–"}</b><span className={css.muted}>{num(s.last28.measured)} measured</span></article>
    </div>
    <section className={`${css.glass} ${css.pad}`} aria-label="Posts a week against the plan">
      <h2 className={css.h2}>Posts a week against the plan</h2>
      <div className={css.bars} role="img" aria-label={s.weeks.map((w) => `${weekTitle(w.week)}: ${w.posted} posted, ${w.planned} planned`).join("; ")}>
        {s.plan ? <span className={css.planLine} style={{ bottom: `${(s.plan / max) * 100}%` }}><small>Plan {s.plan}</small></span> : null}
        {s.weeks.map((w) => <div key={w.week} className={css.barCol} data-future={w.started ? undefined : "yes"}>
          <span className={css.barPlanned} style={{ height: `${(w.planned / max) * 100}%` }} />
          <span className={css.barPosted} style={{ height: `${(w.posted / max) * 100}%` }} />
          <small>{Number(w.week.slice(8))}/{Number(w.week.slice(5, 7))}</small>
        </div>)}
      </div>
      <p className={css.legend}><span data-k="posted" />Posted <span data-k="planned" />Planned</p>
    </section>
    <div className={css.two}>
      <section className={`${css.glass} ${css.pad}`} aria-label="KPIs against targets">
        <h2 className={css.h2}>KPIs against targets</h2>
        {s.kpis.length ? <ul className={css.meters}>{s.kpis.map((k) => { const pct = k.target ? Math.min(100, Math.round(((k.actual ?? 0) / k.target) * 100)) : 0;
          return <li key={k.label}><span>{k.label}</span><b>{num(k.actual ?? 0)} <small>/ {num(k.target)}</small></b><span className={css.meter}><span style={{ width: `${pct}%` }} /></span></li>; })}</ul>
          : <p className={css.muted}>Add what you measure in the <Link href={href({ view: "strategy", edit: "1" })}>strategy</Link>.</p>}
        <p className={css.muted}>Goals live in <Link href="/goals">Goals</Link>.</p>
      </section>
      <section className={`${css.glass} ${css.pad}`} aria-label="Top posts">
        <h2 className={css.h2}>Top posts</h2>
        {s.top.length ? <ol className={css.topList}>{s.top.map((t) => { const a = assets.get(t.assetId ?? ""); const th = thumbOf(a);
          return <li key={t.id}><Link href={href({ view: "kit", post: t.id })}>{th ? <Img id={th} alt="" className={css.todayThumb} /> : null}<span><b>{t.title}</b>
            <span className={css.chipMeta}><ChannelTag c={t.channel} small /><span>{num(t.metrics.impressions ?? 0)} seen</span><span>{num(t.metrics.reactions ?? 0)} reactions</span><span>{num(t.metrics.comments ?? 0)} comments</span></span></span></Link></li>; })}</ol>
          : <p className={css.muted}>Nothing posted yet. Mark a post posted from its post kit, then log its numbers.</p>}
      </section>
    </div>
    <section className={`${css.glass} ${css.pad}`} aria-label="By channel"><h2 className={css.h2}>By channel</h2>
      <table className={css.table}><thead><tr><th>Channel</th><th>Planned</th><th>Posted</th></tr></thead><tbody>{s.byChannel.map((c) => <tr key={c.channel}><td><ChannelTag c={c.channel} /></td><td>{c.planned}</td><td>{c.posted}</td></tr>)}</tbody></table>
    </section>
  </div>;
}
