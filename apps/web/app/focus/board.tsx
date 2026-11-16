"use client";
// FOCUS (owner, 7 Nov 2026), redone by UX-GAMIFY (owner, 9 Nov 2026: "the cards row stops short, the plans table runs
// off the right edge, the page touches the sidebar, every account says No reading"). Built on the game-feel kit, after
// Codex's concepts (reports/ux-gamify/concepts/focus: 1 on a computer, 3 on a phone):
//   - a header with the day's ring (work done today), the streak and the one main button, Save today's plan;
//   - each AI plan as a fuel gauge (what is LEFT of its 5-hour window, the week and the refill under it), in a row that
//     always fills the page (a strip that scrolls inside its own box on a phone); paid credit and cloud as tiles;
//   - today's plan as a quest list: run now (tick work you added yourself when it is done), done today, waiting for a
//     refill, blocked on you;
//   - a quiet rail: running low, refills next, and whether the collector is sending.
// An account the collector cannot read shows "Update" (a short form in a drawer), never "No reading".
// PULSE-POLISH (owner, 14 Nov 2026): one next step and why first, at most two more, the rest folded; one privacy note.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { AlertTriangle, BatteryLow, Check, Plus, Cloud, CreditCard, Gauge, Hourglass, Lock, PlugZap, RefreshCw, Save, Settings as Cog, Swords } from "lucide-react";
import { Drawer, DrawerFooter, Segmented, Switch } from "../kit";
import { Disclosure } from "../kit/disclosure";
import { DateField } from "../kit/date-field";
import { ActionButton, Chip, EmptyState, FuelGauge, GameCard, GamePage, PageHeader, Quest, QuestList, SegmentedTabs, gameCss, toast } from "../kit/game";
import { streakOf } from "../lib/game.mjs";
import { age, focusPost as postTo, NEED, resetsIn, used, type Account, type Board, type Company } from "./model";
import css from "./board.module.css";

type Tab = "today" | "settings";
/** SETTINGS-APPLE (T1.4.2): where this board's changes go: "focus" in the company that has Focus, "account/focus" from any
 *  other company the person works in (the same Focus, read and changed without switching company). */
