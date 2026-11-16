"use client";
// FIX-AI-EMPLOYEES (owner walkthrough, 10 Nov 2026, D1): "The AI employee page is a big list with no data and an unclear
// button. Redesign it: cards showing role, what each one did today, what it's waiting on, and its cost. Make Autopilots
// the main view." Built from Codex concept 1 ("Card grid": equal cards, the ones waiting on a person first with a coloured
// edge) with concept 2's "Needs a person" list on top when something waits. The streak and level badges of the concepts
// are left out: points stay personal and never rank anyone (UX-GAMIFY). The game-feel kit draws the page, the header,
// the tiles, the tabs and the empty state; the day log (log.tsx) is the second tab.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AlertTriangle, BadgeIndianRupee, Bot, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Hourglass, KeyRound, ListChecks, MessageSquareText, MoonStar,
  PauseCircle, Plug, Plus, Sparkles, Wrench, Zap } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { EmptyState, GamePage, PageHeader, SegmentedTabLinks, StatTile, StatTiles } from "../../kit/game";
import { post } from "../../records";
import { Avatar } from "../../ui";
import type { Agent, Workload } from "./workload-types";
import css from "./autopilots.module.css";

type Tone = "good" | "warn" | "bad";
type Viewer = { name: string; admin: boolean };

