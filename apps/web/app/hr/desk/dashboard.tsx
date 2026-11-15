import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { CalendarCheck, CalendarDays, CircleCheck, Coffee, Info, PartyPopper, TriangleAlert, UserRoundX } from "lucide-react";
import { ago, day, longDay, plural, range, time } from "../../lib/format";
import { groupAnomalies, sameNamePeople } from "../../lib/hr-anomalies.mjs";
import { Avatar, Badge, Empty, Panel, styles } from "../../ui";
import { StatTile, StatTiles } from "../../components";
import { AvatarStack } from "../../kit";
import { Regularise } from "../actions";
import css from "../desk.module.css";
import { MODE, REG_KIND, dayCount, duration, leaveName, type Balance, type Desk, type LeaveRequest, type LeaveType, type Regularisation, type RosterPerson } from "../types";
import { SparseFacts } from "../../charts";
import { workedToday } from "../../lib/roster.mjs";
import { AttendanceCoverage, AttendanceReasons } from "../parts";
import { None, halfLabel, num, shortRange, weekdayLetter } from "./parts";
import { TodayTimeline, dayCounts } from "./day-board";
import { DayPicker } from "./controls";
import { AttendanceExceptions } from "./exceptions";
import { AskList, WhoIsOut, type Ask, type OutGroup } from "./overview-client";
import ov from "./overview.module.css";
import { badgeHref, badgeTip } from "../../lib/badges.mjs";


/** One person on the roster. People with a check-in show their times; the others get a quiet row with "Record". */
export function Who({ p, desk }: { p: RosterPerson; desk: Desk }) {
  const e = p.entry; const self = p.id === desk.me; const first = p.name.split(" ")[0];
  return (
    <li className={css.who}>
      <Link href={`/people/${p.id}?tab=attendance`} className={css.whoPerson}>
        <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={28} status />
        <span title={`${p.name} · ${p.role}${p.pod ? ` · ${p.pod}` : ""}`}><span className={css.whoName}>{p.name}</span><span className={css.whoSub}>{p.role}{p.pod ? ` · ${p.pod}` : ""}</span></span>
      </Link>
      {e ? (
        <span className={css.whoFacts}>
          <span>In <b>{time(e.in)}</b>{e.out ? <> · out <b>{e.missedOut ? "not recorded" : time(e.out)}</b></> : null}</span>
          <Badge>{MODE[e.mode]}</Badge>
          {e.onBreak ? <Badge tone="accent"><Coffee size={11} aria-hidden="true" />On a break</Badge> : null}
          {/* POLISH-2: a check-in after the shift ended is work after hours, not "Late by 11 h". */}
          {e.late && desk.policy.shiftEnd > desk.policy.shiftStart && time(e.in) >= desk.policy.shiftEnd ? <Badge>After the shift</Badge> : e.late ? <Badge tone="warning">Late by {duration(e.late)}</Badge> : null}
          {e.source === "regularised" ? <Badge>Corrected</Badge> : null}
          {/* Someone still at work has a session "not yet closed": said on every row, it was noise. Other reasons stay. */}
          <span><b>{duration(workedToday(p))}</b>{e.out ? " recorded today" : " so far"}{!e.out && p.attendance?.reasons.every((r) => r === "open_session") ? null : <AttendanceReasons attendance={p.attendance} />}</span>
        </span>
      ) : p.leave ? <span className={css.whoFacts}><Badge tone="accent">{leaveName(desk.types, p.leave.kind)}{p.leave.halfDay ? ` · ${halfLabel(p.leave.halfDay)}` : ""}</Badge></span> : null}
      {e && p.attendance?.eligible ? null : <span className={css.whoEnd}>{self ? <Regularise today={desk.today} date={desk.date} label="Correct" small variant="ghost" />
        : <Regularise today={desk.today} date={desk.date} personId={p.id} personName={first} label="Record" small variant="ghost" />}</span>}
    </li>
  );
}