const FocusBase = createContext("focus");
function useFocusPost() {
  const base = useContext(FocusBase);
  return useCallback(<T = { ok: true },>(path: string, body?: unknown) => postTo<T>(path.replace(/^focus(?=\/|$)/, base), body), [base]);
}
/** One company's part of the board: its work, its plan, and the AI accounts that serve it (or any company). */
function onlyCompany(b: Board, key: string): Board {
  const serves = (a: Account) => a.ownCompany === key || a.companies.includes(key) || a.urgentOnly.includes(key) || !a.companies.length;
  const mine = <T extends { company: string }>(list: T[]) => list.filter((x) => x.company === key);
  return { ...b, accounts: b.accounts.filter(serves), lanes: mine(b.lanes), burn: mine(b.burn),
    plan: { ...b.plan, placed: mine(b.plan.placed), waiting: mine(b.plan.waiting), blocked: mine(b.plan.blocked) } };
}
const hueOf = (companies: Company[], key: string | null) => companies.find((c) => c.key === key)?.hue ?? 260;
const colorOf = (companies: Company[], key: string | null) => `hsl(${hueOf(companies, key)} 62% 52%)`;
const nameOf = (companies: Company[], key: string) => companies.find((c) => c.key === key)?.name.split(" /")[0] ?? key;
/** The company's own date for a moment (YYYY-MM-DD). */
const dayIn = (at: string | number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
const left = (a: Account, win: "5h" | "7d", now: number) => { const u = used(a.latest?.[win], now); return u === null ? null : Math.max(0, 100 - u); };
/** True when the newest reading is over 30 minutes old (an account never read has no reading to be old). */
const stale = (a: Account, now: number) => { const at = [a.latest?.["5h"]?.at, a.latest?.["7d"]?.at, a.latest?.balance?.at].filter(Boolean).sort().pop(); return !!at && age(at, now).stale; };
/** Work a person added here can be ticked; work the collector sends (a lane) finishes on its own. */
const ownWork = (key: string) => key.startsWith("w-");

export function FocusBoard({ board: all, base = "focus" }: { board: Board; base?: string }) {
  return <FocusBase.Provider value={base}><Focus all={all} /></FocusBase.Provider>;
}

function Focus({ all }: { all: Board }) {
  const router = useRouter();
  const focusPost = useFocusPost();
  // SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2): opened in another company, Focus shows that company's part first; every
  // company is one labelled switch away. In the Focus company itself it is every company (its home).
  const here = all.here ?? null;
  const [scope, setScope] = useState<"company" | "all">(here?.key ? "company" : "all");
  const board = scope === "company" && here?.key ? onlyCompany(all, here.key) : all;
  const [tab, setTab] = useState<Tab>("today");
  const [logging, setLogging] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const now = Date.parse(board.now), zone = board.zone ?? "UTC", today = dayIn(now, zone);
  const done = board.lanes.filter((l) => l.status === "done");
  const doneToday = done.filter((l) => dayIn(l.updatedAt, zone) === today);
  const streak = streakOf(done.map((l) => dayIn(l.updatedAt, zone)), today).days;
  const save = async () => {
    setSaving(true);
    try { await focusPost("focus/plan"); toast(board.sent ? "Today's plan is saved again." : "Today's plan is saved. Telegram gets it when your chat is linked."); router.refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : "Not saved. Try again.", { tone: "bad" }); } finally { setSaving(false); }
  };
  return <GamePage label="Focus">
    {/* PULSE-POLISH (owner, 14 Nov 2026: "Focus is showing a lot of things, 'Only you see this' and all — I don't know
        what to do with it"): the page leads with ONE next step and why, then at most two more; everything else is folded
        below; "only you see this" is said once, in a small note at the foot, not in the header. */}
    <div className={css.header}><PageHeader eyebrow={here && scope === "company" ? here.name : "All my companies"} title="Focus"
      subtitle="What to run next on your AI accounts, and why." /></div>
    {/* SETTINGS-APPLE (judge: "two toggle rows stacked"): which company's part and Today / Settings share one row. */}
    <div className={css.controls}>
      {here ? <div className={css.scope}><Segmented label="Show" size="sm" value={scope} onChange={setScope} options={[
        { value: "company", label: here.name, disabled: !here.key, hint: here.key ? undefined : `${here.name} is not one of Focus's companies yet` },
        { value: "all", label: "All my companies" }]} />
        {here.key ? null : <small>{here.name} is not one of Focus&apos;s companies yet, so this shows all of them.</small>}</div> : null}
      <SegmentedTabs label="Focus" value={tab} onChange={setTab} options={[
        { value: "today", label: "Today", icon: Swords },
        // PULSE-POLISH (judge: a "Settings" tab here read as a second Settings page): Focus's own accounts and sharing.
        { value: "settings", label: "Set up", icon: Cog }]} />
    </div>
    {tab === "today" ? <Today board={board} now={now} doneToday={doneToday} streak={streak} onLog={setLogging} saving={saving} onSave={save} /> : <SettingsView board={board} />}
    <p className={css.privacy}><Lock size={13} aria-hidden="true" />Only you can see Focus. Nobody in your companies can open it.</p>
    {logging ? <LogReading a={logging} now={now} onClose={() => setLogging(null)} /> : null}
  </GamePage>;
}

type Item = { key: string; kind: "run" | "blocked" | "wait"; title: string; sub: string; color: string; lane?: string };
/** Today's open work in the order to do it: the work placed on an account, then what needs you, then what waits. */
function itemsOf(board: Board, now: number): Item[] {
  const p = board.plan;
  return [
    ...p.placed.map((x): Item => ({ key: x.lane, kind: "run", title: x.title, lane: x.lane, color: colorOf(board.companies, x.company), sub: `Run it on ${x.accountName}` })),
    ...p.blocked.map((b): Item => ({ key: `b:${b.blocker}`, kind: "blocked", title: b.blocker, color: "#E11D48",
      sub: `Needs you. It holds ${b.lanes.length} ${b.lanes.length === 1 ? "piece of work" : "pieces of work"} for ${nameOf(board.companies, b.company)}.` })),
    ...p.waiting.map((x): Item => ({ key: x.lane, kind: "wait", title: x.title, color: "#D97706",
      sub: x.until ? `Waits for an account to refill, in ${resetsIn(x.until, now) ?? "a moment"}` : plainWait(x.reason) })),
  ];
}
/** The allocator's reason for waiting, in plain words. */
const plainWait = (reason: string) => reason === "No account may do this work" ? "No AI account is set to do this company's work" : reason.replace(/^No reading yet for/, "Type what is left on").replace(/^No room left this week$/, "Every account is full this week");

