// PM-UI: the project page (SPEC §5.2, PICKS 02 "Next step first"). Back link, header, the next step card with the one
// filled button, the phase strip with the clock line, the selected phase's steps; Clocks and Team on the right from
// ~720 px of content width, below on a phone. A project without a plan shows ONE "Set up this project" card instead.
// Preview: /projects/pm/preview/project-detail?state=default|as-rifob|phase-creative-assets|needs-setup
import Link from "next/link";
import { Circle, CircleCheck, Clock as ClockIcon, MoreHorizontal, Settings2, Share2, Archive, Users, Wand2 } from "lucide-react";
import { Avatar } from "../../../avatar";
import { Menu } from "../../../kit";
import type { PhaseSteps, ProjectDetailVM, StepListItem } from "../contract/project-detail";
import type { ScreenProps } from "../contract/shared";
import {
  BackLink, Chip, ClockList, HealthChip, PersonLine, PmButton, PmCard, PmPage, ProjectTile, SectionCard, StepState, firstName, fmtDayShort, fmtRange,
} from "../kit";
import { PhasePanel } from "./project-detail-client";
import css from "./project-detail.module.css";

/** One step as a row of a step list. The WHOLE row is the link (44 px+ tap target); a small outline action (only on
 *  the signed-in owner's own step) sits beside the link, never inside it. Two lines on a narrow list (title; owner ·
 *  date · state; ONE state chip: a late step shows only "Late · 2 days" / "Client late · 2 days"), one line from ~480 px of list width (tick · title · owner · state · date), the action then sitting
 *  at the end of the state cell so it never narrows the title or moves the date. */
export function StepListRow({ item }: { item: StepListItem }) {
  const { step, action, isNext, href } = item;
  const done = step.status === "done" || step.status === "skipped";
  return <li className={css.row} data-next={isNext ? "" : undefined} data-done={done ? "" : undefined} data-action={action ? "" : undefined}>
    <Link href={href} className={css.rowLink}>
      {step.status === "done"
        ? <CircleCheck className={css.mark} data-done="" role="img" aria-label="Done" />
        : <Circle className={css.mark} aria-hidden="true" />}
      <span className={css.rowTitle}>{step.title}{isNext ? <span className={css.srOnly}> (next step)</span> : null}</span>
      <span className={css.rowMeta}>
        <span className={css.ownerName}>{step.owner ? firstName(step.owner) : "No owner"}</span>
        <span className={css.owner}>{step.owner ? <PersonLine person={step.owner} size={24} /> : <span className={css.muted}>No owner</span>}</span>
        <span className={css.due}>{step.due ? fmtDayShort(step.due) : "No date"}</span>
        <span className={css.state}><StepState step={step} single /></span>
      </span>
    </Link>
    {action ? <span className={css.act}><PmButton variant="outline" size="sm" href={action.href}>{action.label}</PmButton></span> : null}
  </li>;
}

/** The next step card (SPEC §0 rule 2), drawn here rather than with the kit's NextStepCard because this page needs
 *  "from Rifob" when the viewer reviews someone's step and the due date in the chip ("Due today · 21 Nov"). ONE state
 *  chip, as on the rows: a late step shows only its late flag. ONE filled button; "Open" is a text link. */
function NextCard({ next, today }: { next: NonNullable<ProjectDetailVM["next"]>; today: string }) {
  const { step, primary, openHref } = next;
  const done = step.status === "done" || step.status === "skipped";
  const late = step.late && !done ? step.late : undefined;
  const from = step.toReview && !step.mine;
  return <section className={css.next} aria-label="Next step"><div className={css.nextIn}>
    <div className={css.nextText}>
      <p className={css.eyebrow}>Next step</p>
      <h2 className={css.nextTitle}>{step.title}</h2>
      <div className={css.nextMeta}>
        {step.owner ? <span className={css.who}>
          <Avatar name={step.owner.name} id={step.owner.id} photoAt={step.owner.photoAt} size={24} />
          <span>{from ? <>from <b>{firstName(step.owner)}</b></> : <b>{firstName(step.owner)}</b>}</span>
        </span> : <span className={css.muted}>No owner yet</span>}
        <StepState step={step} single />
        {late || !step.due ? null : step.due === today
          ? <Chip tone="action">Due today · {fmtDayShort(step.due)}</Chip>
          : <span className={css.muted}>Due {fmtDayShort(step.due)}</span>}
      </div>
    </div>
    <div className={css.nextActions}>
      {primary ? <PmButton variant="primary" size="lg" href={primary.href} className={css.nextPrimary}>{primary.label}</PmButton> : null}
      <Link href={openHref} className={css.openLink}>Open</Link>
    </div>
  </div></section>;
}

