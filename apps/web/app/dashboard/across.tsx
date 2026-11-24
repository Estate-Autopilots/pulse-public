"use client";
// CONNECTIONS part A (owner, 16 Nov 2026: "the dashboard looks very ugly, has no purpose"): the home of someone who works
// in several companies, opened in their own personal space. Codex concept 1 (reports/connections/concepts/home): on a
// computer two columns: TODAY and WAITING ON YOU on the left; MONEY, YOUR COMPANIES and WHO YOU WORK WITH on the right;
// on a phone one column in that order. One primary button (Open My day). Every list says which company a thing lives in;
// opening a thing of another company moves into it first (the switcher's own switch). Test and demo companies are listed
// apart and never counted. Read only, except the round tick that marks one of your own tasks done.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Building2, Check, Handshake, Hourglass, IndianRupee, Loader2, Sun } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Chip, EmptyState, GameCard, GamePage, PageHeader, celebrate } from "../kit/game";
import { CompanyMark } from "../company-mark";
import { buildDay, type DayData, type DayItem } from "../lib/my-day.mjs";
import { money, needsOf, type FounderData } from "../lib/founder.mjs";
import { collectTotal, greeting, moneyRows, summaryLine, waitingCount, waitingItems, type Waiting } from "../lib/across-home.mjs";
import { companiesText, groupWorkWith, practiceLine, type WorkWith } from "../lib/companies.mjs";
import { openCompany, post } from "../orgs/client";
import { shortDay } from "../tasks/parts";
import css from "./across.module.css";

export type CompanyIn = { org: string; name: string; handle: string | null; current: boolean; seat: string; personal: boolean; purpose: "work" | "test" | "demo";
  mark: string | null; accent: string | null; people: number | null };
export type HomeCompanies = { companies: CompanyIn[]; personal: CompanyIn | null; practice: { org: string; name: string; purpose: string; mark: string | null; current: boolean }[];
  workWith: WorkWith[]; unavailable: string[] };
type ContractLite = { key: string; canAccept: boolean; title: string; heldBy: string | null; parties?: { name: string; mine: boolean }[] };
export type AcrossData = { name: string | null; hour: number; day: DayData | null; founder: FounderData | null; contracts: ContractLite[] | null; companies: HomeCompanies | null };

const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const daysLate = (due: string, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);

/** When a task is due, as a small chip: late in rose, today in amber. */
function due(i: DayItem, today: string): { text: string; tone?: "bad" | "warn" } | null {
  if (i.dueOn && i.dueOn < today) { const d = daysLate(i.dueOn, today); return { text: d === 1 ? "1 day late" : `${d} days late`, tone: "bad" }; }
  if (i.dueOn === today || i.section === "today" || i.section === "doing") return { text: i.dueTime ? `Due ${i.dueTime}` : "Due today", tone: "warn" };
  if (i.dueOn) return { text: shortDay(i.dueOn) };
  return null;
}

/** Into a thing's own company first (when it is another one), then its page. */
async function openThere(where: { org: string | null; orgName: string | null; current?: boolean }, href: string, go: (h: string) => void) {
  if (!where.org || where.current) { go(href); return; }
  try { await openCompany(where.org, where.orgName ?? "the company", href); }
  catch (e) { notify({ id: "across-open", tone: "error", title: "Could not open it", message: message(e) }); }
}

