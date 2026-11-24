// PM-UI kit (22 Nov 2026): the shared pieces of the 19 project-management screens, so they read as one calm product:
// white cards with a soft 1 px border and a thin band in the project's colour, state as words on chips, quiet grey meta
// text, one filled iris button per view. Server-component friendly (no hooks, no "use client"); a client screen may
// import any of it too. Tokens only (no hex): project colours are the design system's --ds-hue-*; tones --tone-*.
// See screens/kit.tsx (/projects/pm/preview/kit) for every piece in every variant.
import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import {
  Building2, Check, Circle, CircleCheck, Clapperboard, Clock as ClockIcon, Flower2, Globe, House, Landmark, Megaphone, Rocket,
  Sparkles, Store, Sun, Sunrise, TreeDeciduous, TreePalm, Waves, X, ChevronLeft, type LucideIcon,
} from "lucide-react";
import { Avatar } from "../../avatar";
import type {
  Clock, ClockLineVM, Health, HealthKey, HueKey, IconKey, IsoDate, IsoDateTime, LateFlag as LateFlagT, Person, Phase, ProjectRef, Round, StepRow, StepStatus,
} from "./contract/shared";
import { daysBetween, fmtDay, fmtDayShort, fmtTime, nDays } from "./dates";
import css from "./kit.module.css";

export { daysBetween, addDays, daysLate, fmtDay, fmtDayShort, fmtRange, fmtTime, nDays, relDays } from "./dates";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------- Identity: colour + icon ---------- */

/** Icon per project icon key (lucide-react). */
export const PROJECT_ICONS: Record<IconKey, LucideIcon> = {
  building: Building2, flower: Flower2, waves: Waves, tree: TreeDeciduous, sun: Sun, palm: TreePalm, sparkles: Sparkles, house: House,
  rocket: Rocket, megaphone: Megaphone, video: Clapperboard, globe: Globe, store: Store, landmark: Landmark,
};
/** Every project hue, in picker order. */
export const HUES: HueKey[] = ["teal", "green", "sky", "amber", "pink", "orange", "slate"];
/** Class + attribute that give an element the project's colour as --pm-hue (solid), --pm-soft (tint) and --pm-ink
 *  (readable words in the hue). Spread on any element: `<div {...hued("teal")}>`. */
export const hued = (hue: HueKey, className?: string) => ({ className: cx(css.hue, className), "data-hue": hue });
/** First name for tight places ("Kavya"). */
export const firstName = (p: Pick<Person, "name">) => p.name.split(" ")[0];

/** The project's icon on its colour. `solid` (default): white-on-colour tile (lists, rows, headers); `soft`: tinted
 *  tile with the icon in the colour (project cards). sm 24 · md 40 · lg 56 px. */
export function ProjectTile({ project, size = "md", soft, label }: { project: Pick<ProjectRef, "hue" | "icon" | "name">; size?: "sm" | "md" | "lg"; soft?: boolean; /** Say the project's name to screen readers (default: decorative). */ label?: boolean }) {
  const Icon = PROJECT_ICONS[project.icon] ?? Building2;
  // The span carries the project's colour and icon as data (the test harness reads them); unlabelled it has no role and
  // no text, and its icon is aria-hidden, so screen readers still skip it.
  return <span {...hued(project.hue, css.tile)} data-size={size} data-soft={soft ? "" : undefined} data-project-colour={project.hue} data-project-icon={project.icon} role={label ? "img" : undefined} aria-label={label ? project.name : undefined}>
    <Icon aria-hidden="true" />
  </span>;
}

/** The thin colour band along the top of a card. Put it first inside a `PmCard` (or use `PmCard hue=`). */
export function ProjectBand({ hue }: { hue: HueKey }) {
  return <span {...hued(hue, css.band)} aria-hidden="true" />;
}

/** A small tag naming a project in its colour (rows in My day, Approvals, notifications, goal cards). */
export function ProjectTag({ project, href }: { project: Pick<ProjectRef, "hue" | "icon" | "name">; href?: string }) {
  const body = <><ProjectTile project={project} size="sm" /><span>{project.name}</span></>;
  return href ? <Link href={href} {...hued(project.hue, css.ptag)}>{body}</Link> : <span {...hued(project.hue, css.ptag)}>{body}</span>;
}

/* ---------- Cards and page ---------- */