/** Why the next step is the next step, in one plain sentence (no scores). */
function whyNext(board: Board, x: Board["plan"]["placed"][number], now: number) {
  const lane = board.lanes.find((l) => l.key === x.lane);
  const a = board.accounts.find((y) => y.key === x.account);
  const company = nameOf(board.companies, x.company);
  const first = lane?.urgent ? `It is urgent work for ${company}` : lane?.dueOn ? `It is ${company}'s most important work, due ${new Date(`${lane.dueOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}` : `It is ${company}'s most important work today`;
  if (!a) return `${first}.`;
  if (a.cost === "metered" || a.kind !== "ai") return `${first}, and ${a.name} is paid credit that still has money on it.`;
  const l = left(a, "5h", now) ?? left(a, "7d", now);
  const refill = resetsIn(a.latest?.["5h"]?.resetsAt, now);
  const room = l === null ? "room" : l >= 60 ? "plenty of use left" : l >= 30 ? "some use left" : "a little use left";
  return `${first}, and ${a.name} has ${room}${refill ? ` before it refills in ${refill}` : ""}.`;
}

function Today({ board, now, doneToday, streak, onLog, saving, onSave }: { board: Board; now: number; doneToday: Board["lanes"]; streak: number; onLog: (a: Account) => void; saving: boolean; onSave: () => void }) {
  const focusPost = useFocusPost();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const ai = board.accounts.filter((a) => a.kind === "ai"), paid = board.accounts.filter((a) => a.kind !== "ai");
  const items = itemsOf(board, now);
  const next = board.plan.placed[0];
  const top = next ? items[0]! : items[0] ?? null;
  const also = items.slice(1, 3), rest = items.slice(3);
  const mark = async (key: string, title: string, to: "done" | "ready") => {
    try {
      await focusPost(`focus/lanes/${key}`, { status: to }); router.refresh();
      if (to === "done") toast(`Done: ${title}`, { undo: async () => { await focusPost(`focus/lanes/${key}`, { status: "ready" }); router.refresh(); } });
    } catch (e) { toast(e instanceof Error ? e.message : "Not saved. Try again.", { tone: "bad" }); }
  };
  const low = ai.map((a) => left(a, "5h", now) ?? left(a, "7d", now)).filter((l): l is number => l !== null && l <= board.settings.reserve5h + 15).length;
  const s = board.settings, at = s.ingestAt ? age(s.ingestAt, now) : null;
  const reading = at && !at.stale ? "Sending" : s.hasKey ? "Waiting" : "Not set up";
  return <>
    {top ? <section className={css.next} data-kind={top.kind} aria-label="Do this next" style={{ "--next": top.color } as CSSProperties}>
      <p className={css.nextKicker}>{top.kind === "blocked" ? "Clear this first" : top.kind === "wait" ? "Next, when it can start" : "Do this next"}</p>
      <h2 className={css.nextTitle}>{top.title}</h2>
      <p className={css.nextHow}>{top.sub}{top.kind === "run" && top.lane && ownWork(top.lane) ? ", then tick it off here." : ""}</p>
      {next && top.kind === "run" ? <p className={css.nextWhy}><b>Why:</b> {whyNext(board, next, now)}</p> : null}
      {top.kind === "run" && top.lane && ownWork(top.lane) ? <div><ActionButton primary action={{ label: "Mark done", icon: Check, onClick: () => void mark(top.lane!, top.title, "done") }} /></div>
        : top.kind === "run" ? <p className={css.nextNote}>It is ticked off by itself when the work is finished.</p> : null}
    </section> : <EmptyState art="nothing" title="Nothing to run right now" text="Add a piece of work, and Focus picks the AI account for it." action={{ label: "Add work", icon: Plus, onClick: () => setAdding(true) }} />}
    {also.length ? <section aria-label="Also today" className={css.also}>
      <h2 className={css.alsoHead}>Also today</h2>
      <QuestList label="Also today">{also.map((x) => <ItemRow key={x.key} x={x} onMark={mark} />)}</QuestList>
    </section> : null}
    <div className={css.folds}>
      <Disclosure summary={`Everything else today`} hint={`${rest.length + doneToday.length ? `${rest.length} more${doneToday.length ? ` · ${doneToday.length} done` : ""}` : "Nothing else"}${streak > 1 ? ` · ${streak}-day streak` : ""}`}>
        {rest.length || doneToday.length ? <QuestList label="Everything else today">
          {rest.map((x) => <ItemRow key={x.key} x={x} onMark={mark} />)}
          {doneToday.map((l) => <Quest key={l.key} state="done" color={colorOf(board.companies, l.company)} title={l.title} sub={nameOf(board.companies, l.company)}
            onToggle={ownWork(l.key) ? (d) => void mark(l.key, l.title, d ? "done" : "ready") : undefined} toggleLabel={`Not done yet: ${l.title}`} />)}
        </QuestList> : <p className={css.quiet}>Nothing else is planned for today.</p>}
        <div className={css.foldActions}>
          {top ? <ActionButton small action={{ label: "Add work", icon: Plus, onClick: () => setAdding(true) }} /> : null}
          <ActionButton small action={{ label: saving ? "Saving…" : board.sent ? "Send today's plan again" : "Save and send today's plan", icon: Save, onClick: onSave, busy: saving }} />
        </div>
      </Disclosure>
      <Disclosure summary="AI accounts" hint={`${board.accounts.length} ${board.accounts.length === 1 ? "account" : "accounts"}${low ? ` · ${low} running low` : ""}`}>
        <section aria-label="AI plans" className={css.gauges}>
          {ai.map((a) => <GaugeCard key={a.key} a={a} board={board} now={now} onLog={onLog} />)}
        </section>
        {paid.length ? <section aria-label="Paid credit and cloud" className={css.paid}>
          {paid.map((a) => <PaidTile key={a.key} a={a} now={now} onLog={onLog} />)}
        </section> : null}
        <p className={css.quiet}><PlugZap size={13} aria-hidden="true" /> {at ? `Readings arrive by themselves: the last one came ${at.text}.` : s.hasKey ? "Connected. The first reading comes within 5 minutes." : "Readings do not arrive by themselves yet: connect them in Settings."} For accounts it cannot read, type what their app shows.</p>
      </Disclosure>
      <Disclosure summary="AI use this week, by company" hint={reading === "Sending" ? undefined : reading === "Waiting" ? "Waiting for the first reading" : "Not read by itself yet"}>
        <p className={css.quiet}>The line on each bar is today&apos;s plan: your split, adjusted for deadlines.</p>
        <Burn board={board} />
      </Disclosure>
    </div>
    {adding ? <AddWork board={board} onClose={() => setAdding(false)} /> : null}
  </>;
}

