// TOKENS-TELEMETRY (owner, 17 Nov 2026: "Telemetry is becoming stupider. The flows, graphs and data that can be visualised
// and collected properly are not there." and "1 million tokens is not enough for anything"): Insights for leadership, on
// one scrolling page (concept 1 of 3, reports/tokens-telemetry/concepts/insights): what got better or worse since
// yesterday, how people really move (journey map with where they left), the key jobs as funnels, speed over time against
// the targets, where people struggle, and what the AI employees cost and save. Real data: GET /api/v0/telemetry/story
// and /api/v0/telemetry/ai-cost (services/api/src/telemetry-story.ts, telemetry-ai-cost.ts).
import { ArrowDownRight, ArrowUpRight, Minus, Sparkles } from "lucide-react";
import Link from "next/link";
import { api } from "../../lib/api";
import { EmptyState } from "../../kit/game";
import { Badge, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles, styles } from "../../ui";
import { CostChart, type CostDay, type Funnel, JourneyChart, type Journey, PagesChart, type PageRow, PerJobChart, SpeedChart, type SpeedRow, StruggleChart, type StruggleRow } from "./charts";
import { PatternReview, type Pattern } from "./review";
import { typeName } from "./words";
import css from "./insights.module.css";

type Line = { key: string; label: string; unit: "ms" | "count" | "tokens"; now: number | null; before: number | null; change: number | null; verdict: "better" | "worse" | "same" | "new" };
type Story = { days: number; zone: string; journeys: Journey; funnels: Funnel[]; speed: SpeedRow[]; pages: PageRow[]; struggle: StruggleRow[]; digest: { lines: Line[]; pagesWorse: Line[]; pagesBetter: Line[] } };
type Agent = { id: string; name: string; title: string | null; budget: number | null; today: number; p90Day: number; runs: number; tokens: number; inr: number | null; failed: number; ruled: number; saved: number; waitedForBudget: number; warn: boolean; suggested: number; paused: boolean };
type Cost = { days: number; byDay: (CostDay & { failed: number; tokensIn: number; tokensOut: number; unpriced: number; ruledTokens: number })[]; agents: Agent[]; waste: Record<string, { runs: number; tokens: number }>;
  rules: { key: string; title: string; type: string; kind: string; state: string; uses: number; saved: number }[]; priced: boolean; router?: Router; canReview?: boolean };
/** TOKENS-2 (2280): the model router's report: runs per class and per week, cost per kind of work, the patterns. */
type Router = { days: number; priced: boolean; classes: { class: string; runs: number; strongest: number; strong: number; escalated: number; tokens: number; inr: number | null }[];
  weeks: { week: string; runs: number; strongest: number; routed: number; inr: number | null }[]; types: { taskType: string; runs: number; inrPerRun: number | null }[]; patterns: Pattern[] };

