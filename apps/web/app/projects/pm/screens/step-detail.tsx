// PM-UI: Step detail (PICKS 10; sheets/step-detail.md). One step, everything about it, and the one button that moves it
// on. Phone (< 600 px): one column of cards, the button sticky above the tab bar. Tablet (600–1279 px): one full sheet,
// a four-cell meta row and two columns. Laptop (≥ 1280 px): a side panel over the project page, drawn dimmed behind.
import Link from "next/link";
import {
  ArrowRight, CalendarDays, ChevronRight, Circle, CircleCheck, Clock3, Download, FileVideo, Link2, Megaphone, MessageSquare, Paperclip, Play,
  ReceiptText, Sparkles, User, Users, Workflow, X, type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "../../../avatar";
import type { ChainLink, StepAction, StepActivity, StepDetailBehind, StepDetailStep, StepDetailVM, StepFile } from "../contract/step-detail";
import type { Clock, DueSource, IsoDate, ScreenProps } from "../contract/shared";
import {
  Chip, HealthChip, PROJECT_ICONS, PersonLine, PhaseStrip, PmButton, ProjectTile, SectionCard, StepState, daysBetween, firstName, fmtDayShort,
  hued, type Tone,
} from "../kit";
import { StepChecklist } from "./step-detail-client";
import css from "./step-detail.module.css";

/** "Day 0 + 18 → 9 Dec": the due date with its source. */
function dueWords(due: IsoDate | null, src?: DueSource): string {
  if (!due) return "No date yet";
  if (!src) return fmtDayShort(due);
  const sign = src.offset < 0 ? "−" : "+";
  return `${src.clockLabel} ${sign} ${Math.abs(src.offset)} → ${fmtDayShort(due)}`;
}

/** A review-chain link's chip. "Your turn" only when the link is the signed-in person's to act on. */
function linkChip(l: ChainLink, viewerId: string): { word: string; tone: Tone } {
  switch (l.state) {
    case "todo": return { word: "To do", tone: "neutral" };
    case "doing": return { word: "Doing", tone: "info" };
    case "done": return { word: "Done", tone: "done" };
    case "approved": return { word: "Approved", tone: "done" };
    case "next": return { word: "Next", tone: "waiting" };
    case "after": return { word: `After ${l.afterName ?? "the team"}`, tone: "waiting" };
    case "in_review": return l.person.id === viewerId ? { word: "Your turn", tone: "action" } : { word: "In review", tone: "waiting" };
    case "with_client": return { word: "Waiting on client", tone: "waiting" };
    case "changes": return { word: "Changes asked", tone: "action" };
  }
}

/** The one filled button (and an outline one beside it), or the quiet line when it is someone else's turn. */
function Actions({ primary, secondary, note }: { primary: StepAction | null; secondary: StepAction | null; note: string | null }) {
  if (!primary && !secondary) return note ? <p className={css.note}><Clock3 aria-hidden="true" />{note}</p> : null;
  return <div className={css.actions}>
    {secondary ? <PmButton variant="outline" size="lg" block data-action={secondary.kind}>{secondary.label}</PmButton> : null}
    {primary ? <PmButton variant="primary" size="lg" block data-action={primary.kind}>{primary.label}</PmButton> : null}
  </div>;
}

/** The step's state chip. A blocked step says "Waiting" only; the "Depends on" row names what it waits on. */
function StateChips({ step }: { step: StepDetailStep }) {
  return step.status === "blocked" ? <Chip tone="waiting">Waiting</Chip> : <StepState step={step} />;
}

/** "Brand blueprint approved ✓": the tick never drops onto a line by itself (it stays with the last word). */
function DepTitle({ title, done }: { title: string; done: boolean }) {
  const words = title.split(" ");
  const last = words.pop() ?? "";
  return <span className={css.depTitle}>{words.length ? `${words.join(" ")} ` : ""}<span className={css.nowrap}>{last}{done
    ? <>{" "}<CircleCheck className={css.depDone} role="img" aria-label="done" /></> : null}</span>
    {done ? null : <span className={css.depOpen}> · not done yet</span>}</span>;
}

/** Activity, oldest first (comments and events in one list). */
function ActivityCard({ entries }: { entries: StepActivity[] }) {
  return <SectionCard title="Activity" icon={MessageSquare} className={css.card}>
    {entries.length ? <ol className={css.feed}>{entries.map((e) => <li key={e.id} className={css.entry}>
      <Avatar name={e.who.name} id={e.who.client ? undefined : e.who.id} photoAt={e.who.photoAt} size={32} />
      <div className={css.entryText}>
        <p className={css.entryHead}><b>{firstName(e.who)}</b> <span className={css.muted}>{fmtDayShort(e.on)}</span></p>
        <p className={css.entryBody} data-kind={e.kind}>{e.text}</p>
      </div>
    </li>)}</ol> : <p className={css.empty}>Nothing yet. Comments and uploads show here.</p>}
  </SectionCard>;
}

function MetaRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return <div className={css.metaRow}>
    <dt className={css.metaLabel}><Icon aria-hidden="true" />{label}</dt>
    <dd className={css.metaValue}>{children}</dd>
  </div>;
}