function ItemRow({ x, onMark }: { x: Item; onMark: (key: string, title: string, to: "done" | "ready") => void }) {
  if (x.kind === "blocked") return <Quest state="blocked" icon={Lock} color={x.color} title={x.title} sub={x.sub} end={<Chip tone="bad">Needs you</Chip>} />;
  if (x.kind === "wait") return <Quest state="wait" icon={Hourglass} color={x.color} title={x.title} sub={x.sub} end={<Chip tone="warn">Waiting</Chip>} />;
  return <Quest color={x.color} title={x.title} sub={x.sub} onToggle={x.lane && ownWork(x.lane) ? (d) => onMark(x.lane!, x.title, d ? "done" : "ready") : undefined} toggleLabel={`Mark done: ${x.title}`} />;
}

function Freshness({ a, now }: { a: Account; now: number }) {
  const wins = [a.latest?.["5h"], a.latest?.["7d"], a.latest?.balance].filter((w) => !!w?.at);
  const last = wins.map((w) => w!.at).sort().pop() ?? null;
  if (!last) return null;
  const f = age(last, now);
  const typed = wins.some((w) => w!.at === last && w!.source === "manual");
  return <span className={css.fresh} data-stale={f.stale ? "" : undefined} title={typed ? "Typed by you" : "Read by itself"}>{f.stale ? <><AlertTriangle size={13} aria-hidden="true" />Old reading ({f.text})</> : `Updated ${f.text}`}</span>;
}

