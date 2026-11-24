// PM-UI: 09 Team workload (sheets/team-workload.md; picks b4-09 phone-R, b5-09 tablet-S, b5-09 laptop-R). The lead sees
// who is overloaded on which day and moves one step to someone with room in one tap. Breadcrumb, title, filters, the
// people × days grid with its legend, then the one suggestion card. Phone: one week at a time; tablet and laptop: both
// weeks in one grid. Preview: /projects/pm/preview/team-workload?state=default|day-sheet|reassigned|week-2|empty
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { IsoDate, ScreenProps } from "../contract/shared";
import type { TeamWorkloadVM } from "../contract/team-workload";
import { PmPage, addDays, fmtDay, fmtDayShort } from "../kit";
import { Workload, type WeekLabels } from "./team-workload-client";
import css from "./team-workload.module.css";

/** "Tue" (fixed locale, via the kit). */
const weekday = (d: IsoDate) => fmtDay(d).split(",")[0];
/** "23 – 27 Nov", "30 Nov – 4 Dec"; `wd` adds weekdays: "Mon 23 – Fri 27 Nov". */
function rangeWords(a: IsoDate, b: IsoDate, wd = false): string {
  const [da, ma] = fmtDayShort(a).split(" ");
  const pre = (d: IsoDate) => (wd ? `${weekday(d)} ` : "");
  return a.slice(0, 7) === b.slice(0, 7) ? `${pre(a)}${da} – ${pre(b)}${fmtDayShort(b)}` : `${pre(a)}${da} ${ma} – ${pre(b)}${fmtDayShort(b)}`;
}

export default function TeamWorkload({ vm }: ScreenProps<TeamWorkloadVM>) {
  const labels: WeekLabels[] = vm.weeks.map((w, i) => {
    const fri = w.days[w.days.length - 1];
    return {
      group: `Week ${i + 1} · ${rangeWords(w.days[0], fri)}`,
      switcher: rangeWords(w.days[0], fri, true),
      days: w.days.map((d) => ({ date: d, wd: weekday(d), short: fmtDayShort(d), num: d.slice(8).replace(/^0/, "") })),
      weekend: [1, 2].map((n) => { const d = addDays(fri, n); return { date: d, wd: weekday(d), num: d.slice(8).replace(/^0/, "") }; }),
    };
  });
  // Local state (moves, week, open day) resets when another fixture or a fresh read arrives.
  const key = `${vm.people.map((p) => `${p.person.id}:${p.hours.flat().join(".")}`).join("|")}:${vm.openDay?.personId ?? ""}:${vm.phoneWeek}:${vm.suggestion?.stepId ?? ""}:${vm.moved?.stepId ?? ""}`;
  return <PmPage>
    <div className={css.screen}>
      <header className={css.head}>
        <nav className={css.crumbs} aria-label="Breadcrumb">
          <Link href={vm.hrefs.projects} className={css.crumbLink}>Projects</Link>
          <ChevronRight aria-hidden="true" />
          <span aria-current="page">Workload</span>
        </nav>
        <h1 className={css.h1}>Team workload</h1>
        <p className={css.sub}>Next 2 weeks · {rangeWords(vm.range.start, vm.range.end)}</p>
      </header>
      <Workload key={key} vm={vm} labels={labels} rangeLabel={rangeWords(vm.range.start, vm.range.end)} />
    </div>
  </PmPage>;
}