function FileRow({ f }: { f: StepFile }) {
  const Icon = f.kind === "Link" ? Link2 : f.kind === "MP4" ? Play : FileVideo;
  return <li className={css.file}>
    <span className={css.fileIcon} aria-hidden="true"><Icon /></span>
    <div className={css.fileText}>
      <p className={css.fileName}><span>{f.name}</span>{f.latest && f.version > 1 ? <Chip tone="info">Latest</Chip> : null}</p>
      <p className={css.muted}>{f.kind} · {fmtDayShort(f.uploadedOn)}</p>
    </div>
    <a href={f.href} className={css.iconBtn} aria-label={`Download ${f.name}`} download><Download aria-hidden="true" /></a>
  </li>;
}

function Chain({ links, viewerId }: { links: ChainLink[]; viewerId: string }) {
  if (!links.length) return <p className={css.empty}>No review needed. The owner marks it done.</p>;
  return <ol className={css.chain}>{links.map((l, i) => {
    const c = linkChip(l, viewerId);
    return <li key={l.person.id} className={css.link} data-state={l.state}>
      {i > 0 ? <ArrowRight className={css.arrow} aria-hidden="true" /> : null}
      <span className={css.dot} aria-hidden="true" />
      <Avatar name={l.person.name} id={l.person.client ? undefined : l.person.id} photoAt={l.person.photoAt} size={32} />
      <span className={css.linkWho}>
        <b>{l.role === "client" ? l.person.name : firstName(l.person)}</b>
        {l.role === "client" ? <span className={css.muted}>Client</span> : null}
      </span>
      <span className={css.linkChip}><Chip tone={c.tone}>{c.word}</Chip></span>
    </li>;
  })}</ol>;
}

/* ---------- The page behind the laptop panel (stand-in, dimmed, not clickable) ---------- */

const CLOCK_ICONS: Record<string, LucideIcon> = { invoice_paid: ReceiptText, inputs_complete: Clock3, ads_live: Megaphone };
function clockSub(c: Clock, day0: IsoDate | null): string {
  const d = c.actual ?? c.planned;
  if (!d) return "Not set";
  const n = day0 ? daysBetween(day0, d) : 0;
  return c.key === "invoice_paid" && day0 && n < 0 ? `${fmtDayShort(d)} (Day −${-n})` : fmtDayShort(d);
}
function Behind({ vm, b }: { vm: StepDetailVM; b: StepDetailBehind }) {
  const day0c = b.clocks.find((c) => c.key === "inputs_complete");
  const day0 = day0c?.actual ?? day0c?.planned ?? null;
  return <div className={css.behind} aria-hidden="true" inert>
    <div className={css.bHead}>
      <ProjectTile project={vm.project} />
      <p className={css.bTitle}>{vm.project.name}</p>
      <HealthChip health={b.health} />
    </div>
    <ul className={css.bClocks}>{b.clocks.map((c) => { const Icon = CLOCK_ICONS[c.key] ?? CalendarDays; return <li key={c.key} className={css.bClock}>
      <Icon aria-hidden="true" /><span><b>{c.label}</b><span className={css.muted}>{clockSub(c, day0)}</span></span>
    </li>; })}</ul>
    <div className={css.bStrip}><PhaseStrip phases={b.phases} hue={vm.project.hue} variant="full" selectedId={b.selectedPhaseId} /></div>
    <p className={css.bTabs}><span data-on="">Step list</span><span>Details</span></p>
    <ul className={css.bRows}>{b.steps.map((s) => <li key={s.id} className={css.bRow} data-open={s.id === vm.step.id ? "" : undefined}>
      {s.status === "done" ? <CircleCheck className={css.bMark} data-done="" aria-hidden="true" /> : <Circle className={css.bMark} aria-hidden="true" />}
      <span className={css.bName}>{s.title}</span>
      <span className={css.bOwner}>{s.owner ? <PersonLine person={s.owner} size={24} /> : null}</span>
      <span className={css.bDue}>{s.due ? fmtDayShort(s.due) : ""}</span>
      <span className={css.bState}><StepState step={s.status === "blocked" ? { ...s, blockedBy: undefined } : s} single /></span>
    </li>)}</ul>
  </div>;
}