function GaugeCard({ a, board, now, onLog }: { a: Account; board: Board; now: number; onLog: (a: Account) => void }) {
  const h5 = left(a, "5h", now), d7 = left(a, "7d", now);
  const refill = resetsIn(a.latest?.["5h"]?.resetsAt, now) ?? resetsIn(a.latest?.["7d"]?.resetsAt, now);
  const serves = a.companies.slice(0, 2), more = a.companies.length - serves.length;
  const unread = h5 === null && d7 === null, weekOnly = h5 === null && d7 !== null;
  return <article className={css.gaugeCard} data-status={a.status} aria-label={a.name}>
    <header className={css.gaugeHead}>
      <b>{a.name}</b>
      {a.status === "limited" ? <Chip tone="bad">At limit</Chip> : a.status === "off" ? <Chip>Off</Chip> : null}
    </header>
    <div className={css.serves}>{serves.length ? serves.map((k) => <span key={k} className={css.company} style={{ "--hue": hueOf(board.companies, k) } as CSSProperties}>{nameOf(board.companies, k)}</span>)
      : <span className={css.company}>Any company</span>}{more > 0 ? <span className={css.company}>+{more}</span> : null}</div>
    <FuelGauge left={weekOnly ? d7 : h5} reserve={weekOnly ? board.settings.reserve7d : board.settings.reserve5h} label={`${a.name}, ${weekOnly ? "this week" : "left now"}`}
      missing="Not read yet" stale={stale(a, now) ? " " : false} sub={unread ? "Type what its app shows" : weekOnly ? "this week" : "left now"} size={156} />
    <dl className={css.gaugeFacts}>
      <div><dt>{weekOnly ? "Now" : "This week"}</dt><dd>{weekOnly ? "No reading yet" : d7 !== null ? `${Math.round(d7)}% left` : "No reading yet"}</dd></div>
      <div><dt><RefreshCw size={12} aria-hidden="true" />Refills in</dt><dd>{refill ?? "Not known yet"}</dd></div>
    </dl>
    <footer className={css.gaugeFoot}>
      <Freshness a={a} now={now} />
      <ActionButton small action={{ label: "Update", onClick: () => onLog(a) }} />
    </footer>
  </article>;
}

function PaidTile({ a, now, onLog }: { a: Account; now: number; onLog: (a: Account) => void }) {
  const bal = a.latest?.balance;
  const Icon = a.kind === "cloud" ? Cloud : CreditCard;
  const money = bal?.amount !== null && bal?.amount !== undefined ? `${!bal.currency || bal.currency === "USD" ? "US$" : `${bal.currency} `}${Number(bal.amount).toFixed(2)}` : null;
  return <article className={css.paidTile} aria-label={a.name}>
    <span className={css.paidIcon} aria-hidden="true"><Icon size={18} /></span>
    <span className={css.paidText}><small>{a.name}</small>{money ? <b className={gameCss.num}>{money}{a.kind === "cloud" ? "" : " left"}</b> : <b className={css.paidNone}>Not read yet</b>}
      <Freshness a={a} now={now} /></span>
    <ActionButton small action={{ label: "Update", onClick: () => onLog(a) }} />
  </article>;
}

function Burn({ board }: { board: Board }) {
  // The rises in "% used" of each 5-hour window this week, per company: 100 is one full window.
  const totals = board.burn.map((b) => ({ company: b.company, used: b.hours.reduce((s, x) => s + x, 0) })).filter((x) => x.used > 0).sort((a, b) => b.used - a.used);
  const all = totals.reduce((s, x) => s + x.used, 0);
  if (!all) return <EmptyState art="nothing" title="No use to show yet" text="This fills in after the second automatic reading." />;
  return <ul className={css.useBars} aria-label="Share of this week's AI use, per company">{totals.map((t) => {
    const pct = Math.round((t.used / all) * 100);
    const target = board.plan.weights.find((w) => w.key === t.company)?.today ?? null;
    const gap = target === null ? null : pct - target;
    return <li key={t.company} style={{ "--hue": hueOf(board.companies, t.company) } as CSSProperties} data-over={gap !== null && gap > 3 ? "" : undefined}>
      <span className={css.useName}>{nameOf(board.companies, t.company)}</span>
      <span className={css.useBar} aria-hidden="true"><i style={{ width: `${Math.max(2, pct)}%` }} />{target !== null ? <em style={{ left: `${target}%` }} title="Plan"><span>plan</span></em> : null}</span>
      <b className={gameCss.num}>{pct}%</b>
      <small data-tone={gap === null || Math.abs(gap) <= 3 ? undefined : gap > 0 ? "over" : "under"}>{target === null ? `${pct}% of this week's use` : gap === null || Math.abs(gap) <= 3 ? `On plan (${pct}%)` : `Used ${pct}% · plan ${target}%`}</small>
    </li>;
  })}</ul>;
}