/** Present, working from home and late over the last fourteen days. */
function Trend({ desk }: { desk: Desk }) {
  const t = desk.trend ?? []; const max = Math.max(4, ...t.map((d) => d.present)); const off = (d: string) => !desk.policy.workDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay() || 7);
  const worked = t.filter((d) => d.present); const late = t.reduce((n, d) => n + d.late, 0);
  if (!worked.length) return <Empty icon={CalendarCheck} compact title="No check-ins in the last 14 days" text="The columns fill in as people check in, or as you record their days." />;
  // One or two days with check-ins make lonely bars: say them instead (the chart appears from three days).
  if (worked.length < 3) return <SparseFacts label={`People checked in per day, last 14 days`} total={t.length}
    facts={worked.map((d) => ({ key: d.date, n: d.present, value: d.present, text: `checked in on ${longDay(d.date)}`, sub: [d.wfh ? `${d.wfh} from home` : "", d.late ? plural(d.late, "late mark") : "", desk.people?.length ? `of ${desk.people.length}` : ""].filter(Boolean).join(" · ") }))} />;
  return <>
    <div className={css.trend} role="img" aria-label={`People checked in per day, ${day(t[0].date)} to ${day(t[t.length - 1].date)}`}>
      {t.map((d) => (
        <div key={d.date} className={css.trendCol} data-off={off(d.date) ? "" : undefined} style={{ "--h": `${(d.present / max) * 100}%` } as CSSProperties}>
          <span className={css.trendBar}>
            {d.wfh ? <i data-kind="wfh" style={{ "--n": d.wfh } as CSSProperties} /> : null}
            {d.present - d.wfh ? <i style={{ "--n": d.present - d.wfh } as CSSProperties} /> : null}
          </span>
          <span className={css.trendTip}><b>{longDay(d.date)}{off(d.date) ? " · weekly off" : ""}</b><span>{d.present} checked in · {d.wfh} from home · {d.late} late</span></span>
        </div>
      ))}
    </div>
    <div className={css.trendAxis} aria-hidden="true">{t.map((d) => <span key={d.date} data-on={d.date === desk.today ? "" : undefined} data-off={off(d.date) ? "" : undefined}>{Number(d.date.slice(8))}</span>)}</div>
    <div className={css.legend}>
      <span><i className={css.swatch} />In the office or on duty</span><span><i className={css.swatch} data-kind="wfh" />From home</span>
      <span>Most in one day: {Math.max(...t.map((d) => d.present))} · {plural(late, "late mark")}</span>
    </div>
  </>;
}

/** The roster of a day, sorted into the groups the desk shows. */
export function roster(desk: Desk) {
  const noEntry = (desk.people ?? []).filter((p) => !p.entry);
  return {
    inNow: (desk.people ?? []).filter((p) => p.status === "in" || p.status === "break"), done: (desk.people ?? []).filter((p) => p.status === "done"),
    onLeave: noEntry.filter((p) => p.status === "leave"),
    out: noEntry.filter((p) => p.canSignIn && (p.status === "not_in" || p.status === "absent")),
    noSignIn: noEntry.filter((p) => !p.canSignIn && ["not_in", "absent", "untracked", "upcoming"].includes(p.status)),
    untracked: noEntry.filter((p) => p.canSignIn && (p.status === "untracked" || p.status === "upcoming")),
    off: noEntry.filter((p) => p.status === "holiday" || p.status === "off"),
    outcome: noEntry.filter((p) => p.status === "outcome"),
  };
}
/** One group of the roster under its heading; nothing at all when the group is empty. */
export function RosterGroup({ label, state, people, hint, grid, desk }: { label: string; state: string; people: RosterPerson[]; hint?: string; grid?: boolean; desk: Desk }) {
  return people.length ? <>
    <div className={css.groupHead} data-state={state}><i />{label}<small>{people.length}{hint ? ` · ${hint}` : ""}</small></div>
    <ul className={`${styles.list}${grid ? ` ${css.whoGrid}` : ""}`}>{people.map((p) => <Who key={p.id} p={p} desk={desk} />)}</ul>
  </> : null;
}

const summaryOf = (desk: Desk) => desk.attendance ?? { filter: { version: "off", provisional: false, maxMinutes: 0 }, from: desk.date, to: desk.date, recordedDays: 0, eligibleDays: 0, flaggedCount: 0, excludedDays: 0, coverage: null, workedMinutes: 0, recordedMinutes: 0, averageMinutes: null };

/** The team's last fourteen days: the averages and the day-by-day chart. Owner workbench (21 Oct 2026): they moved from
 *  the overview to Time → Attendance → Totals (the overview links there). */
