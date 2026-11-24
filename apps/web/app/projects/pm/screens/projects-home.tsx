// PM-UI 01 Projects home (sheets/projects-home.md): my projects as colour cards, worst health first, each with its next
// step. Server component: it draws every card once; the client part (projects-home-client.tsx) owns the search and the
// filter chips and only shows/hides the cards it is given. `ProjectCard` is exported for other screens.
import Link from "next/link";
import { Plus, UserRound } from "lucide-react";
import type { ProjectCardVM, ProjectsHomeVM } from "../contract/projects-home";
import type { IsoDate, Phase, ScreenProps } from "../contract/shared";
import { nDays } from "../dates";
import { ClockLine, HealthChip, PersonLine, PhaseStrip, PmButton, PmCard, PmPage, ProjectTile, byHealth, daysBetween, fmtDayShort } from "../kit";
import { ProjectsHomeClient, type CardEntry } from "./projects-home-client";
import css from "./projects-home.module.css";

/** The project card (same anatomy at every width): colour band, icon tile, name + client, health chip with its reason,
 *  the nine-part strip naming only the current phase, "Next: step" with owner · due · late word, and one clock line.
 *  The whole card is one link to the project (the link wraps the card's content). `as`: the card's element (an `li` inside a list). */
export function ProjectCard({ card, today, level = 2, as = "li", ghost }: { card: ProjectCardVM; today: IsoDate; /** Heading level of the project name. */ level?: 2 | 3; as?: "li" | "article" | "div"; /** Draw as a loading placeholder (same rows, same heights, no link). */ ghost?: boolean }) {
  const { project, next } = card;
  const H = level === 3 ? "h3" : "h2";
  const late = next?.late && next.status !== "done" && next.status !== "skipped" ? next.late : undefined;
  // The late word is plain coloured text beside the date (the health chip is the card's one chip).
  const dueToday = !late && !!next?.due && daysBetween(today, next.due) === 0;
  // "Due today" stands for the date itself (no "21 Nov · Due today": one date, said once).
  const when = late
    ? <span className={css.late} data-tone={late.who === "client" ? "action" : "problem"}>{late.who === "client" ? "Client late" : "Late"} · {nDays(late.days)}</span>
    : dueToday ? <span className={css.late} data-tone="action">Due today</span> : null;
  const nameId = `project-card-${project.id}`;
  const body = <>
    <div className={css.head}>
      <span className={css.tileBox}><ProjectTile project={project} soft /></span>
      <div className={css.titles}>
        <H className={css.name} id={ghost ? undefined : nameId}><span className={css.nameText}>{project.name}</span></H>
        {project.client ? <p className={css.client}>{project.client}</p> : null}
      </div>
    </div>
    <HealthChip health={card.health} />
    <PhaseStrip phases={card.phases} hue={project.hue} />
    {next ? <div className={css.next}>
      <p className={css.nextStep}><b>Next:</b> {next.title}</p>
      <p className={css.nextMeta}>
        {next.owner ? <PersonLine person={next.owner} size={22} className={css.owner} /> : <span className={css.noOwner}><span className={css.noOwnerMark} aria-hidden="true"><UserRound /></span>No owner</span>}
        <span className={css.due}>
          {dueToday ? null : next.due ? <span className={css.date}>{fmtDayShort(next.due)}</span> : <span className={css.date}>No date yet</span>}
          {when}
        </span>
      </p>
    </div> : <p className={css.nextStep}><b>Next:</b> <span className={css.muted}>No open steps</span></p>}
    <div className={css.foot}><ClockLine line={card.clock} /></div>
  </>;
  // The card's content IS the link (one tab stop, the whole card is the tap target; nothing interactive inside it).
  // A loading placeholder is hidden from assistive tech (the list says it is busy).
  return <PmCard as={as} hue={project.hue} className={ghost ? `${css.card} ${css.skel}` : css.card}>
    {ghost ? <div className={css.body} aria-hidden="true">{body}</div> : <Link href={card.href} className={css.body} aria-labelledby={nameId}>{body}</Link>}
  </PmCard>;
}

/** The loading placeholder: a real card drawn from neutral stand-in content, its text and colours turned into grey
 *  bones by CSS, so it has the card's exact height at every width and nothing jumps when the data lands. */
const GHOST: ProjectCardVM = {
  project: { id: "loading", name: "Loading project", client: "Client name", hue: "slate", icon: "building" },
  href: "",
  health: { key: "at_risk", reason: "loading the reason" },
  phases: Array.from({ length: 9 }, (_, i): Phase => ({ id: `loading-${i}`, name: "Phase name", status: i < 2 ? "done" : i === 2 ? "active" : "not_started", isCurrent: i === 2 })),
  next: { id: "loading-step", title: "Loading next step", phase: null, status: "todo", owner: { id: "loading", name: "Owner", role: "" }, due: "2026-11-24", mine: false },
  clock: { state: "running", day: 12, of: 45, target: "Ads live", daysLeft: 33, date: "2026-12-24" },
  lastActivity: "2026-11-21",
  mine: true,
};

const sortCards = (a: ProjectCardVM, b: ProjectCardVM) => byHealth(a.health, b.health) || (a.next?.due ?? "9999").localeCompare(b.next?.due ?? "9999");

export default function ProjectsHome({ vm }: ScreenProps<ProjectsHomeVM>) {
  const cards: CardEntry[] = [...vm.projects].sort(sortCards).map((c) => ({
    id: c.project.id,
    health: c.health.key,
    mine: c.mine,
    quiet: daysBetween(c.lastActivity, vm.today) >= 14,
    text: `${c.project.name} ${c.project.client ?? ""}`.toLowerCase(),
    node: <ProjectCard card={c} today={vm.today} />,
  }));
  const action = vm.newProject ? <PmButton variant="primary" href={vm.newProject.href} icon={Plus} className={css.newBtn}>{vm.newProject.label}</PmButton> : null;
  const skeletons = vm.loading ? Array.from({ length: 6 }, (_, i) => <ProjectCard key={i} card={GHOST} today={vm.today} ghost />) : null;
  return <PmPage>
    <ProjectsHomeClient filters={vm.filters} initialFilter={vm.filter} initialQuery={vm.query} cards={cards} action={action} skeletons={skeletons} />
  </PmPage>;
}