/** Log a reading by hand: what the account's own page shows, as "% left" (the gauge's words). */
function LogReading({ a, onClose, now }: { a: Account; onClose: () => void; /** The board's moment (render stays pure). */ now: number }) {
  const focusPost = useFocusPost();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = a.cost === "metered" || a.kind !== "ai";
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setError(null);
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const usedOf = (k: string) => v(k) === "" ? "" : String(100 - Math.max(0, Math.min(100, Number(v(k)))));
    const at = (k: string, unit: number) => v(k) ? new Date(Date.now() + Number(v(k)) * unit).toISOString() : "";
    try {
      if (v("status") !== a.status) await focusPost(`focus/accounts/${a.key}`, { status: v("status") });
      if (v("left5h") || v("left7d") || v("balance"))
        await focusPost(`focus/accounts/${a.key}/reading`, { used5h: usedOf("left5h"), resets5h: at("in5h", 3600_000), used7d: usedOf("left7d"), resets7d: at("in7d", 86_400_000), balance: v("balance") });
      toast(`Reading saved for ${a.name}.`); onClose(); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Not saved. Try again."); } finally { setBusy(false); }
  };
  const l5 = left(a, "5h", now), l7 = left(a, "7d", now);
  const inH = (at: string | null | undefined) => { const ms = at ? Date.parse(at) - now : NaN; return Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 360_000) / 10) : undefined; };
  const inD = (at: string | null | undefined) => { const ms = at ? Date.parse(at) - now : NaN; return Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 8_640_000) / 10) : undefined; };
  return <Drawer title={`What is left on ${a.name}`} context={money ? `Type what ${a.name}'s billing page shows.` : `Open ${a.name}'s usage page and type what it shows. The last reading is filled in.`} size="sm" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="submit" form="focus-log" className={gameCss.primary} disabled={busy}>{busy ? "Saving…" : "Save"}</button>} />}>
    <form id="focus-log" className={css.logForm} onSubmit={save}>
      {money ? <label>Money left ($)<input name="balance" inputMode="decimal" placeholder="e.g. 18.40" /></label> : <>
        <label>How much is left now? (%)<input name="left5h" inputMode="numeric" placeholder="0 to 100" defaultValue={l5 === null ? undefined : Math.round(l5)} /><small className={css.hint}>It resets every 5 hours.</small></label>
        <label>Hours until it refills<input name="in5h" inputMode="decimal" placeholder="e.g. 2" defaultValue={inH(a.latest?.["5h"]?.resetsAt)} /></label>
        <label>This week left (%) · optional<input name="left7d" inputMode="numeric" placeholder="Leave empty if you do not know" defaultValue={l7 === null ? undefined : Math.round(l7)} /></label>
        <label>The week refills in (days) · optional<input name="in7d" inputMode="decimal" placeholder="Leave empty if you do not know" defaultValue={inD(a.latest?.["7d"]?.resetsAt)} /></label>
      </>}
      <label>Can it take work now?<select name="status" defaultValue={a.status}><option value="ok">Yes, it is working</option><option value="limited">No, it is at its limit</option><option value="off">No, it is switched off</option></select></label>
    </form>
  </Drawer>;
}