export function DeskAverages({ desk }: { desk: Desk }) {
  return <div className={css.avgRow}>
    <Panel title="Attendance averages" sub="Last 14 days"><AttendanceCoverage summary={summaryOf(desk)} href="/hr?tab=attendance&view=totals" /></Panel>
    <Panel title="Last 14 days" sub="People checked in per day" action={{ href: "/hr?tab=attendance&view=month", label: "Month" }}><Trend desk={desk} /></Panel>
  </div>;
}

/** What a waiting request does if approved, in one line (the compact row shows it on demand). */
function impactOf(l: LeaveRequest, balance: Balance | null | undefined, types: LeaveType[]): { text: string; over?: boolean } {
  const type = types.find((t) => t.key === l.kind);
  if (!balance) return { text: type && !type.paid ? "Unpaid, so no balance is used" : "This leave type has no fixed allowance" };
  const after = balance.available - l.days;
  if (after < 0) return { text: `${dayCount(-after)} more than the ${dayCount(balance.available)} available`, over: true };
  return { text: `Balance ${num(balance.available)} → ${num(after)} ${after === 1 ? "day" : "days"} after this` };
}
/** What approving a correction does, said for the day it is about ("If you approve, 13 Oct shows check-out at 19:00"). */
function correctionWords(g: Regularisation): string {
  const on = day(g.date);
  if (g.kind === "late") return `If you approve, the late mark on ${on} goes away.`;
  if (g.kind === "wfh") return `If you approve, ${on} counts as a day worked from home.`;
  if (g.kind === "on_duty") return `If you approve, ${on} counts as a day on duty outside the office.`;
  const times = [g.inTime ? `check-in at ${g.inTime}` : "", g.outTime ? `check-out at ${g.outTime}` : ""].filter(Boolean).join(" and ");
  return times ? `If you approve, ${on} shows ${times}.` : `If you approve, ${on} is marked as corrected.`;
}
/** The person's own words: the check-in control adds "(sent from the check-in control)" to the reasons it sends. */
const ownWords = (reason: string | null | undefined) => (reason ?? "").replace(/\s*\(sent from the check-in control\)\.?\s*$/i, "").trim() || null;
const REG_SHORT: Record<Regularisation["kind"], string> = { missed_punch: "Missed check-in/out", wfh: "Work from home", on_duty: "On duty", late: "Late mark" };

/** The overview's one slim strip of things to look at (UI-SWEEP: it replaces the mostly empty "Worth a look" column):
 *  people listed twice, then the last 14 days' attendance groups, then the days to check. Nothing at all when empty. */
function AlertStrip({ desk, exceptions }: { desk: Desk; exceptions: ReactNode }) {
  const twice = sameNamePeople(desk.people ?? []);
  const groups = groupAnomalies(desk.anomalies ?? []);
  const shown = groups.slice(0, 2), more = groups.slice(2).reduce((n, g) => n + g.people, 0);
  if (!twice.length && !groups.length && !exceptions) return null;
  return <section className={ov.strip} aria-label="Worth a look">
    {twice.length ? <span className={ov.alert} title={twice.map((g) => g[0].name).join(", ")}>
      <TriangleAlert size={15} aria-hidden="true" /><span><b>{plural(twice.length, "person", "people")}</b> may be listed twice</span>
      {/* One pair: its newer record; more: Team, where both copies of each sit side by side. */}
      <Link href={twice.length === 1 ? `/people/${twice[0][twice[0].length - 1].id}` : "/people"} className={ov.alertLink}>{twice.length === 1 ? `Check ${twice[0][0].name}` : "Check them in Team"}</Link>
    </span> : null}
    {shown.map((g) => <span key={g.type} className={ov.alert}>
      <TriangleAlert size={15} aria-hidden="true" /><span><b>{g.label}</b> · {plural(g.people, "person", "people")}</span>
      <Link href="/hr?tab=attendance&view=totals" className={ov.alertLink}>Review</Link>
    </span>)}
    {more ? <Link href="/hr?tab=attendance&view=totals" className={ov.alertMore}>+{plural(more, "more person", "more people")}</Link> : null}
    {exceptions ? <span className={ov.alertTool}>{exceptions}</span> : null}
  </section>;
}

