"use client";
// GAP-FOUNDER-VIEW (9 Nov 2026; Codex concept 1 "Company cards" on a computer, concept 3 "Stack" on a phone, in
// reports/founder-view/concepts): one card per company the person runs, in their Focus order. Each card says today's
// money, client issues, late work, who is in, the AI employees, who also works in another of their companies, and the one
// next thing; its one primary button opens that company with the organisation switcher's own switch. Read only.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, ClipboardList, Lock, MessageSquareWarning, RefreshCw, UserRound, Users } from "lucide-react";
import { ActionButton, Chip, EmptyState, GameCard, GamePage, Milestone, PageHeader, ProgressRing, gameCss, toast } from "../kit/game";
import { countsOf, money, moneyPill, myRole, nextHref, nextShort, nextText, sharedPersonLine, toneOf, totalsOf, type FounderCard, type FounderData } from "../lib/founder.mjs";
import { openCompany } from "../orgs/client";
import { orgHue, orgInitials } from "../orgs/labels";
import css from "./founder.module.css";

const COUNT_ICON = { issues: MessageSquareWarning, late: ClipboardList, people: Users, ai: Bot } as const;

function dayWords(iso: string | undefined) {
  if (!iso) return "Today";
  const [, m, d] = iso.split("-").map(Number);
  return `Today, ${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m || 1) - 1]}`;
}

