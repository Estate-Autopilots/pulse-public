// PM-UI 03 Phase board (`phase-board`, sheets/phase-board.md). Back link · header · slim next-step row with the ONE
// violet button · phase line (clock + nine dots in the project's colour) · List | Board | Timeline · the board (five
// status columns; one column at a time as tabs on a phone) or the "List by phase" view. The interactive part (switch,
// tabs, drag, collapsible groups) is in phase-board-client.tsx.
import Link from "next/link";
import { Ellipsis, Send } from "lucide-react";
import type { PhaseBoardVM } from "../contract/phase-board";
import type { Phase, ScreenProps } from "../contract/shared";
import { BackLink, HealthChip, PmButton, PmPage, ProjectTile, clockLineText, firstName, fmtDayShort, daysBetween } from "../kit";
import { BoardViews, type PhaseLineData } from "./phase-board-client";
import css from "./phase-board.module.css";

const dotState = (p: Phase): PhaseLineData["dots"][number]["state"] => (p.isCurrent ? "current" : p.status === "done" ? "done" : p.status === "late" ? "late" : "later");

export default function PhaseBoard({ vm }: ScreenProps<PhaseBoardVM>) {
  const phase = vm.phases.find((p) => p.id === vm.phaseId) ?? vm.phases.find((p) => p.isCurrent) ?? vm.phases[0];
  const at = vm.phases.indexOf(phase);
  const next = vm.next;
  const dueWords = next?.due ? (next.due === vm.today ? "Due today" : daysBetween(vm.today, next.due) === 1 ? "Due tomorrow" : `Due ${fmtDayShort(next.due)}`) : null;

  const phaseLine = {
    name: phase.name, clock: clockLineText(vm.clock), hue: vm.project.hue,
    label: `Phase ${at + 1} of ${vm.phases.length}: ${phase.name}`,
    dots: vm.phases.map((p) => ({ id: p.id, state: dotState(p) })),
  };

  return <PmPage>
    <div className={css.root}>
      <div className={css.back}><BackLink href={vm.backHref} label="Projects" /></div>

      <header className={css.head}>
        <ProjectTile project={vm.project} size="lg" />
        <div className={css.headText}>
          <h1 className={css.title}>{vm.project.name}</h1>
          <HealthChip health={vm.health} />
        </div>
        {vm.menu.length ? <details className={css.menu}>
          <summary className={css.menuBtn} aria-label="Project menu"><Ellipsis aria-hidden="true" /></summary>
          <ul className={css.menuList}>{vm.menu.map((m) => <li key={m.href}><Link href={m.href}>{m.label}</Link></li>)}</ul>
        </details> : null}
      </header>

      {next ? <section className={css.next} aria-label="Your next step">
        <Send className={css.nextIcon} aria-hidden="true" />
        {/* The step's text block is the link (title + owner · due): a full-height tap target. */}
        <Link href={next.href} className={css.nextText}>
          <span className={css.nextTitle}>{next.title}</span>
          <span className={css.nextMeta}>{firstName(next.owner)}{dueWords ? <> · <span data-today={next.due === vm.today ? "" : undefined}>{dueWords}</span></> : null}</span>
        </Link>
        <PmButton variant="primary" className={css.nextBtn}>{next.action.label}</PmButton>
      </section> : null}

      <BoardViews
        view={vm.view} tab={vm.tab} steps={vm.steps} groups={vm.groups} viewer={vm.viewer} today={vm.today}
        notice={vm.notice ?? null} hrefs={vm.viewHrefs} stepHrefBase={vm.stepHrefBase} phaseLine={phaseLine}
      />
    </div>
  </PmPage>;
}