const n = (x: number) => Number(x || 0).toLocaleString("en-IN");
/** 12.4k, 2.6M: tokens as people read them. */
export function tokens(x: number): string {
  const v = Number(x || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0).replace(/\.0$/, "")}k`;
  return String(v);
}
/** Rupees from the platform's price (whole rupees; a few paise read "under ₹1"). */
export function inr(x: number): string { const v = Number(x || 0); return v > 0 && v < 1 ? "under ₹1" : `₹${Math.round(v).toLocaleString("en-IN")}`; }
/** What a spend reads as: rupees when priced, else tokens. */
const spend = (s: { tokens: number; inr: number | null } | undefined) => !s ? "–" : s.inr !== null && s.inr !== undefined ? inr(s.inr) : `${tokens(s.tokens)} tokens`;
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const first = (name: string) => name.split(/\s+/)[0] || name;
const bare = (name: string) => name.replace(/\s*\((?:[^)]*\bAI)\)\s*$/i, "").trim();

/** What it works with, in plain words (its tools). */
const TOOL: Record<string, string> = { billing: "Quotes and invoices", chats: "Chats", tasks: "Tasks", projects: "Projects", board: "The board", docs: "Docs", calls: "Calls", hr: "HR" };
function roleLine(a: Agent): string {
  const t = bare(a.title || ""), own = bare(a.name);
  const tools = (a.cost?.tools ?? []).map((x) => TOOL[x]).filter(Boolean);
  const what = t && t.toLowerCase() !== own.toLowerCase() ? t : tools.length ? tools.slice(0, 3).join(" · ") : "AI employee";
  return a.approver ? `${what} · asks ${a.approver}` : what;
}

/** Its state in one chip, and where it sorts (what needs a person first). */
function stateOf(a: Agent, today: boolean): { label: string; tone?: Tone | "accent"; rank: number } {
  const out = a.runtime.state === "out_of_quota" || a.cost?.budget?.level === "out";
  if (a.status === "off") return { label: "Switched off", rank: 9 };
  if (a.status === "paused") return { label: "Paused", rank: 8 };
  if (a.runtime.state === "error") return { label: "Stopped", tone: "bad", rank: 0 };
  if (today && out) return { label: "Out of budget", tone: "bad", rank: 0 };
  if (a.waitingCards.length || a.waitingQuestions.some((q) => q.state === "open")) return { label: "Waiting", tone: "warn", rank: 1 };
  if (today && (a.cost?.running || (a.cost?.queued ?? 0) > 0)) return { label: "Working", tone: "good", rank: 2 };
  if (a.runtime.provider === "stub") return { label: "Test mode", tone: "accent", rank: 4 };
  if (a.did.runs > 0) return { label: today ? "Done for now" : "Worked", tone: "good", rank: 3 };
  return { label: today ? "Idle" : "Idle that day", rank: 5 };
}

/** What it did that day, in one or two plain lines. */
function didLines(a: Agent): string[] {
  const parts: string[] = [];
  if (a.did.answered) parts.push(`Answered ${plural(a.did.answered, "message")}`);
  if (a.cards.made) parts.push(`drafted ${plural(a.cards.made, "card")} for approval`);
  if (a.did.tasks) parts.push(`worked on ${plural(a.did.tasks, "task")}`);
  if (a.asked.asked) parts.push(`asked colleagues ${a.asked.asked === 1 ? "once" : `${n(a.asked.asked)} times`}`);
  const follow = a.did.quietClients + a.did.missedCalls + a.did.recordedCalls;
  if (follow) parts.push(`followed up ${follow === 1 ? "once" : `${n(follow)} times`}`);
  if (a.posted) parts.push(`posted ${plural(a.posted, "message")}`);
  if (!parts.length && a.did.runs) parts.push(`Did ${plural(a.did.runs, "piece")} of work`);
  const s = parts.join(", ");
  return s ? [s.charAt(0).toUpperCase() + s.slice(1) + "."] : [];
}

/** "Saturday, 7 Nov" (or "Saturday"), built from parts, so the server and the browser write it the same way. */
function dayName(iso: string, zone: string, withDate = true) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: zone }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return withDate ? `${p.weekday}, ${p.day} ${p.month}` : String(p.weekday);
}

export function Autopilots({ w, me, view, today, prev, next, now, children }: {
  w: Workload; me: Viewer; view: "cards" | "log"; /** The day shown is today. */ today: boolean; prev: string; next: string | null; now: number; children?: ReactNode }) {
  const zone = w.timeZone || "Asia/Kolkata";
  const dayQ = today ? "" : `day=${w.day}`;
  const agents = [...w.agents].map((a) => ({ a, s: stateOf(a, today) }))
    .sort((x, y) => x.s.rank - y.s.rank || Date.parse(y.a.cost?.lastRunAt ?? "1970-01-01") - Date.parse(x.a.cost?.lastRunAt ?? "1970-01-01") || x.a.name.localeCompare(y.a.name));
  const sum = (f: (a: Agent) => number) => w.agents.reduce((s, a) => s + (Number(f(a)) || 0), 0);
  const waitingCards = sum((a) => a.waitingCards.length), openQs = sum((a) => a.waitingQuestions.filter((q) => q.state === "open").length);
  const working = today ? w.agents.filter((a) => a.cost?.running || (a.cost?.queued ?? 0) > 0).length : null;
  const jobs = sum((a) => a.did.runs - a.did.failed);
  const priced = w.agents.every((a) => a.cost?.month.inr !== null && a.cost?.month.inr !== undefined);
  const monthCost = priced ? inr(sum((a) => a.cost?.month.inr ?? 0)) : tokens(sum((a) => a.cost?.month.tokens ?? 0));
  const dayLabel = today ? "Today" : dayName(`${w.day}T12:00:00Z`, "UTC");

  const day = <nav className={css.day} aria-label="Pick the day">
    <Link href={`/people/ai?${new URLSearchParams({ ...(view === "log" ? { view } : {}), day: prev })}`} aria-label="The day before"><ChevronLeft size={16} aria-hidden="true" /></Link>
    <b aria-live="polite">{dayLabel}</b>
    {next ? <Link href={`/people/ai?${new URLSearchParams({ ...(view === "log" ? { view } : {}), ...(next === "today" ? {} : { day: next }) })}`} aria-label="The next day"><ChevronRight size={16} aria-hidden="true" /></Link>
      : <span aria-disabled="true" aria-label="No later day"><ChevronRight size={16} aria-hidden="true" /></span>}
  </nav>;

  return <GamePage label="Autopilots">
    <PageHeader title="Autopilots" shellTitle
      subtitle="Your AI employees: what each did today, what it waits on, and what it costs."
      primary={me.admin ? { label: "Add an AI employee", href: "/people?add=ai", icon: Plus } : undefined} />

    {!w.agents.length ? <EmptyState art="nothing" title="No AI employees yet"
      text={me.admin ? "An AI employee answers chats, drafts quotes and does tasks, like a teammate. It asks a person before anything important." : "An AI employee answers chats, drafts quotes and does tasks, like a teammate. Ask an admin to add one."} />
      : <>
        <div className={css.bar}><SegmentedTabLinks label="Autopilots views" items={[
          { key: "cards", href: `/people/ai${dayQ ? `?${dayQ}` : ""}`, label: "Autopilots", count: w.agents.length, current: view === "cards" },
          { key: "log", href: `/people/ai?view=log${dayQ ? `&${dayQ}` : ""}`, label: today ? "Today's log" : "Day log", count: sum((a) => a.did.runs) || undefined, current: view === "log" }]} />{day}</div>

        {view === "log" ? children : <>
          <StatTiles label={today ? "Today in numbers" : "That day in numbers"} pair>
            {working !== null ? <StatTile label="Working now" value={working} icon={Zap} tone={working ? "good" : undefined} />
              : <StatTile label="AI employees" value={w.agents.length} icon={Bot} />}
            <StatTile label="Waiting on people" value={waitingCards + openQs} icon={Hourglass} tone={waitingCards + openQs ? "warn" : undefined} />
            <StatTile label={today ? "Jobs done today" : "Jobs done"} value={jobs} icon={CheckCircle2} />
            <StatTile label="Cost this month" value={monthCost} unit={priced ? undefined : "tokens"} icon={BadgeIndianRupee} />
          </StatTiles>

          <Needs agents={w.agents} me={me} now={now} />

          <ul className={css.grid} aria-label="Your AI employees">
            {agents.filter(({ s }) => s.rank < 5).map(({ a, s }) => <li key={a.id}><AutopilotCard a={a} s={s} me={me} today={today} zone={zone} now={now} /></li>)}
          </ul>
          {agents.some(({ s }) => s.rank >= 5) ? <section className={css.quiet} aria-labelledby="ap-quiet">
            <h2 id="ap-quiet">{today ? "Quiet today" : "Quiet that day"}</h2>
            <ul>{agents.filter(({ s }) => s.rank >= 5).map(({ a, s }) => <QuietRow key={a.id} a={a} s={s} today={today} zone={zone} now={now} />)}</ul>
          </section> : null}
        </>}
      </>}

    <nav className={css.more} aria-label="More about your AI team">
      <Link href="/people/ai/tasks"><ListChecks size={16} aria-hidden="true" />Tasks and cost</Link>
      <Link href="/bug-reports/board?kind=tool_needed"><Wrench size={16} aria-hidden="true" />What they need</Link>
      <Link href="/settings?tab=connect-ai"><Plug size={16} aria-hidden="true" />Connect your AI</Link>
      <Link href="/learn/ai-employees"><Sparkles size={16} aria-hidden="true" />How AI employees work</Link>
    </nav>
  </GamePage>;
}

/** Everything that waits on a person, across the AI team: the oldest first, five at most here. */
function Needs({ agents, me, now }: { agents: Agent[]; me: Viewer; now: number }) {
  // One row per AI employee, kind and person: "2 replies to approve", with what the oldest one says.
  const groups = new Map<string, { key: string; a: Agent; at: string; n: number; what: string; about: string; where: string; who: string; href: string | null }>();
  for (const a of agents) {
    for (const c of [...a.waitingCards].sort((x, y) => Date.parse(x.since) - Date.parse(y.since))) {
      const k = `${a.id}:${c.kind}:${c.approver}`, g = groups.get(k);
      if (g) { g.n += 1; continue; }
      groups.set(k, { key: k, a, at: c.since, n: 1, what: c.kind === "task" ? "task" : "reply", about: c.body, where: c.channel, who: c.approver,
        href: c.canOpen === false ? null : `/chats?channel=${c.chatId}${c.messageId ? `&message=${c.messageId}` : ""}` });
    }
    for (const q of a.waitingQuestions.filter((x) => x.state === "open")) {
      const k = `${a.id}:q:${q.colleague}`, g = groups.get(k);
      if (g) { g.n += 1; continue; }
      groups.set(k, { key: k, a, at: q.since, n: 1, what: "question", about: q.question, where: q.channel, who: q.colleague, href: `/chats?channel=${q.chatId}` });
    }
  }
  const items = [...groups.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  if (!items.length) return null;
  return <section className={css.needs} aria-labelledby="ap-needs">
    <h2 id="ap-needs"><Clock3 size={16} aria-hidden="true" />Needs a person</h2>
    <ul>{items.slice(0, 5).map((x) => <li key={x.key}>
      <Avatar name={x.a.name} size={28} ai />
      <span><b>{bare(x.a.name)}: {x.what === "question" ? (x.n === 1 ? "a question" : `${x.n} questions`) + ` for ${x.who === me.name ? "you" : x.who}` : `${plural(x.n, x.what, x.what === "reply" ? "replies" : undefined)} for ${x.who === me.name ? "you" : x.who} to approve`}</b>
        <small>“{x.about.length > 90 ? `${x.about.slice(0, 88)}…` : x.about}” · {x.where} · waiting {agoShort(x.at, now)}</small></span>
      {x.href ? <Link className={css.open} href={x.href}>Open</Link> : <small>In {first(x.who)}’s messages</small>}
    </li>)}</ul>
    {items.length > 5 ? <p><Link href="/people/ai?view=log">See all in today’s log</Link></p> : null}
  </section>;
}

function agoShort(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}\u00a0min` : m < 48 * 60 ? `${Math.round(m / 60)}\u00a0h` : `${Math.round(m / 1440)}\u00a0days`;
}