type CardTag = "div" | "section" | "article" | "li";
/** The PM card: white surface, soft 1 px border, generous radius; `hue` adds the colour band on top. */
export function PmCard({ hue, children, as: Tag = "div", className, pad = true, label }: { hue?: HueKey; children: ReactNode; as?: CardTag; className?: string; /** Inner padding (off for edge-to-edge lists). */ pad?: boolean; /** aria-label for a section/article. */ label?: string }) {
  return <Tag className={cx(css.card, className)} data-pad={pad ? "" : undefined} data-banded={hue ? "" : undefined} aria-label={label}>
    {hue ? <ProjectBand hue={hue} /> : null}{children}
  </Tag>;
}

/** A titled card (Clocks, Team, Waiting on client, Files & approvals, Updates…). `aside`: a count, a text link. */
export function SectionCard({ title, icon: Icon, aside, children, level = 2, flush, hue, className, id }: { title: ReactNode; icon?: LucideIcon; aside?: ReactNode; children: ReactNode; /** Heading level (keep headings in order). */ level?: 2 | 3; /** Body without side padding (edge-to-edge rows). */ flush?: boolean; hue?: HueKey; className?: string; id?: string }) {
  const H = level === 3 ? "h3" : "h2";
  return <section className={cx(css.card, css.section, className)} data-pad="" data-flush={flush ? "" : undefined} data-banded={hue ? "" : undefined} id={id}>
    {hue ? <ProjectBand hue={hue} /> : null}
    <header className={css.sectionHead}><H className={css.sectionTitle}>{Icon ? <Icon aria-hidden="true" /> : null}{title}</H>{aside ? <span className={css.sectionAside}>{aside}</span> : null}</header>
    <div className={css.sectionBody}>{children}</div>
  </section>;
}

/** Every PM screen sits in this: the page width and gutters. `width`: default ~1200 px, `narrow` ~920 px (forms,
 *  wizard, client pages), `full`. `bare`: a client-facing page with only the agency's top bar (agency mark + name,
 *  project, the client's team contact) and no app chrome inside the content. */
export function PmPage({ children, width = "default", bare }: { children: ReactNode; width?: "default" | "narrow" | "full"; bare?: { agency: string; project?: string; contact?: Person } }) {
  return <div className={css.page} data-width={bare && width === "default" ? "narrow" : width} data-bare={bare ? "" : undefined}>
    {bare ? <header className={css.agencyBar}>
      <span className={css.agency}><span className={css.agencyMark} aria-hidden="true"><Sunrise /></span><strong>{bare.agency}</strong></span>
      {bare.project ? <span className={css.agencyProject}>{bare.project}</span> : null}
      {bare.contact ? <span className={css.agencyContact}><PersonLine person={bare.contact} size={28} /></span> : null}
    </header> : null}
    <div className={css.pageBody}>{children}</div>
  </div>;
}

/** "‹ Projects": the one back link above a page title. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={css.back}><ChevronLeft aria-hidden="true" />{label}</Link>;
}

/* ---------- Buttons ---------- */