export function Dashboard({ desk }: { desk: Desk }) {
  const attendanceEnabled = desk.attendanceEnabled === true;
  const people = desk.people ?? [];
  const isToday = desk.date === desk.today;
  const r = roster(desk);
  const onLeave = attendanceEnabled ? r.onLeave : [], notIn = attendanceEnabled ? r.out : [];
  const fromHome = attendanceEnabled ? people.filter((p) => p.entry?.mode === "wfh") : [];
  const c = dayCounts(desk);
  const regularisations = attendanceEnabled ? desk.pending.regularisations ?? [] : [];
  // UI-SWEEP (owner, 10 Nov 2026; Codex concept "Summary first"): one slim strip of things to look at, the day as four
  // numbers, then two columns: what waits for a decision (compact rows, decided in place, the reason on demand) and who
  // is out (Not in yet / On leave / From home, five people then "Show all"). The day's chart shows once someone is in.
  const asks: Ask[] = [
    ...desk.pending.leave.map((l) => { const i = impactOf(l, l.balance, desk.types); return { kind: "leave" as const, id: l.id, personId: l.personId, name: l.name, photoAt: l.photoAt ?? null,
      what: leaveName(desk.types, l.kind), when: `${shortRange(l.fromDate, l.toDate)} · ${dayCount(l.days)}${l.halfDay ? ` (${halfLabel(l.halfDay)})` : ""}`, whenTitle: range(l.fromDate, l.toDate),
      reason: l.reason ?? null, impact: i.text, over: i.over, asked: ago(l.createdAt), own: l.personId === desk.me }; }),
    ...regularisations.map((g) => ({ kind: "regularisation" as const, id: g.id, personId: g.personId, name: g.name, photoAt: g.photoAt ?? null,
      what: g.kind === "missed_punch" ? (g.outTime && !g.inTime ? "Missed check-out" : g.inTime && !g.outTime ? "Missed check-in" : "Missed check-in and out") : REG_SHORT[g.kind] ?? REG_KIND[g.kind],
      when: `${shortRange(g.date, g.date)}${g.inTime ? ` · came in at ${g.inTime}` : ""}${g.outTime ? ` · left at ${g.outTime}` : ""}`, whenTitle: longDay(g.date), reason: ownWords(g.reason),
      impact: correctionWords(g), asked: ago(g.createdAt), own: g.personId === desk.me })),
  ];
  // "All ›" opens where these requests are kept: corrections under Time → Attendance, leave under Time → Leave (it opened
  // Approvals, which lists other requests and said "Nothing waiting for you" beside two waiting here).
  const face = (p: RosterPerson) => ({ id: p.id, name: p.name, photoAt: p.photoAt });
  // Faces with a photo first in a stack: a photo still reads when the next face overlaps it; two initials do not.
  const faces = (list: RosterPerson[]) => [...list].sort((a, b) => Number(!a.photoAt) - Number(!b.photoAt)).map(face);
  const exceptions = attendanceEnabled && isToday ? <AttendanceExceptions compact /> : null;
  const groups: OutGroup[] = [
    { key: "not-in", label: isToday ? "Not in yet" : "No check-in", empty: isToday ? "Everyone expected is in" : "Everyone expected checked in",
      people: notIn.map((p) => ({ ...face(p), what: p.role || "" })) },
    { key: "leave", label: "On leave", empty: "Nobody is on leave", people: onLeave.map((p) => ({ ...face(p), what: <Badge tone="accent">{p.leave ? leaveName(desk.types, p.leave.kind) : "Leave"}{p.leave?.halfDay ? ` · ${halfLabel(p.leave.halfDay)}` : ""}</Badge> })) },
    { key: "home", label: "From home", empty: "Nobody is working from home", people: fromHome.map((p) => ({ ...face(p), what: p.entry ? `In ${time(p.entry.in)}` : "" })) },
  ];
  const coming = [...desk.upcoming.slice(0, 4).map((l) => ({ key: l.id, date: l.fromDate, title: l.name, href: `/people/${l.personId}?tab=attendance`, sub: `${shortRange(l.fromDate, l.toDate)} · ${leaveName(desk.types, l.kind)}` })),
    ...desk.holidays.slice(0, 2).map((h) => ({ key: h.day, date: h.day, title: h.name, href: undefined, sub: h.optional ? "Optional holiday" : "Company holiday" }))];
  return <div className={ov.overview}>
    <AlertStrip desk={desk} exceptions={exceptions} />
    {attendanceEnabled ? <>
      <div className={ov.dayHead}>
        <h2>{isToday ? "Today" : longDay(desk.date)}</h2>
        <DayPicker date={desk.date} today={desk.today} />
      </div>
      <StatTiles label={isToday ? "Today at a glance" : "The day at a glance"} count={4} big>
        <StatTile label={isToday ? "In today" : "Checked in"} value={c.present} tone={c.present ? "good" : undefined} note={`of ${c.total} who check in${c.late ? ` · ${c.late} late` : ""}`} />
        <StatTile label={isToday ? "Not in yet" : "No check-in"} value={notIn.length} tone={notIn.length ? "warn" : undefined} note={notIn.length ? <AvatarStack people={faces(notIn)} max={4} size={24} label={isToday ? "Not in yet" : "No check-in"} /> : "Everyone expected"} />
        <StatTile label="On leave" value={onLeave.length} note={onLeave.length ? <AvatarStack people={faces(onLeave)} max={4} size={24} label="On leave" /> : "Nobody"} />
        <StatTile label="From home" value={fromHome.length} note={fromHome.length ? <AvatarStack people={faces(fromHome)} max={4} size={24} label="From home" /> : "Nobody"} />
      </StatTiles>
      {c.present ? <TodayTimeline desk={desk} bare /> : <p className={ov.quiet}><Info size={15} aria-hidden="true" />{isToday ? "Nobody has checked in yet today. The day chart appears after the first check-in." : "Nobody checked in on this day."}</p>}
    </> : null}
    <div className={ov.cols} data-one={attendanceEnabled ? undefined : ""}>
      <Panel className={ov.col} title="Waiting for you" sub={asks.length ? <span data-badge="hr.waiting" title={badgeTip("hr.waiting", asks.length)}>{asks.length}</span> : undefined} action={asks.length ? { href: regularisations.length ? badgeHref("hr.attendance") : badgeHref("hr.leave"), label: "All" } : undefined}>
        {asks.length ? <div className={styles.panelBody} data-badge-target="hr.waiting"><AskList asks={asks} className={ov.asks} /></div>
          : <Empty icon={CircleCheck} compact title="Nothing to decide" text={attendanceEnabled ? "Leave requests and attendance corrections land here the moment someone sends one." : "Leave requests land here the moment someone sends one."} />}
      </Panel>
      {attendanceEnabled && coming.length ? <Panel className={`${ov.col} ${ov.comingCol}`} title="Coming up" sub="Next two weeks" action={{ href: "/hr?tab=leave&view=calendar", label: "Calendar" }}>
        <div className={styles.panelBody}><ul className={ov.comingList}>{coming.map((x) => <li key={x.key}>
          <span className={css.dateChip} aria-hidden="true"><small>{weekdayLetter(x.date)}</small><b>{Number(x.date.slice(8))}</b></span>
          <span className={ov.comingMain}>{x.href ? <Link href={x.href} className={ov.comingTitle}>{x.title}</Link> : <span className={ov.comingTitle}><PartyPopper size={13} aria-hidden="true" /> {x.title}</span>}<small>{x.sub}</small></span>
        </li>)}</ul></div>
      </Panel> : null}
      {attendanceEnabled ? <Panel className={`${ov.col} ${ov.outCol}`} title="Who is out">
        <div className={styles.panelBody}><WhoIsOut groups={groups} />
        </div>
      </Panel> : <Panel fill className={ov.col} title="Coming up" sub="Leave and holidays">
        <ul className={styles.list}>{desk.upcoming.length ? desk.upcoming.map((l) => <li key={l.id} className={styles.row}><span className={styles.rowMain}><span className={styles.rowTitle}>{l.name}</span><span className={styles.rowMeta}><span>{range(l.fromDate, l.toDate)}</span></span></span><span className={styles.rowEnd}>{dayCount(l.days)}</span></li>)
          : <None icon={CalendarDays}>Nobody is away in the next two weeks</None>}</ul>
      </Panel>}
    </div>
    {attendanceEnabled && !people.length ? <section className={styles.panel}><Empty icon={UserRoundX} first title="No current staff" text="People marked as current in the directory appear on this roster." action={{ href: "/people", label: "Open People" }} /></section> : null}
  </div>;
}