function CompanyMark({ card, hue }: { card: FounderCard; hue: number }) {
  const [failed, setFailed] = useState(false);
  const mark = card.mark && !failed ? card.mark : null;
  return <span className={css.mark} aria-hidden="true" style={mark ? undefined : { background: card.accent ?? `hsl(${hue} 48% 38%)` }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- the company's own small logo, served by the app */}
    {mark ? <img src={mark} alt="" width={44} height={44} decoding="async" onError={() => setFailed(true)} /> : orgInitials(card.name)}
  </span>;
}

function CompanyCard({ card, hue, shared }: { card: FounderCard; hue: number; shared: FounderCard["people"] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const t = card.today, tone = toneOf(t), pill = moneyPill(t), next = t.next, href = nextHref(next), lateAmount = Number(t.money?.late?.amount ?? 0);
  // What needs you first (late or stuck), then who is in; a phone shows the first two and "+N".
  const RANKED = { bad: 0, warn: 1 } as Record<string, number>;
  const counts = countsOf(t).filter((c) => c.key === "people" || c.tone === "warn" || c.tone === "bad")
    .sort((a, b) => (RANKED[a.tone ?? ""] ?? 2) - (RANKED[b.tone ?? ""] ?? 2));
  const go = async (to?: string) => {
    if (card.current) { router.push(to ?? "/dashboard"); return; }
    setBusy(true);
    try { await openCompany(card.org, card.name, to); } catch (e) { setBusy(false); toast(e instanceof Error ? e.message : `Could not open ${card.name}`, { tone: "bad" }); }
  };
  // One card per company. A phone stacks its parts; a wide screen lays them out as one row (who · money · today · next),
  // so every company reads the same way, top to bottom, and no card stands beside a taller one.
  return <article className={css.card} data-tone={tone} aria-labelledby={`fc-${card.org}`} data-founder-card={card.name}>
    <div className={css.who}>
      <CompanyMark card={card} hue={hue} />
      <div className={css.whoText}>
        <h2 id={`fc-${card.org}`} className={css.name}>{card.name}</h2>
        <span className={css.chips}><Chip tone="accent">{myRole(t)}</Chip></span>
      </div>
    </div>

    <div className={css.money} data-founder-money="" data-none={t.money ? undefined : ""}>
      {t.money ? lateAmount > 0 ? <>
        {/* Late money leads: it is what needs the founder; what falls due this week is the second line. */}
        <b className={`${css.big} ${css.lateBig}`}><AlertTriangle size={18} aria-hidden="true" />{money(lateAmount)} late</b>
        <span className={css.muted}>{money(t.money.dueWeek.amount)} due in 7 days</span>
      </> : <>
        <b className={css.big}>{money(t.money.dueWeek.amount)}</b>
        <span className={css.moneyTop}><span className={css.muted}>due in 7 days</span>
          {pill && pill.tone === "warn" ? <Chip tone="warn">{pill.text}</Chip> : null}</span>
      </> : <span className={css.hiddenLine}><Lock size={14} aria-hidden="true" />Money: not shared with you</span>}
    </div>

    <div className={css.today}>
      <ul className={css.counts} aria-label={`${card.name} today`}>
        {counts.map((c) => { const Icon = COUNT_ICON[c.key]; return <li key={c.key} data-tone={c.tone}><Icon size={16} aria-hidden="true" /><span>{c.text}</span></li>; })}
      </ul>
      {shared[0] ? <p className={css.line} data-founder-people=""><UserRound size={16} aria-hidden="true" /><span>{sharedPersonLine(shared[0])}{shared.length > 1 ? <span className={css.muted}> · +{shared.length - 1} more</span> : null}</span></p> : null}
    </div>

    <div className={css.nextZone}>
      {next && href ? <button type="button" className={css.next} onClick={() => void go(href)} disabled={busy} data-founder-next="">
        <ArrowRight size={16} aria-hidden="true" /><span><b>Next:</b> {nextText(next)}</span></button>
        : <p className={css.line} data-tone="good"><CheckCircle2 size={18} aria-hidden="true" /><span><b>All clear today.</b> <span className={css.muted}>Nothing needs you.</span></span></p>}
    </div>
    <div className={css.openZone}>
      <button type="button" className={`${gameCss.primary} ${css.open}`} onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Opening…" : `Open ${card.name}`}
      </button>
    </div>
  </article>;
}

const RANK = { late_bill: 0, ai_stuck: 1, client_issue: 2, late_task: 3, unbilled: 4 } as const;
/** The one thing to do first across every company: the most urgent kind, then the founder's own order. */
function firstOf(cards: FounderCard[]): FounderCard | null {
  let best: FounderCard | null = null;
  for (const c of cards) if (c.today.next && (!best || RANK[c.today.next.kind] < RANK[best.today.next!.kind])) best = c;
  return best;
}

/** "Do this first": one line under the title, so the first screen says what to do. */
function FirstThing({ card }: { card: FounderCard }) {
  const [busy, setBusy] = useState(false);
  const href = nextHref(card.today.next);
  if (!href) return null;
  return <button type="button" className={css.first} disabled={busy} data-founder-first=""
    onClick={() => { setBusy(true); void openCompany(card.org, card.name, href).catch((e) => { setBusy(false); toast(e instanceof Error ? e.message : `Could not open ${card.name}`, { tone: "bad" }); }); }}>
    <ArrowRight size={18} aria-hidden="true" /><span className={css.firstText}><b>Do this first · {card.name}:</b> {nextShort(card.today.next)}</span><span className={css.go}>Open <ArrowRight size={14} aria-hidden="true" /></span>
  </button>;
}

export function Founder({ data, error }: { data: FounderData | null; error: string | null }) {
  const router = useRouter();
  if (!data) return <GamePage label="All my companies">
    <PageHeader title="All my companies" subtitle="Every company you run, on one screen." shellTitle />
    <div className={css.narrow}><GameCard><div className={css.art}><EmptyState art="nothing" title="We could not load your companies" text={error ?? "Try again in a minute."} action={{ label: "Try again", icon: RefreshCw, onClick: () => router.refresh() }} /></div></GameCard></div>
  </GamePage>;
  const cards = data.cards, totals = totalsOf(cards), today = cards[0]?.today.today;
  if (!data.eligible) return <GamePage label="All my companies">
    <PageHeader title="All my companies" subtitle="Every company you run, on one screen." shellTitle />
    <div className={css.narrow}><GameCard><div className={css.art}>
      <EmptyState art="nothing" title={cards.length ? "You run one company" : "No company to show yet"}
        text={cards.length ? `${cards[0].name} is here. Add your other companies to see them side by side.` : "Add the companies you lead to see them side by side."} />
      <div className={css.actions}>
        {cards.length ? <ActionButton primary action={{ label: `Open ${cards[0].name}`, onClick: () => void openCompany(cards[0].org, cards[0].name).catch(() => undefined) }} />
          : <ActionButton primary action={{ label: "Back to My day", href: "/my-day" }} />}
        <ActionButton action={{ label: "Add a company", href: "/orgs/new" }} />
      </div>
    </div></GameCard></div>
  </GamePage>;
  const allClear = totals.clear === totals.companies;
  const first = firstOf(cards);
  // A person who works in two of your companies is named once, on the first card that has them.
  const seen = new Set<string>();
  const people = cards.map((c) => c.people.filter((p) => { const k = p.handle ?? p.name; if (seen.has(k)) return false; seen.add(k); return true; }));
  // Each company's own colour (the switcher's), moved round the wheel when two would look alike side by side.
  const hues: number[] = [];
  for (const c of cards) { let h = orgHue(c.name); for (let k = 0; k < 8 && hues.some((x) => Math.min(Math.abs(x - h), 360 - Math.abs(x - h)) < 40); k++) h = (h + 67) % 360; hues.push(h); }
  return <GamePage label="All my companies">
    <PageHeader title="All my companies" shellTitle subtitle={<>{dayWords(today)} · {cards.length} companies</>} />
    {/* The day at a glance: how many companies are all clear, the money picture, and the one thing to do first. */}
    <section className={css.overview} data-founder-summary="" aria-label="Today across your companies">
      <div className={css.strip}>
        <ProgressRing value={totals.companies ? totals.clear / totals.companies : 0} size={44} stroke={6} tone={allClear ? "good" : undefined}
          label={`${totals.clear} of ${totals.companies} companies all clear`}><b className={css.ringText}>{totals.clear}/{totals.companies}</b></ProgressRing>
        <span className={css.stripText}><b>{totals.clear} of {totals.companies} companies all clear</b>
          <span>{totals.risk > 0 ? <><b className={css.lateWord}>{money(totals.risk)} late</b> · </> : null}{money(totals.due)} due in 7 days</span></span>
      </div>
      {first ? <FirstThing card={first} /> : null}
    </section>
    <Milestone show={allClear} id={`founder-clear-${today ?? "today"}`} title="Every company is clear today" text="Nothing late, nobody stuck. Nice." />
    <div className={css.grid}>{cards.map((c, i) => <CompanyCard key={c.org} card={c} hue={hues[i]} shared={people[i]} />)}</div>
    {data.unavailable.length ? <p className={css.note} role="status">Could not read {data.unavailable.join(", ")} just now. Try again in a minute.</p> : null}
    {data.more ? <p className={css.note}>{data.more} more {data.more === 1 ? "company is" : "companies are"} not shown. Open them from the company switcher.</p> : null}
  </GamePage>;
}