export function AcrossHome({ data }: { data: AcrossData }) {
  const router = useRouter();
  const go = (href: string) => router.push(href);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const day = useMemo(() => data.day ? buildDay(data.day, Date.parse(data.day.generatedAt) || 0, []) : null, [data.day]);
  const today = data.day?.seats.find((s) => s.ok && s.today)?.today ?? "";
  // Today: the tasks to start with, then what is late, then what is due today (each once), at most six.
  const tasks = useMemo(() => {
    if (!day) return [] as DayItem[];
    const seen = new Set<string>(); const out: DayItem[] = [];
    const take = (list: DayItem[]) => { for (const i of list) { const k = `${i.org}:${i.id}`; if (!seen.has(k) && !gone.has(k)) { seen.add(k); out.push(i); } } };
    take(day.focus);
    for (const key of ["doing", "overdue", "scheduled", "today"] as const) take(day.sections.find((s) => s.key === key)?.items ?? []);
    return out.slice(0, 6);
  }, [day, gone]);
  const t = day?.totals ?? { overdue: 0, today: 0, doing: 0, done: 0, planned: 0, actual: 0 };
  const open = t.overdue + t.today + t.doing;

  const cards = data.founder?.cards ?? [];
  const rows = moneyRows(cards);
  const collect = collectTotal(rows);
  const waiting = waitingItems({ cards, contracts: data.contracts ?? [] });
  const waitingN = waitingCount({ cards, contracts: data.contracts ?? [] });
  const companies = data.companies?.companies ?? [];
  const practice = data.companies?.practice ?? [];
  const workWith = groupWorkWith(data.companies?.workWith ?? []);
  const health = new Map(cards.map((c) => [c.org, needsOf(c.today)]));
  const dateText = today ? new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`)) : null;

  async function done(i: DayItem) {
    const k = `${i.org}:${i.id}`; setBusy(k);
    try {
      await post("tasks/my-day/act", { org: i.org, task: i.id, action: "done" });
      setGone((g) => new Set(g).add(k));
      notify({ id: "across-done", tone: "success", title: "Done", message: i.title, timeout: 2500 });
      celebrate(null, { big: open <= 1, id: open <= 1 && today ? `across-all-done:${today}` : undefined });
    } catch (e) { notify({ id: "across-act", tone: "error", title: "Not marked done", message: message(e) }); }
    finally { setBusy(null); }
  }

  return <GamePage label="Home">
    <div className={css.topGap} aria-hidden="true" />
    <PageHeader eyebrow={[dateText, companies.length ? companiesText(companies.length) : null].filter(Boolean).join(" · ") || undefined}
      title={greeting(data.hour, data.name)} subtitle={summaryLine({ late: t.overdue, today: open, waiting: waitingN, collect })}
      primary={{ label: "Open My day", href: "/my-day", icon: Sun }} />

    <div className={css.cols}>
      <div className={css.col}>
        <GameCard title="Today" icon={Sun} note={day ? (open ? `${t.done} of ${t.done + open} done` : t.done ? "All done" : null) : null}>
          {!data.day ? <p className={css.muted} role="status">Your tasks could not be read just now. Refresh in a moment.</p>
            : tasks.length ? <ul className={css.list}>{tasks.map((i) => { const d = due(i, today); const k = `${i.org}:${i.id}`;
              return <li key={k} className={css.row}>
                <CompanyMark name={i.orgName} mark={i.mark} color={i.color} size={32} />
                <button type="button" className={css.rowMain} onClick={() => void openThere({ org: i.org, orgName: i.orgName, current: i.current }, `/tasks/${i.id}`, go)}>
                  <b className={css.rowTitle}>{i.title}</b><small className={css.rowSub}>{i.orgName}</small>
                  {d ? <span className={css.chip} data-tone={d.tone} data-narrow="">{d.text}</span> : null}
                </button>
                {d ? <span className={css.chip} data-tone={d.tone} data-wide="">{d.text}</span> : null}
                <button type="button" className={css.tick} aria-label={`Mark “${i.title}” done`} disabled={!!busy} onClick={() => void done(i)}>
                  {busy === k ? <Loader2 size={16} className={css.spin} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}</button>
              </li>; })}</ul>
            : <EmptyState art="done" title={t.done ? "All done for today" : "Nothing due today"} text="New work from any of your companies shows here." />}
          {open > tasks.length ? <Link className={css.more} href="/my-day">{open - tasks.length} more in My day<ArrowRight size={14} aria-hidden="true" /></Link> : null}
        </GameCard>

        <GameCard title="Waiting on you" icon={Hourglass} note={waitingN ? String(waitingN) : null}>
          {waiting.length ? <ul className={css.list}>{waiting.map((w: Waiting) => <li key={w.key} className={css.row}>
            {w.org ? <CompanyMark name={w.orgName ?? w.who} mark={w.mark} color={w.accent} size={32} /> : <span className={css.badge} aria-hidden="true"><Handshake size={16} /></span>}
            <span className={css.rowMain} data-static="">
              <b className={css.rowTitle}>{w.who}</b><small className={css.rowSub}>{w.what}{w.where ? ` · ${w.where}` : ""}</small>
            </span>
            <button type="button" className={css.link} onClick={() => void openThere(w, w.href, go)}>{w.action}</button>
          </li>)}</ul>
            : <p className={css.quiet}><Check size={15} aria-hidden="true" />Nobody is waiting on you right now.</p>}
        </GameCard>

        <div className={css.wideOnly}>
        <GameCard title="Who you work with" icon={Handshake} note={workWith.length ? String(workWith.length) : null}>
          {workWith.length ? <ul className={css.list}>{workWith.map((w) => <li key={w.key} className={css.row}>
            <CompanyMark name={w.name} size={32} />
            <span className={css.rowMain} data-static=""><b className={css.rowTitle}>{w.name}</b><small className={css.rowSub}>{w.lines.join(" · ")}</small></span>
          </li>)}</ul>
            : <p className={css.quiet}>No one yet. Add the people and companies you work with, and see what you agreed and share.</p>}
          <Link className={css.more} href="/connections">Agreements, shared docs and tasks<ArrowRight size={14} aria-hidden="true" /></Link>
          {data.companies?.unavailable?.length ? <p className={css.foot} role="status">Could not read {data.companies.unavailable.join(", ")} just now.</p> : null}
        </GameCard>
        </div>
      </div>

      <div className={css.col}>
        {rows.length ? <GameCard title="Money" icon={IndianRupee} note={collect ? `${money(collect)} to collect` : null}>
          <div className={css.tableBox}><table className={css.table}>
            <thead><tr><th scope="col">Company</th><th scope="col">Late</th><th scope="col">Due in 7 days</th><th scope="col" data-wide="">Not billed</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.org}>
              <th scope="row"><span className={css.cell}><CompanyMark name={r.name} mark={r.mark} color={r.accent} size={20} /><span>{r.name}</span></span>
                {r.unbilled ? <small className={css.under} data-narrow="">Not billed {money(r.unbilled)}</small> : null}</th>
              <td data-tone={r.late ? "bad" : undefined}>{r.late ? money(r.late) : "–"}</td><td>{r.due ? money(r.due) : "–"}</td><td data-wide="">{r.unbilled ? money(r.unbilled) : "–"}</td>
            </tr>)}</tbody>
          </table></div>
        </GameCard> : null}

        <GameCard title="Companies you're in" icon={Building2} note={companies.length ? String(companies.length) : null}>
          {companies.length ? <ul className={css.list}>{companies.map((c) => { const h = health.get(c.org);
            return <li key={c.org} className={css.row}>
              <CompanyMark name={c.name} mark={c.mark} color={c.accent} size={32} />
              <button type="button" className={css.rowMain} onClick={() => void openThere({ org: c.org, orgName: c.name, current: c.current }, "/dashboard", go)}>
                <b className={css.rowTitle}>{c.name}</b><small className={css.rowSub}>{[c.seat !== "staff" ? c.seat[0].toUpperCase() + c.seat.slice(1) : null, c.people ? `${c.people} ${c.people === 1 ? "person" : "people"}` : null, c.current ? "Open in this tab" : null].filter(Boolean).join(" · ")}</small>
              </button>
              {h ? <Chip tone={h.tone}>{h.text.replace(/ things? needs? you$/, " need you")}</Chip> : null}
            </li>; })}</ul>
            : <EmptyState art="connect" title="No companies yet" text="When you start a company or someone adds you to theirs, it shows here." action={{ label: "Start a company", href: "/orgs/new" }} />}
          {practice.length ? <p className={css.foot}>{practiceLine(practice)}</p> : null}
        </GameCard>
        <div className={css.narrowOnly}>
        <GameCard title="Who you work with" icon={Handshake} note={workWith.length ? String(workWith.length) : null}>
          {workWith.length ? <ul className={css.list}>{workWith.map((w) => <li key={w.key} className={css.row}>
            <CompanyMark name={w.name} size={32} />
            <span className={css.rowMain} data-static=""><b className={css.rowTitle}>{w.name}</b><small className={css.rowSub}>{w.lines.join(" · ")}</small></span>
          </li>)}</ul>
            : <p className={css.quiet}>No one yet. Add the people and companies you work with, and see what you agreed and share.</p>}
          <Link className={css.more} href="/connections">Agreements, shared docs and tasks<ArrowRight size={14} aria-hidden="true" /></Link>
          {data.companies?.unavailable?.length ? <p className={css.foot} role="status">Could not read {data.companies.unavailable.join(", ")} just now.</p> : null}
        </GameCard>
        </div>


      </div>
    </div>
  </GamePage>;
}
