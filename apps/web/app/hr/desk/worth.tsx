"use client";

import Link from "next/link";
import { useState } from "react";
import { AlarmClock, ChevronDown, ClipboardCheck, Coffee, Hourglass, LogOut, Timer, UserRoundX, type LucideIcon } from "lucide-react";
import { day, plural } from "../../lib/format";
import { groupAnomalies, shortReason } from "../../lib/hr-anomalies.mjs";
import { Avatar, styles } from "../../ui";
import css from "../desk.module.css";
import type { Anomaly } from "../types";

const ICON: Record<Anomaly["type"], LucideIcon> = { statistics_excluded: ClipboardCheck, absent: UserRoundX, missed_out: LogOut, open: Timer, long_day: Hourglass, late: AlarmClock, long_break: Coffee };
const TOP = 5;

/** One thing to look at: who, why in one line, when, and Review (the person's attendance). The service's full sentence is the tooltip. */
function Row({ a, nested }: { a: Anomaly; nested?: boolean }) {
  const Icon = ICON[a.type] ?? ClipboardCheck;
  return (
    <li className={css.look} data-nested={nested ? "" : undefined} title={`${a.name}: ${a.detail}`}>
      {nested ? <Avatar name={a.name} id={a.personId} size={24} /> : <span className={css.lookIcon} data-kind={a.type}><Icon size={14} aria-hidden="true" /></span>}
      <span className={css.lookMain}><b className={css.lookName}>{a.name}</b><span className={css.lookWhy}>{shortReason(a)}</span></span>
      {a.date ? <time className={css.lookDate} dateTime={a.date}>{day(a.date)}</time> : <span />}
      <Link href={`/people/${a.personId}?tab=attendance`} className={`${styles.btn} ${styles.btnSmall} ${css.lookReview}`} aria-label={`Review ${a.name}`}>Review</Link>
    </li>
  );
}

/**
 * "Worth a look" on the HR dashboard: things of one kind share a row ("Attendance needs review · 7 people") that opens
 * to the names; a kind with one person is that person's row. The first five rows show, "View all" opens everything.
 */
export function WorthALook({ anomalies }: { anomalies: Anomaly[] }) {
  const groups = groupAnomalies(anomalies);
  const [open, setOpen] = useState<string[]>([]); const [all, setAll] = useState(false);
  const toggle = (type: string) => setOpen((o) => o.includes(type) ? o.filter((t) => t !== type) : [...o, type]);
  const shown = all ? groups : groups.slice(0, TOP);
  const hidden = groups.length > TOP || groups.some((g) => g.items.length > 1 && !open.includes(g.type));
  return (
    <>
      <ul className={`${styles.list} ${css.looks}`}>
        {shown.flatMap((g) => {
          if (g.items.length === 1) return [<Row key={`${g.type}:${g.items[0].personId}`} a={g.items[0]} />];
          const Icon = ICON[g.type as Anomaly["type"]] ?? ClipboardCheck; const expanded = all || open.includes(g.type);
          const names = [...new Set(g.items.map((a) => a.name))];
          return [
            <li key={g.type} className={css.lookGroup}>
              <button type="button" className={css.lookHead} aria-expanded={expanded} onClick={() => all ? (setAll(false), setOpen(groups.filter((x) => x.type !== g.type).map((x) => x.type))) : toggle(g.type)}>
                <span className={css.lookIcon} data-kind={g.type}><Icon size={14} aria-hidden="true" /></span>
                <span className={css.lookMain}><b>{g.label}</b><span className={css.lookWhy}>{names.join(", ")}</span></span>
                <span className={css.lookCount}>{plural(g.people, "person", "people")}</span>
                <ChevronDown size={15} className={css.lookChevron} aria-hidden="true" />
              </button>
            </li>,
            ...(expanded ? g.items.map((a, i) => <Row key={`${g.type}:${a.personId}:${a.date ?? i}`} a={a} nested />) : []),
          ];
        })}
      </ul>
      {/* Outside the list, so it stays in view while the list pages. */}
      {hidden || all ? <div className={css.lookAll}><button type="button" className={css.lookAllBtn} onClick={() => { setAll(!all); if (all) setOpen([]); }}>{all ? "Show less" : `View all ${anomalies.length}`}</button></div> : null}
    </>
  );
}
