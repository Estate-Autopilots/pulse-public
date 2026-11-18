// ERROR-SWEEP (owner, 17 Nov 2026): Telemetry → Error budget. Errors per day per cause, new vs known, so a regression
// shows the same day it ships. Data: GET /api/v0/telemetry/errors (services/api/src/telemetry-errors.ts).
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Columns } from "../charts";
import { Badge, Kpi, Panel, Tiles, styles } from "../ui";
import css from "./errors.module.css";

export type ErrorBudget = {
  days: number; zone: string; since: string;
  perDay: { day: string; total: number; fresh: number }[];
  causes: { key: string; title: string; label: string; area: "screen" | "live" | "server" | "refused" | "connection"; people: number; total: number; perDay: number[];
    firstSeen: string; lastSeen: string; state: "new" | "back" | "known"; pages: string[] }[];
  today: { errors: number; yesterday: number; newCauses: number; backCauses: number; open: number };
};

const AREA: Record<ErrorBudget["causes"][number]["area"], string> = {
  screen: "On a page", live: "Live updates", server: "Server", refused: "Blocked", connection: "Calls",
};
const STATE = { new: { tone: "danger", text: "New" }, back: { tone: "warning", text: "Back" }, known: { tone: "neutral", text: "Known" } } as const;
// The screen a path belongs to, by the name people see in the menu (the first part of the path).
const SCREEN: Record<string, string> = { "": "Home", dashboard: "Home", "my-day": "My day", tasks: "Work", chats: "Chats", calls: "Chats", docs: "Docs", people: "People",
  hr: "HR", me: "Me", finance: "Money", money: "Money", erp: "Billing", acquisition: "Sales", clients: "Clients", calendar: "Calendar", settings: "Settings",
  telemetry: "Telemetry", goals: "Goals", contracts: "Contracts", pr: "PR Studio", map: "Map", directory: "People", listen: "Listen", profile: "Profile" };
const screenOf = (page: string) => { const first = page.replace(/^\//, "").split(/[/?#]/)[0] ?? ""; return SCREEN[first] ?? (first ? first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, " ") : "Home"); };
/** "Money", or "Work +1": the first screen, and how many others, on one line. */
function screens(pages: string[]) {
  const names = [...new Set(pages.map(screenOf))];
  return names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "";
}
const shortDay = (day: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** More errors than yesterday is bad news: up in the danger colour, down in the success colour, with words, never colour alone. */
function Change({ now, before }: { now: number; before: number }) {
  const diff = now - before;
  if (!diff) return <span className={css.change} data-way="same">Same as yesterday</span>;
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={css.change} data-way={diff > 0 ? "up" : "down"}><Icon size={14} aria-hidden="true" />{Math.abs(diff)} {diff > 0 ? "more" : "fewer"} than yesterday</span>;
}

/** The 14 days of one cause as a strip, drawn every time (an empty day is a short grey mark), today last and darkest. */
function Strip({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return <span className={css.strip} role="img" aria-label={label}>{values.map((v, i) => <i key={i} data-some={v ? "" : undefined} data-today={i === values.length - 1 ? "" : undefined} style={{ height: `${v ? Math.max(18, (v / max) * 100) : 8}%` }} />)}</span>;
}

export function ErrorBudgetView({ e }: { e: ErrorBudget }) {
  const t = e.today;
  const shown = e.causes.slice(0, 40);
  const top = shown.reduce((best, c, i) => (c.people > (shown[best]?.people ?? -1) ? i : best), 0);
  const last = e.perDay.length - 1;
  const first = e.perDay[0]?.day, end = e.perDay[last]?.day;
  return <>
    <Tiles count={4} dense>
      <Kpi label="Errors today" value={t.errors} note={<Change now={t.errors} before={t.yesterday} />} tone={t.errors > t.yesterday ? "danger" : "success"} />
      <Kpi label="New causes" value={t.newCauses ? <span className={css.alert}>{t.newCauses}</span> : 0} note={t.newCauses ? "New today" : "Nothing new"} tone={t.newCauses ? "danger" : "success"} />
      <Kpi label="Back again" value={t.backCauses} note="After 3+ quiet days" tone={t.backCauses ? "warning" : "success"} />
      <Kpi label="Still happening" value={t.open} note="Seen in 2 days" tone={t.open ? "warning" : "success"} />
    </Tiles>
    <Panel title="Errors by day" sub={first && end ? `${shortDay(first)} to ${shortDay(end)}. Coloured bars: a new problem started that day.` : undefined}>
      <Columns label="Errors by day" items={e.perDay.map((d) => ({ key: d.day, label: d.day.slice(8).replace(/^0/, ""), value: d.total, on: d.fresh > 0,
        tip: plural(d.total, "error"), tipSub: `${shortDay(d.day)} · ${d.fresh ? `${d.fresh} from a new cause` : "no new cause"}` }))} />
    </Panel>
    <Panel title="Causes" sub="Newest problems first, then the ones reaching the most people." foot="Not counted: phones that were offline, signed-out visits and automatic checks.">
      {shown.length ? <ul className={css.causes} aria-label="Error causes">
        <li className={css.headRow} aria-hidden="true"><span>Cause</span><span>People</span><span>Today</span><span>{e.days} days</span><span>Each day</span></li>
        {shown.map((c, i) => {
          const daysSeen = c.perDay.filter((n) => n > 0).length;
          const where = screens(c.pages);
          return <li key={c.key} className={css.cause}>
            <div className={css.what}>
              <span className={css.head}><Badge tone={STATE[c.state].tone}>{STATE[c.state].text}</Badge><b>{c.title}</b>{i === top && c.people > 1 ? <Badge tone="accent">Most people</Badge> : null}</span>
              <span className={css.where}>{AREA[c.area]}{where ? ` · ${where}` : ""} · since {shortDay(c.firstSeen)}</span>
            </div>
            <dl className={css.nums}>
              <div data-main=""><dt className={css.srOnlyWide}>People</dt><dd>{c.people || "–"}</dd></div>
              <div><dt className={css.srOnlyWide}>Today</dt><dd>{c.perDay[last] || "–"}</dd></div>
              <div><dt className={css.srOnlyWide}>{e.days} days</dt><dd>{c.total}</dd></div>
            </dl>
            <div className={css.trend}>
              <Strip values={c.perDay} label={`${c.title}: ${c.perDay.join(", ")} a day`} />
              <span className={css.seen}>Seen {daysSeen} of {e.days} days</span>
            </div>
            <details className={css.details}><summary>Details</summary><code className={css.code}>{c.label}</code>{c.pages.length ? <code className={css.code}>{c.pages.join("  ")}</code> : null}</details>
          </li>;
        })}
      </ul> : <p className={styles.chartEmpty}>No errors in these {e.days} days. Nice and quiet.</p>}
    </Panel>
  </>;
}
