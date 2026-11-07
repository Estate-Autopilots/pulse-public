import Link from "next/link";
import type { ReactNode } from "react";
import { Award, CalendarCheck, CheckCheck, ClipboardCheck, Flame, IndianRupee, Inbox, Sprout, Sun, Wallet } from "lucide-react";
import { day, dayYear, plural, time } from "../lib/format";
import { Avatar } from "../ui";
import { DeskTile, ThankButton } from "./my-pulse-actions";
import { dest } from "../destinations/registry.mjs";
import css from "./my-pulse.module.css";

/** LIFECYCLE part 5: what My Pulse reads (the viewer's own records only). */
export type MyPulse = {
  person: { id: string; name: string; role: string | null; pod: string | null; department: string | null; joinedOn: string | null; stage: string; probationTo: string | null; lastWorkingDay: string | null; photoAt: string | null };
  today: { date: string; hour: number; due: { id: string; title: string; status: string; dueAt: string; late: boolean }[]; open: number; inProgress: number; shift: { name: string; start: string; end: string } | null; workingDay: boolean | null };
  week: { from: string; done: number; accepted: number; deliveries: number; minutes: number; checkInMinutes: number; streak: number };
  growth: { domains: { id: string; title: string; status: string; basis: string }[]; kinds: { key: string; label: string; recent: number; before: number }[];
    feedback: { kind: "accepted" | "returned"; text: string; task: string; taskId: string; by: string | null; at: string }[]; learnNext: { key: string; label: string; open: number; doers: number }[] };
  money: { payslips: { month: string; version: number; issuedAt: string; net: number | null; reimbursements: number | null; href?: string }[]; leaveKind: string | null; leaveDays: number | null; compOffDays: number; incentives: null };
  recognition: { kudos: { id: string; from: { id: string; name: string }; note: string; at: string; task: { id: string; title: string } | null }[]; given: number;
    accepted: { id: string; title: string; at: string; by: string | null }[] };
  knows: { key: string; label: string; value: string | number | null; source: string }[];
  value: { month: string; units: number; tasks: number; accepted: number; deliveries: number; acceptRate: number | null; onTimeRate: number | null }[];
  colleagues: { id: string; name: string; pod: string | null }[];
};
/** What waits for the person's decision: work to review, team requests to approve. */
export type Waiting = { reviews: number; oldestReviewHours: number | null; approvals: number };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const hours = (m: number) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
const greeting = (h: number) => h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
const rupees = (n: number | null) => n === null ? null : `₹${Math.round(n).toLocaleString("en-IN")}`;
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];

function Card({ title, label, icon, aside, children, id, className, ...anchor }: { title: string; /** The region's name when the title is another region's too. */ label?: string; icon: ReactNode; aside?: ReactNode; children: ReactNode; id?: string; className?: string; "data-dest"?: string }) {
  return <section className={`${css.card}${className ? ` ${className}` : ""}`} aria-label={label ?? title} id={id} {...anchor}><header><h3>{icon}{title}</h3>{aside}</header>{children}</section>;
}

/** UX-5A (owner, 13 Oct 2026: "far too cluttered"): My desk in order of what matters now. On top, today (a compact
 *  check-in, or a small chip for outcome-based people), what is due today and what waits for the person; then the week;
 *  then compact tiles (recognition, growth, money, time off, requests, what is coming up, the team) that open their
 *  details in the side drawer. What Pulse knows about the person lives on their profile (My info). */