const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}\u00a0ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}\u00a0s`);
const tok = (n: number) => (n >= 1e7 ? `${(n / 1e7).toFixed(1)} crore` : n >= 1e5 ? `${(n / 1e5).toFixed(1)} lakh` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const rupees = (n: number) => `₹${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-IN")}`;
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

/** The kit's Panel with this screen's inner padding (the kit leaves padding to the content). */
function Box({ children, ...p }: Parameters<typeof Panel>[0]) {
  return <Panel {...p}><div className={css.body}>{children}</div></Panel>;
}

/** The card's small line: now and before, in words. */
function sub(l: Line) {
  const n = (x: number | null) => (x === null ? "–" : l.unit === "ms" ? secs(x) : l.unit === "tokens" ? tok(x) : String(Math.round(x)));
  if (l.unit === "count" && l.key !== "people") return `${n(l.now)} today, about ${n(l.before)} a day before`;
  return `${n(l.now)} now, was ${n(l.before)}`;
}
/** The card's big figure (always one line) and the word under it. */
function headline(l: Line): [string, string] {
  if (l.verdict === "new") return ["New", "today"];
  if (l.change === null || l.verdict === "same") return ["Same", "no change"];
  if (l.unit === "ms") return [`${Math.abs(l.change)}%`, l.change > 0 ? "slower" : "faster"];
  return [`${Math.abs(l.change)}%`, `${l.change > 0 ? "up" : "down"} · ${l.verdict === "worse" ? "worse" : "better"}`];
}
const ICON = { better: ArrowDownRight, worse: ArrowUpRight, same: Minus, new: Sparkles };

function Digest({ s }: { s: Story }) {
  const all = s.digest.lines.filter((l) => l.now !== null || l.before !== null);
  const lines = all.filter((l) => l.key !== "people"), people = all.find((l) => l.key === "people");
  const worse = lines.filter((l) => l.verdict === "worse").length, better = lines.filter((l) => l.verdict === "better").length;
  return <Box title="Since yesterday" sub={`${better} better · ${worse} worse`}>
    <p className={css.lead}>The last 24 hours against the 7 days before. Times are the slowest 1 in 10 waits. Only real changes count.</p>
    <ul className={css.digest}>{lines.map((l) => {
      const Icon = ICON[l.verdict];
      return <li key={l.key} className={css.card} data-verdict={l.verdict}>
        <span className={css.cardLabel}>{l.label}</span>
        <b className={css.cardValue}>{headline(l)[0]}</b>
        <span className={css.cardWord}><Icon size={15} aria-hidden="true" />{headline(l)[1]}</span>
        <span className={css.cardSub}>{sub(l)}</span>
        <span className={css.srOnly}>{l.verdict === "better" ? "Better" : l.verdict === "worse" ? "Worse" : "No real change"}</span>
      </li>;
    })}</ul>
    {people && people.now !== null ? <p className={css.peopleLine}>{people.now} people used Pulse in the last 24 hours ({people.before} the day before on average).</p> : null}
    {s.digest.pagesWorse.length || s.digest.pagesBetter.length ? <ul className={css.pagesLine}>
      {s.digest.pagesWorse.map((p) => <li key={`w${p.key}`}><Badge tone="danger">Slower</Badge><span>{p.label}</span><span className={css.num}>{secs(p.now ?? 0)}, was {secs(p.before ?? 0)}</span></li>)}
      {s.digest.pagesBetter.map((p) => <li key={`b${p.key}`}><Badge tone="success">Faster</Badge><span>{p.label}</span><span className={css.num}>{secs(p.now ?? 0)}, was {secs(p.before ?? 0)}</span></li>)}
    </ul> : null}
  </Box>;
}

const TARGET: Record<string, [string, number, string]> = { route: ["nav.route", 1000, "Moving between pages"], load: ["nav.load", 3000, "Opening the app"], api: ["api", 800, "Waiting for data"] };
/** Whether the last 7 days' slowest 1 in 10 met the target, as a chip and a sentence. */
function target(rows: SpeedRow[], key: string) {
  const [kind, goal, name] = TARGET[key];
  const last = rows.filter((r) => r.kind === kind).slice(-7).map((r) => r.p90).sort((a, b) => a - b);
  if (!last.length) return null;
  const mid = last[Math.floor(last.length / 2)];
  return <>{mid <= goal ? <Badge tone="success">Target met</Badge> : <Badge tone="warning">Slower than the goal</Badge>} {name}: 1 in 10 took over {secs(mid)} on a usual day this week (goal: {secs(goal)}).</>;
}
const KINDS: [keyof StruggleRow, string][] = [["dead", "clicks with no answer"], ["rage", "clicking again and again"], ["refused", "refused actions"], ["slowStarts", "pages slow to open"], ["errors", "errors"]];
const shortDay = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${d}T00:00:00Z`));
/** One sentence: the worst day and what made it worst. */
function worstDay(rows: StruggleRow[]) {
  const total = (r: StruggleRow) => KINDS.reduce((n, [k]) => n + Number(r[k] ?? 0), 0);
  const worst = [...rows].sort((a, b) => total(b) - total(a))[0];
  if (!worst || !total(worst)) return "No struggle moments in this period.";
  const [, main] = [...KINDS].sort((a, b) => Number(worst[b[0]]) - Number(worst[a[0]]))[0];
  return `The worst day was ${shortDay(worst.day)}: ${total(worst)} moments, mostly ${main}.`;
}

/** The most common path: from the biggest first page, the biggest next real page at each step. */
function topPath(j: Journey) {
  const real = (name: string) => !/ · (Other|Left)$/.test(name);
  let here = j.nodes.filter((n) => n.step === 0 && real(n.name)).sort((a, b) => b.views - a.views)[0]?.name;
  if (!here) return null;
  const path = [here.split(" · ")[1]];
  for (let k = 0; k < 3; k++) {
    const next = j.links.filter((l) => l.source === here && real(l.target)).sort((a, b) => b.value - a.value)[0];
    if (!next) break;
    path.push(next.target.split(" · ")[1]); here = next.target;
  }
  return path.length > 1 ? path.join(" → ") : null;
}

function journeyLine(j: Journey) {
  const first = j.nodes.filter((n) => n.step === 0 && n.page !== "Other").sort((a, b) => b.views - a.views)[0];
  const left = j.nodes.find((n) => n.name === "2 · Left");
  if (!first) return "";
  return `Most start on ${first.page} (${pct(first.views, j.sessions)}%).${left ? ` ${pct(left.views, j.sessions)}% leave after their first page.` : ""}`;
}

function Funnels({ s }: { s: Story }) {
  return <div className={css.funnels}>{s.funnels.map((f) => <div key={f.key} className={css.funnel}>
    <h3 className={css.h3}>{f.label}{f.steps[0].sessions ? <Badge tone={(f.steps[f.steps.length - 1].kept ?? 0) >= 60 ? "success" : "warning"}>{f.steps[f.steps.length - 1].kept ?? 0}% finish</Badge> : null}</h3>
    {f.steps[0].sessions ? <ol className={css.fsteps}>{f.steps.map((st, k) => <li key={st.label}>
      <span className={css.fl}>{st.label}</span>
      <span className={css.fbar}><i style={{ width: `${Math.max(2, pct(st.sessions, f.steps[0].sessions))}%` }} /></span>
      <span className={css.fv}>{st.sessions}{k ? ` · ${st.kept ?? 0}%` : ""}</span>
    </li>)}</ol> : <p className={css.muted}>Nobody started this in the period.</p>}
  </div>)}</div>;
}

function totals(c: Cost) {
  const runs = c.byDay.reduce((n, r) => n + r.runs, 0), ruled = c.byDay.reduce((n, r) => n + r.ruled, 0);
  return { runs, ruled, tokens: c.byDay.reduce((n, r) => n + r.tokens, 0), saved: c.byDay.reduce((n, r) => n + r.saved, 0), inr: c.byDay.reduce((n, r) => n + (r.inr ?? 0), 0) };
}
/** The overview's AI card: the four numbers and the link to the whole story. */
function AiSummary({ c, wide }: { c: Cost; wide?: boolean }) {
  const t = totals(c);
  if (!t.runs && !t.ruled) return <Box title="What AI employees cost"><EmptyState art="connect" title="No AI work yet" text="Once an AI employee starts working, you'll see what it costs here." action={{ href: "/people?tab=ai", label: "See AI employees" }} /></Box>;
  return <Box title="What AI employees cost" sub={`Last ${c.days} days`}>
    <Tiles count={wide ? 4 : 2} dense>
      <Kpi label="Tokens used" value={tok(t.tokens)} note={c.priced ? rupees(t.inr) : "No price set yet, so no rupees"} />
      <Kpi label="Tokens per job" value={tok(t.runs + t.ruled ? t.tokens / (t.runs + t.ruled) : 0)} note={`${tok(t.runs ? t.tokens / t.runs : 0)} per AI model run`} />
      <Kpi label="Done without AI" value={`${pct(t.ruled, t.runs + t.ruled)}%`} note={`${t.ruled} of ${t.runs + t.ruled} jobs`} />
      <Kpi label="Saved by rules" value={tok(t.saved)} note="Tokens those jobs usually cost" />
    </Tiles>
    <p className={css.foot}><Link className={styles.btn} href="/telemetry/insights?tab=ai">See where the tokens go</Link></p>
  </Box>;
}

const CLASS_WORDS: Record<string, [string, string]> = {
  small: ["Small answers", "Greetings, thanks, reminders: the smallest model"], lookup: ["Look-ups", "Questions about what is in Pulse: a fast model"],
  action: ["Jobs with tools", "Create, send, remind, quote: a fast model"], heavy: ["Heavy analysis", "Analyse, compare, plan, reconcile: the strongest model"],
  unrouted: ["Before Pulse picked the model", "Each ran on the model its AI employee was set to"] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekOf = (d: string) => { const [, m, day] = d.split("-").map(Number); return `${day} ${MONTHS[(m || 1) - 1]}`; };
/** TOKENS-2: which model did the work: the share on the strongest (dearest) model, week by week as bars, and each kind
 *  of request behind "Each kind of request" (the judge: the number and the trend first, the details after). */
function ModelChoice({ r }: { r: Router }) {
  const runs = r.classes.reduce((n, x) => n + x.runs, 0), strongest = r.classes.reduce((n, x) => n + x.strongest, 0), up = r.classes.reduce((n, x) => n + x.escalated, 0);
  if (!runs) return null;
  return <Box title="Which model did the work" sub={`Last ${r.days} days`}>
    <Tiles count={2} dense>
      <Kpi label="On the strongest model" value={`${pct(strongest, runs)}%`} note={`${strongest} of ${runs} runs`} />
      <Kpi label="Sent to a stronger model" value={String(up)} note="Times it needed more" />
    </Tiles>
    <p className={`${css.lead} ${css.gapTop}`}>Each request now gets the smallest model that does it well. Only heavy analysis needs the strongest, dearest one.</p>
    {r.weeks.length > 1 ? <><h3 className={css.h3}>On the strongest model, week by week</h3>
      <ul className={css.rows}>{r.weeks.map((w) => <li key={w.week} className={css.week}><span>Week of {weekOf(w.week)}</span>
        <span className={css.bar} aria-hidden="true"><i style={{ width: `${Math.max(w.strongest ? 2 : 0, pct(w.strongest, w.runs))}%` }} /></span>
        <span className={css.meta}>{pct(w.strongest, w.runs)}%</span></li>)}</ul></> : null}
    <details className={css.what} open><summary>Each kind of request</summary>
      <ul className={css.rows}>{r.classes.map((x) => { const [name, how] = CLASS_WORDS[x.class] ?? [x.class, ""];
        return <li key={x.class} className={css.kind}><span className={css.agentName}><b>{name}</b><span>{how}</span></span>
          <span className={css.meta}>{x.inr !== null && r.priced ? `${rupees(x.inr)} · ` : ""}{x.runs} runs{x.strongest ? ` · ${x.strongest} on the strongest model` : ""}{x.escalated ? ` · ${x.escalated} sent to a stronger model` : ""}</span></li>; })}</ul>
    </details>
  </Box>;
}

function AiCost({ c }: { c: Cost }) {
  const { runs, ruled, tokens, saved, inr } = totals(c);
  const types = new Map<string, { runs: number; tokens: number; ruled: number }>();
  for (const r of c.byDay) { const t = types.get(r.type) ?? { runs: 0, tokens: 0, ruled: 0 }; t.runs += r.runs; t.tokens += r.tokens; t.ruled += r.ruled; types.set(r.type, t); }
  const topTypes = [...types.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6);
  const agents = c.agents.filter((a) => a.runs > 0 || a.ruled > 0);
  const perRun = new Map((c.router?.types ?? []).map((t) => [t.taskType, t.inrPerRun]));
  const waiting = (c.router?.patterns ?? []).filter((p) => p.state === "candidate"), rules = c.rules.filter((r) => r.state !== "candidate");
  if (!runs && !ruled) return <Box title="What AI employees cost"><EmptyState art="connect" title="No AI work yet" text="Once an AI employee starts working, you'll see what it costs here." action={{ href: "/people?tab=ai", label: "See AI employees" }} /></Box>;
  return <>
    <Box title="What AI employees cost" sub={`Last ${c.days} days`}>
      <p className={css.lead}>{runs} jobs went to an AI model and {ruled} were done by a rule. A rule&apos;s job costs no tokens.</p>
      <Tiles count={4} dense>
        <Kpi label="Tokens used" value={tok(tokens)} note={c.priced ? rupees(inr) : "No price set yet, so no rupees"} />
        <Kpi label="Tokens per job" value={tok(runs + ruled ? tokens / (runs + ruled) : 0)} note={`${tok(runs ? tokens / runs : 0)} per model run`} />
        <Kpi label="Done without AI" value={`${pct(ruled, runs + ruled)}%`} note={`${ruled} of ${runs + ruled} jobs`} tone={ruled ? "success" : undefined} />
        <Kpi label="Tokens saved by rules" value={tok(saved)} note="What those jobs usually cost" />
      </Tiles>
      <div className={css.grid2}>
        <div><h3 className={css.h3}>Tokens per day, by kind of work</h3><CostChart rows={c.byDay} /></div>
        <div><h3 className={css.h3}>Tokens per job, week by week</h3><PerJobChart rows={c.byDay} /></div>
      </div>
    </Box>
    <div className={css.grid2}>
      <div className={css.stack}>
      <Box title="Each AI employee today" sub="Against its daily limit">
        <p className={css.lead}>A warning at 80%. At the limit it asks its manager for more; it never stops silently.</p>
        <ul className={css.rows}>{agents.map((a) => <li key={a.id} className={css.agent}>
          <span className={css.agentName}><b>{a.name}</b><span>Last {c.days} days: {a.runs} runs · {tok(a.tokens)} tokens{a.inr !== null ? ` · ${rupees(a.inr)}` : ""}{a.ruled ? ` · ${a.ruled} by rules` : ""}</span></span>
          <span className={css.budget}>
            <span className={css.bar} aria-hidden="true"><i style={{ width: `${Math.min(100, pct(a.today, a.budget ?? 0))}%` }} data-warn={a.warn ? "" : undefined} /></span>
            <span className={css.budgetText}>Today: {tok(a.today)} of {a.budget ? tok(a.budget) : "no limit"}{a.warn ? <Badge tone="warning">Near its limit</Badge> : null}</span>
            <span className={css.budgetHint}>Suggested daily limit: {tok(a.suggested)} (its busy days, with room){a.waitedForBudget ? ` · ${a.waitedForBudget} jobs waited for budget` : ""}</span>
          </span>
        </li>)}</ul>
      </Box>
      {rules.length ? <Box title="Rules that save tokens" sub="Jobs done without an AI model"><ul className={css.rows}>{rules.map((r) => <li key={r.key} className={css.rule}>
          <span>{r.title}</span>{r.state !== "active" ? <Badge tone="neutral">Off</Badge> : <Badge tone="success">On</Badge>}<span className={css.meta}>Used {r.uses} {r.uses === 1 ? "time" : "times"} · {tok(r.saved)} tokens saved</span>
        </li>)}</ul></Box> : null}
      {c.router ? <Box title="Waiting for your review" sub="Jobs done the same way again and again">
        <p className={css.lead}>Make it a rule and AI employees follow those steps on a cheaper model. Choose &ldquo;Not now&rdquo; and it won&apos;t be suggested again.</p>
        <PatternReview items={waiting} canReview={!!c.canReview} />
      </Box> : null}
      </div>
      <div className={css.stack}>
      <Box title="Where the tokens go" sub="By kind of work">
        <ul className={css.rows}>{topTypes.map(([t, x]) => <li key={t} className={css.type}>
          <span>{typeName(t)}</span><span className={css.meta}>{x.runs} runs · {tok(x.runs ? x.tokens / x.runs : 0)} tokens each{perRun.get(t) != null && c.priced ? ` · ${rupees(perRun.get(t)!)} a job` : ""}{x.ruled ? ` · ${x.ruled} done by rules` : ""}</span>
        </li>)}</ul>
      </Box>
      {c.router ? <ModelChoice r={c.router} /> : null}

      </div>
    </div>
  </>;
}

const TABS = [{ key: "overview", label: "Summary" }, { key: "journeys", label: "Paths" }, { key: "speed", label: "Speed" }, { key: "struggle", label: "Struggle" }, { key: "ai", label: "AI cost" }];

export default async function Insights({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const days = q.days === "7" ? 7 : 30;
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab! : "overview";
  const speed = ["route", "load", "api"].includes(q.speed ?? "") ? q.speed! : "route";
  const [story, cost] = await Promise.all([api<Story>(`telemetry/story?days=${days}`), tab === "overview" || tab === "ai" ? api<Cost>(`telemetry/ai-cost?days=${days}`) : Promise.resolve(null)]);
  if (story.error || !story.data) return <Message text={story.status === 403 ? "Insights are for leadership" : story.error ?? "Insights could not load"} />;
  const s = story.data;
  const keep = (drop: string) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ days: String(days), speed, tab })) if (k !== drop && v) p.set(k, v); return p.toString(); };
  const noUse = !s.journeys.sessions && !s.speed.length;
  const c = cost?.data ?? null;
  return <Page>
    <PageHeader title="Insights" back={{ href: "/telemetry", label: "Telemetry" }} context={["What changed, how people move, where they struggle, and what AI costs"]} />
    {noUse ? <div className={`${css.grid2} ${css.even}`}>
      <Box title="How your team uses Pulse"><EmptyState title="Nothing to show yet" text="Once your team uses Pulse, you'll see where people go, how fast pages open and where they get stuck." action={{ href: "/people", label: "Invite your team" }} /></Box>
      {c ? <AiSummary c={c} /> : null}
    </div> : <>
      <div className={css.bar0}>
        <div className={css.tabsRow}><QueryTabs base="/telemetry/insights" param="tab" current={tab} keep={keep("tab")} sub label="Insights" items={TABS} /></div>
        <QueryTabs base="/telemetry/insights" param="days" current={String(days)} keep={keep("days")} sub label="Period" items={[{ key: "30", label: "30 days" }, { key: "7", label: "7 days" }]} />
      </div>
      {tab === "overview" ? <>
        <Digest s={s} />
        {c ? <AiSummary c={c} wide /> : null}
        <Box title="Key jobs" sub="Visits that reached each step"><Funnels s={s} /></Box>
      </> : null}
      {tab === "journeys" ? <>
        <Box title="Where people go" sub="The first four pages of each visit">
          {topPath(s.journeys) ? <p className={css.headline}>Most common path: <b>{topPath(s.journeys)}</b></p> : null}
          <p className={css.lead}>{s.journeys.sessions} visits, step by step from the left. Grey bands are people who left there. {journeyLine(s.journeys)}</p>
          <p className={css.swipe}>Swipe the map sideways to see every step →</p>
          <div className={css.edge}><div className={css.scrollX}><div className={css.sankey}>
            <div className={css.steps} aria-hidden="true"><span>1st page</span><span>2nd page</span><span>3rd page</span><span>4th page</span></div>
            <JourneyChart data={s.journeys} />
          </div></div></div>
        </Box>
        <Box title="Key jobs" sub="Visits that reached each step"><Funnels s={s} /></Box>
      </> : null}
      {tab === "speed" ? <>
        <Box title="Speed" sub="Per day, against the target">
          <p className={css.lead}>&ldquo;Usual&rdquo; is the typical wait. &ldquo;Slowest 1 in 10&rdquo; is how long the slowest tenth of waits took: what people complain about.</p>
          <nav className={css.chips} aria-label="Speed of">{[["route", "Moving between pages"], ["load", "Opening the app"], ["api", "Waiting for data"]].map(([k, label]) => <Link key={k} href={`/telemetry/insights?${keep("speed")}&speed=${k}`} scroll={false} aria-current={speed === k ? "page" : undefined}>{label}</Link>)}</nav>
          <p className={css.target}>{target(s.speed, speed)}</p>
          <SpeedChart rows={s.speed} kind={speed === "load" ? "nav.load" : speed === "api" ? "api" : "nav.route"} />
        </Box>
        <Box title="The most opened pages" sub="The slowest 1 in 10 moves, per day">
          <p className={css.lead}>Under 1 second is good. A line going down means that page got faster.</p>
          <PagesChart rows={s.pages} />
        </Box>
      </> : null}
      {tab === "struggle" ? <Box title="Where people struggle" sub="Moments per day, by kind">
        <p className={css.lead}>{worstDay(s.struggle)}</p>
        <details className={css.what}><summary>What do these mean?</summary>
          <ul><li><b>No answer:</b> a click that got no response.</li><li><b>Clicked again:</b> the same thing clicked again and again.</li><li><b>Refused:</b> Pulse said no to the action.</li><li><b>Slow to open:</b> a page took 10 seconds or more.</li><li><b>Errors:</b> something broke on the screen.</li></ul>
        </details>
        <StruggleChart rows={s.struggle} />
        <p className={css.foot}><Link className={styles.btn} href="/telemetry/day">See one person&apos;s day and replays</Link></p>
      </Box> : null}
      {tab === "ai" && c ? <AiCost c={c} /> : null}
    </>}
  </Page>;
}