/* ---------- The screen ---------- */

export default function StepDetail({ vm }: ScreenProps<StepDetailVM>) {
  const { step, project } = vm;
  const PIcon = PROJECT_ICONS[project.icon];
  const actions = <Actions primary={vm.primary} secondary={vm.secondary} note={vm.note} />;
  const canTick = step.mine || vm.viewer.isLead;
  const reviewer = step.reviewer;
  return <div className={css.stage}>
    {vm.behind ? <Behind vm={vm} b={vm.behind} /> : null}
    <article className={css.sheet} aria-labelledby="step-title">
      <div className={css.body}>
        <div className={css.top}>
          <nav className={css.path} aria-label="Where this step is">
            <Link href={vm.projectHref} {...hued(project.hue, css.pathProject)}><PIcon aria-hidden="true" /><span>{project.name}</span></Link>
            <ChevronRight className={css.pathSep} aria-hidden="true" />
            {step.phase ? <Link href={vm.phaseHref} className={css.pathPhase}>{step.phase.name}</Link> : null}
          </nav>
          <Link href={vm.projectHref} className={css.close} aria-label="Close"><X aria-hidden="true" /></Link>
        </div>

        <section className={css.headCard} aria-label="Step">
          <header className={css.head}>
            <h1 id="step-title" className={css.title}>{step.title}</h1>
            <span className={css.state}><StateChips step={step} /></span>
          </header>
          <dl className={css.meta}>
            <MetaRow icon={User} label="Owner">{step.owner ? <PersonLine person={step.owner} size={24} /> : <span className={css.muted}>No owner yet</span>}</MetaRow>
            <MetaRow icon={Users} label="Reviewer">{reviewer
              ? <span className={css.person}><Avatar name={reviewer.name} id={reviewer.id} photoAt={reviewer.photoAt} size={24} /><span>{firstName(reviewer)}{step.needsClientApproval ? " → Client" : ""}</span></span>
              : <span className={css.muted}>No approval needed</span>}</MetaRow>
            <MetaRow icon={CalendarDays} label="Due"><b className={css.due}>{dueWords(step.due, step.dueSource)}</b></MetaRow>
            <MetaRow icon={Link2} label="Depends on">{step.dependsOn.length ? <ul className={css.deps}>{step.dependsOn.map((d) => <li key={d.id}>
              <DepTitle title={d.title} done={d.done} />
            </li>)}</ul> : <span className={css.muted}>Nothing</span>}</MetaRow>
          </dl>
        </section>

        <div className={css.cols}>
          <div className={css.col}>
            <StepChecklist items={step.checklist} canTick={canTick} />
            <SectionCard title="Files" icon={Paperclip} className={css.card}>
              {vm.files.length ? <ul className={css.files}>{vm.files.map((f) => <FileRow key={f.id} f={f} />)}</ul>
                : <p className={css.empty}>No files yet. Upload the first cut when it is ready.</p>}
            </SectionCard>
          </div>
          <div className={css.col}>
            <SectionCard title="Review chain" icon={Workflow} className={css.card}>
              <Chain links={vm.chain} viewerId={vm.viewer.person.id} />
            </SectionCard>
            <ActivityCard entries={vm.activity} />
            {vm.suggestion ? <div className={css.ai}>
              <Sparkles className={css.aiIcon} aria-hidden="true" />
              <div className={css.aiText}>
                <p className={css.aiTitle}><b>{vm.suggestion.title}</b><span className={css.tag}>Suggestion</span></p>
                <p className={`${css.muted} ${css.aiDetail}`}>{vm.suggestion.detail}</p>
              </div>
              <a href={vm.suggestion.href} className={css.textLink}>{vm.suggestion.actionLabel}</a>
            </div> : null}
            <div className={css.inlineActions}>{actions}</div>
          </div>
        </div>
      </div>
      <footer className={css.foot}>{actions}</footer>
    </article>
  </div>;
}