/** An AI employee with nothing to show: one line, with when it last worked and a way to give it work. */
function QuietRow({ a, s, today, zone, now }: { a: Agent; s: ReturnType<typeof stateOf>; today: boolean; zone: string; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const last = a.cost?.lastRunAt ? (Date.parse(a.cost.lastRunAt) > now - 7 * 864e5 ? dayName(a.cost.lastRunAt, zone, false) : agoShort(a.cost.lastRunAt, now) + " ago") : null;
  const message = async () => {
    setBusy(true);
    try { router.push(`/chats?channel=${encodeURIComponent((await post<{ id: string }>("chats/direct", { personId: a.id })).id)}`); }
    catch (e) { notify({ id: "autopilots", tone: "error", title: `Couldn’t open a chat with ${bare(a.name)}`, message: e instanceof Error ? e.message : "Try again in a moment." }); setBusy(false); }
  };
  return <li aria-label={a.name}>
    <Avatar name={a.name} size={28} shape="square" ai />
    <span><Link className={css.name} href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>{bare(a.name)}</Link>
      <small>{a.status === "paused" ? "Paused by an admin" : a.status === "off" ? "Switched off" : last ? `Last worked ${last}` : "Hasn’t worked yet"} · <span className={css.keep}>this month {spend(a.cost?.month)}</span></small></span>
    {a.status === "on" && today ? <button type="button" className={css.open} disabled={busy} onClick={() => void message()}>Give it work</button>
      : <span className={css.chip} data-tone={s.tone}>{s.label}</span>}
  </li>;
}

function AutopilotCard({ a, s, me, today, zone, now }: { a: Agent; s: ReturnType<typeof stateOf>; me: Viewer; today: boolean; zone: string; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const c = a.cost;
  const did = didLines(a);
  const last = c?.lastRunAt ? (Date.parse(c.lastRunAt) > now - 7 * 864e5 ? dayName(c.lastRunAt, zone, false) : agoShort(c.lastRunAt, now) + " ago") : null;
  const message = async () => {
    setBusy(true);
    try { router.push(`/chats?channel=${encodeURIComponent((await post<{ id: string }>("chats/direct", { personId: a.id })).id)}`); }
    catch (e) { notify({ id: "autopilots", tone: "error", title: `Couldn’t open a chat with ${bare(a.name)}`, message: e instanceof Error ? e.message : "Try again in a moment." }); setBusy(false); }
  };

  // What it waits on: one line, the most pressing first.
  const byApprover = new Map<string, number>();
  for (const x of a.waitingCards) byApprover.set(x.approver, (byApprover.get(x.approver) ?? 0) + 1);
  const ask = a.waitingQuestions.filter((q) => q.state === "open");
  let wait: { tone?: Tone; icon: ReactNode; text: ReactNode };
  if (a.status === "off") wait = { icon: <MoonStar size={16} aria-hidden="true" />, text: "Switched off. It does no work until an admin switches it on." };
  else if (a.status === "paused") wait = { icon: <PauseCircle size={16} aria-hidden="true" />, text: "Paused by an admin." };
  else if (a.runtime.state === "error") wait = { tone: "bad", icon: <AlertTriangle size={16} aria-hidden="true" />, text: <>Stopped by an error. <Link href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>See why</Link></> };
  else if (today && (a.runtime.state === "out_of_quota" || c?.budget?.level === "out")) wait = { tone: "bad", icon: <KeyRound size={16} aria-hidden="true" />,
    text: <>Waiting on budget. {c?.budget?.canAdd ? <Link href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>Add more</Link> : "An admin can add more."}</> };
  else if (byApprover.size) { const [who, k] = [...byApprover.entries()].sort((x, y) => y[1] - x[1])[0];
    wait = { tone: "warn", icon: <Hourglass size={16} aria-hidden="true" />, text: <>Waiting on <b>{who === me.name ? "you" : who}</b>: approve {plural(k, "card")}{byApprover.size > 1 ? ` (and ${byApprover.size - 1} more ${byApprover.size === 2 ? "person" : "people"})` : ""}</> }; }
  else if (ask.length) wait = { tone: "warn", icon: <MessageSquareText size={16} aria-hidden="true" />, text: <>Waiting on <b>{ask[0].colleague === me.name ? "you" : ask[0].colleague}</b> to answer {ask.length === 1 ? "a question" : `${n(ask.length)} questions`}</> };
  else if (today && (c?.queued ?? 0) > 0) wait = { tone: "good", icon: <Zap size={16} aria-hidden="true" />, text: `Working through ${plural(c!.queued, "job")}` };
  else wait = { tone: "good", icon: <CheckCircle2 size={16} aria-hidden="true" />, text: "Nothing. Ready for work." };

  const spent = today && (a.runtime.state === "out_of_quota" || c?.budget?.level === "out");
  const share = spent ? 100 : c?.budget?.day ? Math.min(100, Math.max(0, Math.round(c.budget.day.share))) : null;
  const barTone = share === null ? undefined : share >= 100 ? "bad" : share >= 80 ? "warn" : undefined;

  return <article className={css.card} aria-label={a.name} data-off={a.status !== "on" ? "" : undefined}>
    <header className={css.head}>
      <Avatar name={a.name} size={44} shape="square" ai />
      <span className={css.who}><Link className={css.name} href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>{bare(a.name)}</Link><span className={css.role}>{roleLine(a)}</span></span>
      <span className={css.chip} data-tone={s.tone}>{s.label}</span>
    </header>

    {did.length ? did.map((d) => <p key={d} className={css.line}><Sparkles size={16} aria-hidden="true" /><span>{d}</span></p>)
      : s.rank === 0 || a.status !== "on" ? null : <p className={css.line}><MoonStar size={16} aria-hidden="true" /><span>{today ? "No work yet today" : "No work that day"}<small>{last ? ` · last worked ${last}` : " · hasn’t worked yet"}</small>
        {today && s.label === "Idle" ? <>{" · "}<button type="button" className={`${css.link}`} disabled={busy} onClick={() => void message()}>Give it work</button></> : null}</span></p>}

    <p className={css.wait} data-tone={wait.tone}>{wait.icon}<span>{wait.text}</span></p>

    <footer className={css.cost}>
      <p className={css.costLine}><span>{today ? "Today" : "That day"} <b>{spend(c?.today)}</b></span><span>This month <b>{spend(c?.month)}</b></span></p>
      {today && share !== null && (spent || c?.budget?.day.limit) ? <div className={css.meter} role="img" aria-label={spent ? "Budget used up" : `Today's budget: ${share}% used`}>
        <span className={css.track}><span className={css.fill} data-tone={barTone} style={{ width: `${share}%` }} /></span><span>{spent ? "Budget used up" : `${share}% of today’s budget`}</span></div> : null}
    </footer>
  </article>;
}
