// PM-UI: 04 My day (sheets/my-day.md; picks b3-04-my-day-*-R). What I must do now, then the rest of my week.
// Greeting + date, a small week-load card, ONE hero "Your next step" (the most urgent item) with the only filled button,
// then Late, Due today, Waiting for your review and the last group. Preview: /projects/pm/preview/my-day?state=…
import { CalendarCheck } from "lucide-react";
import type { MyDayVM } from "../contract/my-day";
import type { ScreenProps } from "../contract/shared";
import { PmButton, PmPage, firstName, fmtDay } from "../kit";
import { MyDayList } from "./my-day-client";
import css from "./my-day.module.css";

export default function MyDay({ vm }: ScreenProps<MyDayVM>) {
  const { hours, capacity } = vm.week;
  const over = hours - capacity;
  const fill = capacity > 0 ? Math.min(100, Math.round((hours / capacity) * 100)) : 0;
  // Local state resets when another fixture (or a fresh read) arrives.
  const key = `${vm.hero?.step.id ?? "none"}:${vm.hero?.step.status ?? ""}:${vm.groups.map((g) => g.items.length).join(".")}`;

  return <PmPage>
    <div className={css.screen}>
      <header className={css.top}>
        <div className={css.hello}>
          <h1 className={css.h1}>{vm.greeting}, {firstName(vm.viewer.person)}</h1>
          <p className={css.date}>{fmtDay(vm.today)}</p>
        </div>
        <section className={css.week} aria-label="This week's load">
          <p className={css.weekLine}>
            <span>This week <b>{hours} h</b> of {capacity} h</span>
            <span className={css.weekNote} data-over={over > 0 ? "" : undefined}>{over > 0 ? `Over by ${over} h` : `${-over} h free`}</span>
          </p>
          <span className={css.bar} data-over={over > 0 ? "" : undefined} aria-hidden="true"><i style={{ width: `${fill}%` }} /></span>
        </section>
      </header>

      {vm.hero || vm.groups.length > 0
        ? <MyDayList key={key} today={vm.today} hero={vm.hero} groups={vm.groups} />
        : <section className={css.empty} aria-labelledby="md-empty">
            <span className={css.emptyIcon} aria-hidden="true"><CalendarCheck /></span>
            <h2 id="md-empty" className={css.emptyTitle}>Nothing due this week</h2>
            <p className={css.emptyText}>New steps show up here when they are yours.</p>
            <PmButton href={vm.projectsHref} size="lg">Open Projects</PmButton>
          </section>}
    </div>
  </PmPage>;
}