export function MyPulseHome({ d, today, waiting, tiles, banner, offDay, payslip }: { d: MyPulse; today: ReactNode; waiting: Waiting; tiles?: ReactNode; banner?: ReactNode; offDay?: ReactNode; payslip?: ReactNode }) {
  const name = first(d.person.name);
  const v = d.value.at(-1), prev = d.value.at(-2);
  const fresh = d.growth.kinds.filter((k) => k.recent > 0 && k.before === 0);
  // READY: late tasks are named as late ("2 tasks due today" read wrong when both were days late).
  const late = d.today.due.filter((t) => t.late).length, dueNow = d.today.due.length - late;
  const line = [d.today.due.length ? [dueNow ? `${plural(dueNow, "task")} due today` : null, late ? `${plural(late, "task")} late` : null].filter(Boolean).join(", ") : d.today.open ? `${plural(d.today.open, "open task")}` : "Nothing due today",
    d.week.streak > 1 ? `${d.week.streak}-day streak` : null,
    d.person.stage === "probation" && d.person.probationTo ? `probation until ${dayYear(d.person.probationTo)}` : d.person.stage === "notice" && d.person.lastWorkingDay ? `last day ${dayYear(d.person.lastWorkingDay)}` : null].filter(Boolean).join(" · ");
  const due = d.today.due.slice(0, 4), more = d.today.due.length - due.length;
  const kudo = d.recognition.kudos[0];
  const payslipLatest = d.money.payslips[0];
  const waits = waiting.reviews || waiting.approvals;
  return <div className={css.home} data-my-pulse="">
    {/* Owner workbench (21 Oct 2026): a personal hero (who, which day, one greeting, today in a line) instead of the
        page title repeated as a second greeting; "Finish your profile" rides beside it, small, until it is done. */}
    <section className={css.hero} aria-label="You today">
      <Avatar name={d.person.name} id={d.person.id} photoAt={d.person.photoAt} size={56} />
      <div className={css.heroText}>
        <p className={css.heroDate}>{new Date(`${d.today.date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
        <h2>{greeting(d.today.hour)}, {name}</h2>
        <p>{line}</p>
        {offDay}
      </div>
      {banner ? <div className={css.heroAside}>{banner}</div> : null}
    </section>
    {/* EST-1196: today's check-in first. What is due and what waits for the person's decision are one Today card; the
        check-in is the "Today" region, so this card is named "Due today" (one name per region). */}
    <div className={css.top}>
      {today ? <div className={css.todaySlot} {...dest("me.today")}>{today}</div> : null}
      <Card title="Today" label="Due today" {...dest("me.due")} className={css.todayCard} icon={<CalendarCheck size={15} aria-hidden="true" />} aside={<Link href="/tasks?scope=me">My work</Link>}>
        {waits ? <ul className={css.waits} aria-label="Waiting for you">
          {waiting.reviews ? <li><Link href="/tasks?view=reviews"><ClipboardCheck size={15} aria-hidden="true" /><span>Work to review<small>{waiting.oldestReviewHours && waiting.oldestReviewHours >= 24 ? `oldest ${Math.floor(waiting.oldestReviewHours / 24)} d` : "finished by your team"}</small></span><b>{waiting.reviews}</b></Link></li> : null}
          {waiting.approvals ? <li><Link href="/me/approvals"><Inbox size={15} aria-hidden="true" /><span>Requests to decide<small>leave, corrections, day-off work</small></span><b>{waiting.approvals}</b></Link></li> : null}
        </ul> : null}
        {due.length ? <ul className={css.list} aria-label="Due today">{due.map((t) => <li key={t.id}><span><Link href={`/tasks/${t.id}`}><b>{t.title}</b></Link>
          <small className={t.late ? css.late : undefined}>{t.late ? `was due ${day(t.dueAt)}` : `by ${time(t.dueAt)}`}{t.status === "in_progress" ? " · doing" : ""}</small></span></li>)}</ul> : null}
        {!due.length && !waits ? <div className={css.clear}><span className={css.clearIcon}><CheckCheck size={18} aria-hidden="true" /></span>
          <span><b>All clear</b><small>Nothing due today and nothing waiting for you.{d.today.open ? <> <Link href="/tasks?scope=me">{plural(d.today.open, "open task")}</Link> when you are ready.</> : null}</small></span></div>
          : !due.length ? <p className={css.empty}><CheckCheck size={15} aria-hidden="true" /><span>Nothing due today.{d.today.open ? <> <Link href="/tasks?scope=me">{plural(d.today.open, "open task")}</Link> when you are ready.</> : null}</span></p> : null}
        {more > 0 ? <Link className={css.more} href="/tasks?scope=me">{more} more due today</Link> : null}
      </Card>
    </div>
    <Card title="My week" {...dest("me.week")} icon={<Flame size={15} aria-hidden="true" />} className={css.week} aside={<small>since {day(d.week.from)}</small>}>
      <dl className={css.stats}>
        <div><dt>finished</dt><dd>{d.week.done}</dd></div>
        <div><dt>accepted</dt><dd>{d.week.accepted}</dd></div>
        <div><dt>day streak</dt><dd>{d.week.streak}</dd></div>
        <div><dt>{d.week.minutes ? "on tasks" : "checked in"}</dt><dd>{hours(d.week.minutes || d.week.checkInMinutes)}</dd></div>
        {d.week.deliveries ? <div><dt>{d.week.deliveries === 1 ? "delivery" : "deliveries"}</dt><dd>{d.week.deliveries}</dd></div> : null}
        {v ? <div><dt>work units this month{prev ? (v.units >= prev.units ? " · up" : " · down") : ""}</dt><dd>{v.units}</dd></div> : null}
      </dl>
    </Card>
    <div className={css.tiles}>
      <DeskTile title="Recognition" {...dest("me.recognition")} icon={<Award size={15} aria-hidden="true" />} figure={d.recognition.kudos.length} unit={d.recognition.kudos.length === 1 ? "thank-you" : "thank-yous"}
        line={kudo ? <>“{kudo.note}” · {first(kudo.from.name)}</> : "Thanks from colleagues show here"} aside={<ThankButton colleagues={d.colleagues} />}>
        {d.recognition.kudos.length ? <ul className={css.kudos}>{d.recognition.kudos.map((k) => <li key={k.id}><Avatar name={k.from.name} id={k.from.id} size={26} />
          <span><b>{first(k.from.name)}</b> <q>{k.note}</q><small>{day(k.at)}{k.task ? <> · <Link href={`/tasks/${k.task.id}`}>{k.task.title}</Link></> : null}</small></span></li>)}</ul>
          : <p className={css.empty}>Thanks from colleagues and heads show here. Start one: thank someone who helped you this week.</p>}
        {d.recognition.accepted.length ? <><h4 className={css.subhead}>Work accepted</h4><ul className={css.list}>{d.recognition.accepted.map((a) => <li key={a.id}><span><Link href={`/tasks/${a.id}`}><b>{a.title}</b></Link><small>accepted {day(a.at)}{a.by ? ` by ${first(a.by)}` : ""}</small></span></li>)}</ul></> : null}
      </DeskTile>
      <DeskTile title="My growth" icon={<Sprout size={15} aria-hidden="true" />} figure={d.growth.domains.length} unit={d.growth.domains.length === 1 ? "domain" : "domains"}
        line={fresh.length ? `New: ${fresh.map((k) => k.label).join(", ")}` : d.growth.kinds[0] ? `Most: ${d.growth.kinds[0].label}` : "Responsibilities and kinds of work"}>
        {d.growth.domains.length ? <div className={css.chips}>{d.growth.domains.map((x) => <span key={x.id}>{x.title}{x.status === "proposed" ? " · waiting" : ""}</span>)}</div>
          : <p className={css.empty}>No responsibility domains yet. <Link href={`/people/${d.person.id}?tab=domains`}>Propose one</Link> from the work you already do.</p>}
        {d.growth.kinds.length ? <><h4 className={css.subhead}>Kinds of work, last 90 days</h4><div className={css.chips}>{d.growth.kinds.slice(0, 8).map((k) => <span key={k.key} data-new={k.recent && !k.before ? "" : undefined}>{k.label} · {k.recent}{k.recent && !k.before ? " · new" : ""}</span>)}</div></> : null}
        {d.growth.feedback.length ? <><h4 className={css.subhead}>Feedback</h4><ul className={css.list}>{d.growth.feedback.map((f, i) => <li key={i}><span><b>{f.kind === "returned" ? "Sent back: " : ""}{f.text}</b><small>{f.task}{f.by ? ` · ${first(f.by)}` : ""} · {day(f.at)}</small></span></li>)}</ul></> : null}
        {d.growth.learnNext.length ? <p className={css.muted}>Learn next: {d.growth.learnNext.map((l) => `${l.label} (${l.open} waiting${l.doers <= 1 ? ", few do it" : ""})`).join(" · ")}</p> : null}
      </DeskTile>
      <DeskTile title="My money" icon={<Wallet size={15} aria-hidden="true" />} figure={payslipLatest ? MONTHS[Number(payslipLatest.month.slice(5, 7)) - 1].slice(0, 3) : "–"} unit={payslipLatest ? "latest payslip" : undefined}
        line={payslipLatest ? `Issued ${day(payslipLatest.issuedAt)}` : "Payslips appear when HR issues them"} aside={payslip}>
        {d.money.payslips.length ? <ul className={css.list}>{d.money.payslips.map((p) => <li key={p.month}><span><b>{p.href ? <a href={p.href} target="_blank" rel="noreferrer">Payslip, {MONTHS[Number(p.month.slice(5, 7)) - 1]} {p.month.slice(0, 4)}</a> : <>Payslip, {MONTHS[Number(p.month.slice(5, 7)) - 1]} {p.month.slice(0, 4)}</>}</b><small>issued {day(p.issuedAt)}{p.reimbursements ? ` · reimbursements ${rupees(p.reimbursements)}` : ""}</small></span>{p.net !== null ? <small>{rupees(p.net)}</small> : null}</li>)}</ul>
          : <p className={css.empty}>Payslips appear here when HR issues them.</p>}
        {/* COMP-A: the person's own pay record, letters, offer and reimbursement claims. */}
        <p className={css.muted}><Link href="/me/pay">My pay, letters and claims</Link> · <Link href="/me/pay">Claim a reimbursement</Link></p>
        <p className={css.muted}><IndianRupee size={12} aria-hidden="true" /> {d.money.leaveDays !== null ? `${d.money.leaveDays} ${d.money.leaveDays === 1 ? "day" : "days"} of ${d.money.leaveKind ?? "paid"} leave` : "No paid leave balance"}{d.money.compOffDays ? ` · ${d.money.compOffDays} comp-off` : ""}: encashment follows the leave policy. Only you, HR and the founders see your pay, and every look is logged.</p>
      </DeskTile>
      {tiles}
    </div>
  </div>;
}

/** A small "today" for outcome-based people: no check-in block, a chip. */
export function OutcomeToday({ shift }: { shift?: string | null }) {
  return <section className={`${css.card} ${css.todayChip}`} aria-label="Today"><header><h3><Sun size={15} aria-hidden="true" />Today</h3></header>
    <p className={css.chip}><CheckCheck size={14} aria-hidden="true" />Outcome-based · no check-in needed</p>
    {shift ? <small className={css.muted}>{shift}</small> : null}
  </section>;
}