/** Add work to the plan (Today's quests), in a drawer: the one main button is its Add. */
function AddWork({ board, onClose }: { board: Board; onClose: () => void }) {
  const focusPost = useFocusPost();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addWork = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null);
    void focusPost("focus/lanes", { title: f.get("title"), company: f.get("company"), size: f.get("size"), need: f.get("need"), value: Number(f.get("value")),
      dueOn: f.get("dueOn") || null, urgent: f.get("urgent") === "on", blockedBy: f.get("blockedBy") })
      .then(() => { toast("Work added to today's plan."); onClose(); router.refresh(); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Not saved. Try again.")).finally(() => setBusy(false));
  };
  return <Drawer title="Add work" context="It joins today's plan when an account has room for it." size="sm" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="submit" form="focus-add" className={gameCss.primary} disabled={busy}>{busy ? "Adding…" : "Add work"}</button>} />}>
      <form id="focus-add" className={css.fields} onSubmit={addWork}>
        <label className={css.wide}>What<input name="title" required maxLength={160} placeholder="Short name" /></label>
        <label>Company<select name="company">{board.companies.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
        <label>Size<select name="size" defaultValue="M"><option value="S">Small</option><option value="M">Medium</option><option value="L">Large</option><option value="XL">Very large</option></select></label>
        <label>Type of job<select name="need" defaultValue="T2">{Object.entries(NEED).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>How much it matters (1 to 10)<input name="value" type="number" min={1} max={10} defaultValue={5} /></label>
        <label>Due<DateField name="dueOn" aria-label="Due" /></label>
        <label className={css.check}><input name="urgent" type="checkbox" />Urgent</label>
        <label className={css.wide}>Blocked by<input name="blockedBy" maxLength={160} placeholder="Leave empty if it is ready" /></label>
      </form>
  </Drawer>;
}

function SettingsView({ board }: { board: Board }) {
  const focusPost = useFocusPost();
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  const total = useMemo(() => board.companies.reduce((s, c) => s + c.weight, 0), [board.companies]);
  const run = async (f: () => Promise<unknown>, said = "Saved.") => { try { await f(); toast(said); router.refresh(); } catch (e) { toast(e instanceof Error ? e.message : "Not saved. Try again.", { tone: "bad" }); } };
  return <div className={css.settings}>
    <p className={`${css.quiet} ${css.wide}`}>Changes save by themselves when you leave a box.</p>
    <GameCard title="How much each company gets" icon={Gauge} note={total === 100 ? "Adds to 100" : `Adds to ${total}; Focus scales it to 100`}>
      <ul className={css.weights}>{board.companies.map((c) => <li key={c.key} style={{ "--hue": c.hue } as CSSProperties}>
        <label><span><i aria-hidden="true" />{c.name}</span><input type="number" min={0} max={100} defaultValue={c.weight} inputMode="numeric"
          onBlur={(e) => { if (Number(e.target.value) !== c.weight) void run(() => focusPost(`focus/companies/${c.key}`, { weight: Number(e.target.value) })); }} /></label>
      </li>)}</ul>
      <Switch label="Adjust each day" hint="Give more to work with a close deadline or marked urgent, and less to blocked work." defaultChecked={board.settings.autoWeights}
        onChange={(on) => void run(() => focusPost("focus/settings", { autoWeights: on }))} />
    </GameCard>
    <GameCard title="Save this much for urgent jobs" icon={BatteryLow}>
      <div className={css.fields}>
        <label className={css.pct}>Of each 5-hour window<input type="number" min={0} max={90} defaultValue={board.settings.reserve5h} inputMode="numeric"
          onBlur={(e) => { if (Number(e.target.value) !== board.settings.reserve5h) void run(() => focusPost("focus/settings", { reserve5h: Number(e.target.value) })); }} /></label>
        <label className={css.pct}>Of each week<input type="number" min={0} max={90} defaultValue={board.settings.reserve7d} inputMode="numeric"
          onBlur={(e) => { if (Number(e.target.value) !== board.settings.reserve7d) void run(() => focusPost("focus/settings", { reserve7d: Number(e.target.value) })); }} /></label>
      </div>
    </GameCard>
    <GameCard title="Automatic readings" icon={PlugZap}>
      <p className={css.quiet}>{board.settings.ingestAt ? `Last reading ${age(board.settings.ingestAt, Date.parse(board.now)).text}.` : board.settings.hasKey ? "Connected. Waiting for its first reading." : "No collector has sent a reading yet."} It sends numbers only, never passwords or keys.</p>
      {key ? <p className={css.key}><code>{key}</code><span>Copy it now. Pulse does not show it again.</span></p> : null}
      <div><button type="button" className={gameCss.quiet} onClick={() => void run(async () => setKey((await focusPost<{ key: string }>("focus/ingest-key")).key), "New key made. The old key stops working, so put the new one on the server.")}>
        {board.settings.hasKey ? "Reconnect with a new key" : "Connect"}</button></div>
    </GameCard>
  </div>;
}