type BtnBase = { variant?: "primary" | "outline" | "text"; size?: "sm" | "md" | "lg"; icon?: LucideIcon; block?: boolean; children: ReactNode; className?: string };
type BtnAsLink = BtnBase & { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className" | "children">;
type BtnAsButton = BtnBase & { href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;
/** The PM button. `primary` = filled iris (ONE per view) · `outline` · `text` (a quiet link). `href` renders a link.
 *  sm 32 · md 36 · lg 44 px; every size is 44 px on phone widths and touch screens. `block` = full width. */
export function PmButton(props: BtnAsLink | BtnAsButton) {
  const { variant = "outline", size = "md", icon: Icon, block, children, className, ...rest } = props;
  const cls = cx(css.btn, className);
  const data = { "data-variant": variant, "data-size": size, "data-block": block ? "" : undefined };
  const body = <>{Icon ? <Icon aria-hidden="true" /> : null}<span>{children}</span></>;
  if ("href" in rest && rest.href !== undefined) { const { href, ...a } = rest as BtnAsLink; return <Link href={href} className={cls} {...data} {...a}>{body}</Link>; }
  const b = rest as Omit<BtnAsButton, keyof BtnBase>;
  return <button type="button" className={cls} {...data} {...b}>{body}</button>;
}

/* ---------- State chips ---------- */

/** Tone of a chip: the five work tones of the design system, plus `neutral` (outline, for To do). */
export type Tone = "done" | "info" | "action" | "waiting" | "problem" | "neutral";
/** A word on a soft chip. State is always a word (SPEC §0 rule 9). */
export function Chip({ tone, children, strike, icon: Icon, title }: { tone: Tone; children: ReactNode; strike?: boolean; icon?: LucideIcon; title?: string }) {
  return <span className={css.chip} data-tone={tone} data-strike={strike ? "" : undefined} title={title}>{Icon ? <Icon aria-hidden="true" /> : null}{children}</span>;
}

/** Health words and tones (SPEC §3.2; At risk is amber, Late red: PICKS 13). */
export const HEALTH_WORDS: Record<HealthKey, { word: string; tone: Tone; sep: string }> = {
  late: { word: "Late", tone: "problem", sep: ": " },
  at_risk: { word: "At risk", tone: "action", sep: ": " },
  waiting_client: { word: "Waiting on client", tone: "waiting", sep: " · " },
  on_track: { word: "On track", tone: "done", sep: "" },
  not_started: { word: "Not started", tone: "waiting", sep: " · " },
  needs_setup: { word: "Needs setup", tone: "action", sep: ": " },
  paused: { word: "Paused", tone: "waiting", sep: " · " },
  done: { word: "Done", tone: "done", sep: " · " },
};
/** Sort order of health on lists (BRIEF: Late, At risk, Waiting on client, On track, then Not started, Needs setup, Paused, Done). */
export const HEALTH_ORDER: HealthKey[] = ["late", "at_risk", "waiting_client", "on_track", "not_started", "needs_setup", "paused", "done"];
/** Compare two healths for sorting (worst first). */
export const byHealth = (a: Pick<Health, "key">, b: Pick<Health, "key">) => HEALTH_ORDER.indexOf(a.key) - HEALTH_ORDER.indexOf(b.key);
/** The health text in one string: "At risk: shoot moved 3 days", "Waiting on client · floor plans, 4 days", "On track". */
export const healthText = (h: Health) => { const w = HEALTH_WORDS[h.key]; return h.reason && h.key !== "on_track" ? `${w.word}${w.sep}${h.reason}` : w.word; };

/** The project's health as a chip: the word, then its reason. On track is the only one without a reason. */
export function HealthChip({ health, short }: { health: Health; /** Word only (very tight places; the reason must show nearby). */ short?: boolean }) {
  const w = HEALTH_WORDS[health.key];
  const reason = !short && health.key !== "on_track" ? health.reason : undefined;
  return <span className={css.chip} data-tone={w.tone} data-health={health.key} title={healthText(health)}>
    <span><b>{w.word}{reason && w.sep.startsWith(":") ? ":" : ""}</b>{reason ? <>{" "}<span className={css.reason}>{w.sep.startsWith(":") ? "" : "· "}{reason}</span></> : null}</span>
  </span>;
}

/** Who is looking at a step's status: its owner, its reviewer, or anyone else. */
export type StepViewer = "owner" | "reviewer" | "other";
/** Step status words and tones, SPEC §3.1 exactly (viewer-aware for in_review and changes). */
export function statusWord(status: StepStatus, who: StepViewer = "other", blockedBy?: string): { word: string; tone: Tone; strike?: boolean } {
  switch (status) {
    case "blocked": return { word: blockedBy ? `Waiting on “${blockedBy}”` : "Waiting", tone: "waiting" };
    case "todo": return { word: "To do", tone: "neutral" };
    case "doing": return { word: "Doing", tone: "info" };
    case "in_review": return who === "reviewer" ? { word: "Your turn", tone: "action" } : { word: "In review", tone: "waiting" };
    case "changes": return { word: "Changes asked", tone: who === "owner" ? "action" : "waiting" };
    case "waiting_client": return { word: "Waiting on client", tone: "waiting" };
    case "done": return { word: "Done", tone: "done" };
    case "skipped": return { word: "Skipped", tone: "waiting", strike: true };
  }
}
/** A step's status chip. `who`: "reviewer" turns In review into amber "Your turn"; "owner" makes Changes asked amber. */
export function StatusChip({ status, who = "other", blockedBy }: { status: StepStatus; who?: StepViewer; blockedBy?: string }) {
  const s = statusWord(status, who, blockedBy);
  return <Chip tone={s.tone} strike={s.strike}>{s.word}</Chip>;
}
/** The viewer of a step row, from its `mine` / `toReview` flags. */
export const stepViewer = (step: Pick<StepRow, "mine" | "toReview">): StepViewer => (step.toReview ? "reviewer" : step.mine ? "owner" : "other");

/** "Late · 2 days" (red, the team's) or "Client late · 2 days" (amber, waiting on the client; not the team's). */
export function LateFlag({ late }: { late: LateFlagT }) {
  return <Chip tone={late.who === "client" ? "action" : "problem"}>{late.who === "client" ? "Client late" : "Late"} · {nDays(late.days)}</Chip>;
}

/** A step's state in one place: status chip + late flag. `single`: one chip only (the late flag replaces the status;
 *  PICKS 05 "one state chip per row"). Done/skipped steps are never late. */
export function StepState({ step, single }: { step: Pick<StepRow, "status" | "late" | "mine" | "toReview" | "blockedBy">; single?: boolean }) {
  const late = step.late && step.status !== "done" && step.status !== "skipped" ? step.late : undefined;
  if (late && single) return <LateFlag late={late} />;
  return <span className={css.chips}><StatusChip status={step.status} who={stepViewer(step)} blockedBy={step.blockedBy} />{late ? <LateFlag late={late} /> : null}</span>;
}

/** "v2 · Round 2 of 3"; past the allowance "v4 · Extra round" (amber, SPEC §3.3). */
export function RoundTag({ round }: { round: Round }) {
  const extra = round.round > round.maxRounds;
  return <span className={css.round} data-extra={extra ? "" : undefined}>v{round.version} · {extra ? "Extra round" : `Round ${round.round} of ${round.maxRounds}`}</span>;
}

/** A due date in words: "Due today" (amber chip; with a time, "Due today, 5:00 pm"), else "Due 23 Nov" as quiet text.
 *  Late steps show the LateFlag instead (pass `late` to get nothing here). */
export function DueText({ due, today, at, late, prefix = "Due" }: { due: IsoDate | null; today: IsoDate; at?: IsoDateTime | null; late?: boolean; prefix?: string }) {
  if (!due) return <span className={css.meta}>No date yet</span>;
  if (late) return null;
  if (due === today) return <Chip tone="action">{prefix} today{at ? `, ${fmtTime(at)}` : ""}</Chip>;
  const n = daysBetween(today, due);
  return <span className={css.meta}>{prefix} {n === 1 ? "tomorrow" : fmtDayShort(due)}{at ? `, ${fmtTime(at)}` : ""}</span>;
}

/* ---------- People ---------- */

/** Avatar + name (first name by default), optionally " · role" in grey, or any `meta` after it. */
export function PersonLine({ person, size = 24, full, role, meta, className }: { person: Person; size?: number; /** Full name instead of the first name. */ full?: boolean; /** Show " · Growth lead". */ role?: boolean; meta?: ReactNode; className?: string }) {
  return <span className={cx(css.person, className)}>
    <Avatar name={person.name} id={person.client ? undefined : person.id} photoAt={person.photoAt} size={size} />
    <span className={css.personText}><span className={css.personName}>{full ? person.name : firstName(person)}</span>{role ? <span className={css.meta}> · {person.role}</span> : null}{meta ? <span className={css.meta}> · {meta}</span> : null}</span>
  </span>;
}

/* ---------- Phases ---------- */

type PhaseState = "done" | "current" | "later" | "late";
const phaseState = (p: Phase): PhaseState => (p.status === "late" ? "late" : p.isCurrent ? "current" : p.status === "done" ? "done" : "later");
/** The project's phases as a strip of segments in its colour (done and current solid, later tinted, late red).
 *  `compact` (cards): small segments and only the current phase named, "Shoot · 3 of 9".
 *  `full` (project page): every phase labelled (12 px+), each segment a 44 px tap target; with `hrefFor` each is a link
 *  (tap one to filter the list); `selectedId` marks the filtered one; scrolls sideways on a phone. */
export function PhaseStrip({ phases, hue, variant = "compact", hrefFor, selectedId, clientNames }: { phases: Phase[]; hue: HueKey; variant?: "compact" | "full"; hrefFor?: (phase: Phase) => string; selectedId?: string; /** Show each phase's client name (client view). */ clientNames?: boolean }) {
  const at = phases.findIndex((p) => p.isCurrent);
  const current = at >= 0 ? phases[at] : undefined;
  const name = (p: Phase) => (clientNames && p.clientName ? p.clientName : p.name);
  if (variant === "compact") {
    const label = current ? `${name(current)} · ${at + 1} of ${phases.length}` : phases.every((p) => p.status === "done") ? `All ${phases.length} done` : `${phases.length} phases`;
    return <div {...hued(hue, css.strip)} data-variant="compact">
      <span className={css.segs} role="img" aria-label={`Phases: ${label}`}>{phases.map((p) => <i key={p.id} data-state={phaseState(p)} />)}</span>
      <span className={css.stripLabel}>{label}</span>
    </div>;
  }
  return <nav {...hued(hue, css.strip)} data-variant="full" aria-label="Phases">
    <ol className={css.phaseList}>{phases.map((p, i) => {
      const st = phaseState(p);
      const body = <><i className={css.phaseBar} data-state={st} aria-hidden="true" />
        <span className={css.phaseName}>{st === "done" ? <Check aria-hidden="true" /> : null}<span className={css.phaseNo}>{i + 1}</span> {name(p)}</span>
        {st === "late" ? <span className={css.srOnly}> (late)</span> : st === "done" ? <span className={css.srOnly}> (done)</span> : null}</>;
      const common = { className: css.phase, "data-state": st, "data-selected": p.id === selectedId ? "" : undefined, "aria-current": p.isCurrent ? ("step" as const) : undefined };
      return <li key={p.id}>{hrefFor ? <Link href={hrefFor(p)} {...common}>{body}</Link> : <span {...common}>{body}</span>}</li>;
    })}</ol>
  </nav>;
}

/* ---------- Clocks ---------- */

/** The clock line in words: "Day 12 of 45 · Ads live in 33 days (15 Dec)". */
export function clockLineText(line: ClockLineVM): string {
  switch (line.state) {
    case "running": return `Day ${line.day} of ${line.of} · ${line.target} ${line.daysLeft === 0 ? "today" : `in ${nDays(line.daysLeft)}`} (${fmtDayShort(line.date)})`;
    case "before": return `${line.start} on ${fmtDayShort(line.startDate)} · ${line.target} ${fmtDayShort(line.date)}`;
    case "passed": return line.done ? `${line.target} since ${fmtDayShort(line.date)}` : `${line.target} was due ${fmtDayShort(line.date)} · ${nDays(line.daysAgo)} ago`;
    case "unset": return line.note;
  }
}
/** The project's active clock on one line, with a clock icon. A missed target reads red. */
export function ClockLine({ line, bare }: { line: ClockLineVM; /** Without the icon. */ bare?: boolean }) {
  return <span className={css.clockLine} data-missed={line.state === "passed" && !line.done ? "" : undefined} data-unset={line.state === "unset" ? "" : undefined}>
    {bare ? null : <ClockIcon aria-hidden="true" />}<span>{clockLineText(line)}</span>
  </span>;
}

/** One clock: tick when it happened (actual), else an empty circle; label · date · "in 9 days". */
export function ClockRow({ clock, today, href }: { clock: Clock; today: IsoDate; /** Edit link (the lead; opens the clock-move sheet). */ href?: string }) {
  const date = clock.actual ?? clock.planned ?? null;
  const n = date ? daysBetween(today, date) : 0;
  const rel = !date ? "Not set" : clock.actual ? (n === 0 ? "today" : n < 0 ? `${nDays(-n)} ago` : `in ${nDays(n)}`) : n === 0 ? "today" : n > 0 ? `in ${nDays(n)}` : `${nDays(-n)} late`;
  const label = <span className={css.clockLabel}>{clock.label}</span>;
  return <li className={css.clockRow} data-done={clock.actual ? "" : undefined} data-late={!clock.actual && date && n < 0 ? "" : undefined}>
    {clock.actual ? <CircleCheck className={css.clockMark} role="img" aria-label="Done" /> : <Circle className={css.clockMark} role="img" aria-label="Not yet" />}
    {href ? <Link href={href} className={css.clockLink}>{label}</Link> : label}
    <span className={css.clockDate}>{date ? fmtDayShort(date) : null}</span>
    <span className={css.clockRel}>{rel}</span>
  </li>;
}
/** The project's clocks as a list (side card "Clocks", client "Coming up"). */
export function ClockList({ clocks, today, hrefFor }: { clocks: Clock[]; today: IsoDate; hrefFor?: (clock: Clock) => string | undefined }) {
  return <ul className={css.clockList}>{clocks.map((c) => <ClockRow key={c.key} clock={c} today={today} href={hrefFor?.(c)} />)}</ul>;
}

/* ---------- Next step ---------- */

export type PmAction = { label: string; href?: string; icon?: LucideIcon };
/** SPEC §0 rule 2: the next step, its owner, due date and status, ONE primary button and an "Open" link. On a phone the
 *  button is full width with Open under it; from ~560 px of card width they sit on the right. `actionSlot` replaces the
 *  primary button with a client component (a real mutation button); `project` adds the project's tile and name. */
export function NextStepCard({ step, today, primary, openHref, eyebrow = "Next step", actionSlot, project, aside }: { step: StepRow; today: IsoDate; primary?: PmAction; openHref?: string; eyebrow?: string; actionSlot?: ReactNode; /** Show the step's project (My day hero). */ project?: boolean; /** Extra quiet line under the actions ("Need help" link). */ aside?: ReactNode }) {
  const late = step.late && step.status !== "done" && step.status !== "skipped" ? step.late : undefined;
  return <section className={cx(css.card, css.next)} data-pad="" aria-label={eyebrow}>
    <div className={css.nextMain}>
      {project && step.project ? <ProjectTile project={step.project} size="lg" /> : null}
      <div className={css.nextText}>
        <p className={css.eyebrow}>{eyebrow}</p>
        <h2 className={css.nextTitle}>{step.title}</h2>
        {project && step.project ? <p className={css.meta}>{step.project.name}</p> : null}
        <div className={css.nextMeta}>
          {step.owner ? <PersonLine person={step.owner} /> : <span className={css.meta}>No owner yet</span>}
          {late ? <LateFlag late={late} /> : <DueText due={step.due} today={today} at={step.dueAt} />}
          {step.status === "todo" && !late ? null : <StatusChip status={step.status} who={stepViewer(step)} blockedBy={step.blockedBy} />}
          {step.round ? <RoundTag round={step.round} /> : null}
        </div>
      </div>
    </div>
    <div className={css.nextActions}>
      {actionSlot ?? (primary ? <PmButton variant="primary" size="lg" href={primary.href} icon={primary.icon} className={css.nextPrimary}>{primary.label}</PmButton> : null)}
      {openHref ? <Link href={openHref} className={css.textLink}>Open</Link> : null}
      {aside ? <span className={css.nextAside}>{aside}</span> : null}
    </div>
  </section>;
}

/* ---------- Sheet ---------- */

/** A sheet: bottom sheet on a phone, side panel from 900 px. Presentational (no state): `mode="overlay"` draws it open
 *  over the page with a dimmed backdrop (a screen's "sheet open" state; close with `closeHref`); `mode="inline"` draws
 *  the same sheet in the page flow (galleries). `footer` is sticky: put the one primary button there. For a live,
 *  interactive panel use the app kit's Drawer (`../../kit`). */
export function PmSheet({ title, sub, icon: Icon, children, footer, mode = "overlay", closeHref, hue, label }: { title: ReactNode; sub?: ReactNode; icon?: LucideIcon; children: ReactNode; footer?: ReactNode; mode?: "overlay" | "inline"; closeHref?: string; hue?: HueKey; label?: string }) {
  const sheet = <div className={css.sheet} role="dialog" aria-modal={mode === "overlay" ? true : undefined} aria-label={label ?? (typeof title === "string" ? title : undefined)} data-mode={mode}>
    <span className={css.grip} aria-hidden="true" />
    <header className={css.sheetHead}>
      {Icon ? <span {...(hue ? hued(hue, css.sheetIcon) : { className: css.sheetIcon })} aria-hidden="true"><Icon /></span> : null}
      <div className={css.sheetTitles}><h2 className={css.sheetTitle}>{title}</h2>{sub ? <p className={css.meta}>{sub}</p> : null}</div>
      {closeHref ? <Link href={closeHref} className={css.sheetClose} aria-label="Close"><X aria-hidden="true" /></Link> : null}
    </header>
    <div className={css.sheetBody}>{children}</div>
    {footer ? <footer className={css.sheetFoot}>{footer}</footer> : null}
  </div>;
  return mode === "overlay" ? <div className={css.backdrop}>{sheet}</div> : <div className={css.sheetFrame}>{sheet}</div>;
}