/** The step-list card of one phase: "Shoot · 12 steps" (the current phase) or "Creative assets · 25 Nov–4 Dec". */
function StepList({ vm, list }: { vm: ProjectDetailVM; list: PhaseSteps }) {
  const phase = vm.phases.find((p) => p.id === list.phaseId);
  if (!phase) return null;
  const meta = phase.isCurrent ? `${list.total} ${list.total === 1 ? "step" : "steps"}` : phase.start && phase.end ? fmtRange(phase.start, phase.end) : `${list.total} steps`;
  const views = [{ key: "list", label: "List", href: vm.views.list }, { key: "board", label: "Board", href: vm.views.board }, { key: "timeline", label: "Timeline", href: vm.views.timeline }];
  return <SectionCard flush className={css.listCard} title={<>{phase.name}<span className={css.listMeta}> · {meta}</span></>}
    aside={<nav aria-label="View" className={css.views}>{views.map((v) => <Link key={v.key} href={v.href} aria-current={v.key === "list" ? "page" : undefined}>{v.label}</Link>)}</nav>}>
    {list.items.length
      ? <ul className={css.rows} data-actions={list.items.some((i) => i.action) ? "" : undefined}>{list.items.map((i) => <StepListRow key={i.step.id} item={i} />)}</ul>
      : <p className={css.empty}>No steps in this phase yet.</p>}
    {list.seeAllHref && list.total > list.items.length ? <Link href={list.seeAllHref} className={css.seeAll}>See all {list.total} steps</Link> : null}
  </SectionCard>;
}

export default function ProjectDetail({ vm }: ScreenProps<ProjectDetailVM>) {
  const p = vm.project;
  const menuIcons = { settings: <Settings2 size={16} aria-hidden="true" />, share: <Share2 size={16} aria-hidden="true" />, archive: <Archive size={16} aria-hidden="true" /> };
  const health = p.health.key === "needs_setup"
    // Needs setup reads grey here (build sheet §4); the kit's HealthChip draws it amber.
    ? <Chip tone="waiting" title={`Needs setup${p.health.reason ? `: ${p.health.reason}` : ""}`}><span><b>Needs setup{p.health.reason ? ":" : ""}</b>{p.health.reason ? <>{" "}<span className={css.reason}>{p.health.reason}</span></> : null}</span></Chip>
    : <HealthChip health={p.health} />;
  const lists = Object.fromEntries(vm.phaseSteps.map((l) => [l.phaseId, <StepList key={l.phaseId} vm={vm} list={l} />]));

  return <PmPage>
    <div className={css.root}>
      <BackLink href={vm.backHref} label="Projects" />

      <PmCard className={css.head}>
        <span className={css.tile}><ProjectTile project={p} size="lg" /></span>
        <h1 className={css.name}>{p.name}</h1>
        <p className={css.client}>{p.client ? `Client: ${p.client}` : "Internal project"}{p.city ? ` · ${p.city}` : ""}</p>
        <span className={css.health}>{health}</span>
        {p.lead ? <span className={css.lead}>
          <Avatar name={p.lead.name} id={p.lead.id} photoAt={p.lead.photoAt} size={36} />
          <span className={css.leadText}><span className={css.leadWord}>Lead</span><b className={css.leadName}>{firstName(p.lead)}</b></span>
        </span> : <span className={css.lead}><span className={css.muted}>No lead yet</span></span>}
        {vm.menu.length ? <span className={css.more}>
          <Menu label="Project" buttonLabel="More for this project" className={css.moreBtn}
            items={vm.menu.map((m) => ({ key: m.key, label: m.label, href: m.href, danger: m.danger, icon: menuIcons[m.key] }))}>
            <MoreHorizontal aria-hidden="true" />
          </Menu>
        </span> : null}
      </PmCard>

      <div className={css.cols}>
        <div className={css.main}>
          {vm.planReady ? <>
            {vm.next ? <NextCard next={vm.next} today={vm.today} />
              : <PmCard className={css.noNext}><p className={css.muted}>Nothing waits on you here right now.</p></PmCard>}
            <PhasePanel phases={vm.phases} hue={p.hue} clockLine={vm.clockLine} selectedId={vm.selectedPhaseId} phaseHref={vm.phaseHref} lists={lists} />
          </> : <PmCard className={css.setup}>
            <span className={css.setupIcon} aria-hidden="true"><Wand2 /></span>
            <div className={css.setupText}>
              <h2 className={css.setupTitle}>Set up this project</h2>
              <p className={css.muted}>Pick a template, map each role to a person and set the clocks. The phases, steps and dates then show here.</p>
            </div>
            <PmButton variant="primary" size="lg" href={vm.setupHref} className={css.setupBtn}>Set up</PmButton>
          </PmCard>}
        </div>

        <aside className={css.side} aria-label="Project facts">
          <SectionCard title="Clocks" icon={ClockIcon} className={css.clocks}>
            <ClockList clocks={vm.clocks} today={vm.today} hrefFor={vm.clockHref ? (c) => vm.clockHref?.replace("{clock}", c.key) : undefined} />
          </SectionCard>
          <SectionCard title="Team" icon={Users}>
            <ul className={css.team}>{vm.team.map((t) => <li key={t.person.id}>
              <Avatar name={t.person.name} id={t.person.id} photoAt={t.person.photoAt} size={32} />
              <span className={css.teamText}><b>{firstName(t.person)}</b><span className={css.muted}>{t.role}</span></span>
            </li>)}</ul>
          </SectionCard>
        </aside>
      </div>
    </div>
  </PmPage>;
}
