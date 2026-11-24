// PM-UI 18 Timeline (`timeline`, sheets/timeline.md). Back link · header (tile, name, health chip; Reschedule and the
// ONE filled "Update progress" from tablet up) · List | Board | Timeline (Timeline selected) · on a phone one clock row
// and the nine phases as a list; from 600 px of page width a phase Gantt in one card (8 week columns, clock markers,
// dated bars, the Today line, the Ads live diamond, a legend). Positions and words are worked out here; the open
// phase (popover / bottom sheet) lives in timeline-client.tsx.
import Link from "next/link";
import { CalendarClock, ChartGantt, Columns3, List } from "lucide-react";
import type { ScreenProps } from "../contract/shared";
import type { TimelineStatus, TimelineVM } from "../contract/timeline";
import { BackLink, HealthChip, PmButton, PmPage, ProjectTile, addDays, daysBetween, fmtDayShort, fmtRange, type Tone } from "../kit";
import { TimelineBody, type TLClock, type TLRow, type TLWeek } from "./timeline-client";
import css from "./timeline.module.css";

const WORDS: Record<TimelineStatus, { word: string; tone: Tone }> = {
  done: { word: "Done", tone: "done" },
  doing: { word: "Doing", tone: "info" },
  todo: { word: "To do", tone: "neutral" },
  waiting_client: { word: "Waiting on client", tone: "waiting" },
  late: { word: "Late", tone: "problem" },
};

export default function Timeline({ vm }: ScreenProps<TimelineVM>) {
  const { start, days } = vm.range;
  const at = (d: string) => Math.min(1, Math.max(0, daysBetween(start, d) / days));

  const weeks: TLWeek[] = Array.from({ length: Math.ceil(days / 7) }, (_, i) => {
    const a = addDays(start, i * 7), b = addDays(start, i * 7 + 6);
    return { n: i + 1, range: fmtRange(a, b), from: fmtDayShort(a), to: fmtDayShort(b) };
  });
  const todayX = at(vm.today);

  const rows: TLRow[] | null = vm.phases?.map((t, i) => {
    const p = t.phase;
    const s = p.start ?? start;
    const e = p.end ?? s;
    const range = fmtRange(s, e);
    const cut = range.lastIndexOf(" ");
    const x = at(s);
    const w = p.isGate ? 0 : Math.min(1 - x, (daysBetween(s, e) + 1) / days);
    const gapDays = (todayX - (x + w)) * days;
    return {
      id: p.id, no: i + 1, name: p.name, range, head: range.slice(0, cut), tail: range.slice(cut + 1),
      ...WORDS[t.status], status: t.status, current: p.isCurrent, gate: !!p.isGate,
      icon: t.icon, href: t.href, x, w, len: range.length <= 8 ? "a" : range.length <= 9 ? "b" : "c",
      side: x + w > 0.85 ? "left" : "right", near: !p.isGate && gapDays >= -0.01 && gapDays <= 7,
    };
  }) ?? null;

  const dated = (vm.clocks ?? []).flatMap((c) => { const date = c.actual ?? c.planned; return date ? [{ c, date }] : []; });
  const clocks: TLClock[] | null = vm.clocks ? dated.map(({ c, date }, i) => {
    const x = at(date);
    const next = dated[i + 1];
    const room = next ? at(next.date) - x : null;
    return {
      key: c.key, label: c.label, short: c.label.split(":")[0], date: fmtDayShort(date), done: !!c.actual, x,
      room, end: x > 0.85, tight: room !== null && room < 0.2,
    };
  }) : null;

  const views = [
    { key: "list", label: "List", href: vm.viewHrefs.list, icon: List },
    { key: "board", label: "Board", href: vm.viewHrefs.board, icon: Columns3 },
    { key: "timeline", label: "Timeline", href: vm.viewHrefs.timeline, icon: ChartGantt },
  ] as const;
  const switcher = (variant: "seg" | "tabs") => <nav className={variant === "seg" ? css.seg : css.tabs} aria-label="Views">
    {views.map((v) => <Link key={v.key} href={v.href} className={css.view} aria-current={v.key === "timeline" ? "page" : undefined}><v.icon aria-hidden="true" />{v.label}</Link>)}
  </nav>;

  return <PmPage>
    <div className={css.root}>
      <BackLink href={vm.backHref} label="Projects" />
      <p className={css.phoneTitle} aria-hidden="true">Timeline</p>

      <header className={css.head}>
        <div className={css.headRow}>
          <ProjectTile project={vm.project} size="lg" />
          <div className={css.headText}>
            <h1 className={css.title}>{vm.project.name}</h1>
            {vm.project.client ? <p className={css.sub}>{vm.project.client}{vm.city ? ` · ${vm.city}` : ""}</p> : null}
          </div>
          <div className={css.headChip}><HealthChip health={vm.health} /></div>
          {vm.actions ? <div className={css.actions}>
            <PmButton href={vm.actions.reschedule.href} icon={CalendarClock}>{vm.actions.reschedule.label}</PmButton>
            <PmButton href={vm.actions.update.href} variant="primary">{vm.actions.update.label}</PmButton>
          </div> : null}
        </div>
        {switcher("tabs")}
      </header>
      {switcher("seg")}

      <TimelineBody rows={rows} clocks={clocks} weeks={weeks} todayX={todayX} todayLabel={`Today · ${fmtDayShort(vm.today)}`}
        initialSelected={vm.selectedPhaseId} listHref={vm.viewHrefs.list} selfHref={vm.viewHrefs.timeline} />
    </div>
  </PmPage>;
}
