// PM-UI: the kit gallery, every shared PM piece in every variant (the reference screen; light and dark).
// Preview: /projects/pm/preview/kit (states: gallery, sheet, client).
import { CalendarClock, Clock as ClockIcon, Palette, Users } from "lucide-react";
import type { KitVM } from "../contract/kit";
import type { HealthKey, ScreenProps, StepStatus } from "../contract/shared";
import {
  BackLink, ClockLine, ClockList, DueText, HEALTH_ORDER, HUES, HealthChip, LateFlag, NextStepCard, PersonLine, PhaseStrip, PmButton, PmCard,
  PmPage, PmSheet, ProjectBand, ProjectTag, ProjectTile, RoundTag, SectionCard, StatusChip, StepState, byHealth, fmtDay, fmtDayShort, nDays,
} from "../kit";
import css from "./kit.module.css";

const STATUSES: StepStatus[] = ["blocked", "todo", "doing", "in_review", "changes", "waiting_client", "done", "skipped"];

export default function KitGallery({ vm }: ScreenProps<KitVM>) {
  const orchid = vm.projects[0];
  const healths = [...vm.healths].sort(byHealth);
  const sheet = <PmSheet title="Move Day 0: inputs complete" sub={<>from {fmtDayShort("2026-11-21")} to <b>{fmtDayShort("2026-11-24")}</b></>} icon={CalendarClock} hue={orchid.hue}
    mode={vm.sheetOpen ? "overlay" : "inline"} closeHref={vm.sheetOpen ? "/projects/pm/preview/kit" : undefined}
    footer={<><PmButton variant="outline" size="lg" href="/projects/pm/preview/kit">Cancel</PmButton><PmButton variant="primary" size="lg">Move dates</PmButton></>}>
    <p className={css.callout}><b>41 steps move +3 days</b></p>
    <ul className={css.moves}>{vm.phases.slice(1, 5).map((p) => <li key={p.id}><span>{p.name}</span><span className={css.muted}>{p.start ? fmtDayShort(p.start) : ""}</span></li>)}</ul>
    <p className={css.muted}>Reason (required) goes here; the screen builds the field.</p>
  </PmSheet>;

  const body = <>
    <header className={css.head}>
      <BackLink href="/projects/pm/preview" label="Previews" />
      <h1 className={css.h1}>PM kit</h1>
      <p className={css.lede}>Every shared piece of the project screens. Signed in as <PersonLine person={vm.viewer.person} role />. Today is {fmtDay(vm.today)}.</p>
    </header>

    {/* A composed project card: how the pieces sit together on Projects home. */}
    <div className={css.cards}>
      {[orchid, vm.projects[3]].map((p, i) => <PmCard key={p.id} hue={p.hue} as="article" label={p.name}>
        <div className={css.cardTop}>
          <ProjectTile project={p} soft />
          <div className={css.cardName}><h3 className={css.cardTitle}>{p.name}</h3><span className={css.muted}>{p.client}</span></div>
        </div>
        <HealthChip health={i ? { key: "on_track" } : vm.cardHealth} />
        <PhaseStrip phases={vm.phases} hue={p.hue} />
        <div className={css.cardNext}><span><b>Next:</b> {vm.cardNext.title}</span>{vm.cardNext.owner ? <PersonLine person={vm.cardNext.owner} size={20} /> : null}<DueText due={vm.cardNext.due} today={vm.today} /></div>
        <ClockLine line={vm.clockLines[i].line} />
      </PmCard>)}
    </div>

    <NextStepCard step={vm.nextStep} today={vm.today} primary={{ label: "Approve" }} openHref="#next" />

    <SectionCard title="Project identity" icon={Palette}>
      <h3 className={css.h3}>Tiles: solid (rows, headers) and soft (cards), sm · md · lg</h3>
      <div className={css.tiles}>{HUES.map((hue) => { const p = { hue, icon: vm.projects.find((x) => x.hue === hue)?.icon ?? "house", name: hue } as const;
        return <div key={hue} className={css.tileSet}><ProjectTile project={p} size="sm" /><ProjectTile project={p} /><ProjectTile project={p} size="lg" /><ProjectTile project={p} soft /><span className={css.muted}>{hue}</span></div>; })}</div>
      <h3 className={css.h3}>Bands and tags</h3>
      <div className={css.bands}>{vm.projects.map((p) => <div key={p.id} className={css.bandDemo}><ProjectBand hue={p.hue} /><ProjectTag project={p} href="#tags" /></div>)}</div>
    </SectionCard>

    <SectionCard title="Health" aside="sorted worst first">
      <div className={css.wrap}>{healths.map((h) => <HealthChip key={h.key} health={h} />)}</div>
      <p className={css.muted}>Order: {HEALTH_ORDER.map((k: HealthKey) => k.replace("_", " ")).join(" → ")}. On track is the only chip without a reason.</p>
    </SectionCard>

    <SectionCard title="Step status" aside="the same status, seen by its owner, its reviewer, anyone else" flush>
      <div className={css.scroll}><table className={css.table}>
        <thead><tr><th scope="col">Status</th><th scope="col">Owner sees</th><th scope="col">Reviewer sees</th><th scope="col">Others see</th></tr></thead>
        <tbody>{STATUSES.map((s) => <tr key={s}><th scope="row"><code>{s}</code></th>
          <td><StatusChip status={s} who="owner" blockedBy="Share raw footage" /></td>
          <td><StatusChip status={s} who="reviewer" blockedBy="Share raw footage" /></td>
          <td><StatusChip status={s} blockedBy="Share raw footage" /></td></tr>)}</tbody>
      </table></div>
    </SectionCard>

    <div className={css.two}>
      <SectionCard title="Late flags, rounds, due">
        <div className={css.wrap}>{vm.lates.map((l, i) => <LateFlag key={i} late={l} />)}</div>
        <div className={css.wrap}>{vm.rounds.map((r) => <RoundTag key={r.version} round={r} />)}</div>
        <div className={css.wrap}><DueText due={vm.today} today={vm.today} /><DueText due={vm.today} today={vm.today} at="2026-11-21T17:00:00+05:30" /><DueText due="2026-11-22" today={vm.today} /><DueText due="2026-11-28" today={vm.today} /><DueText due={null} today={vm.today} /></div>
      </SectionCard>
      <SectionCard title="Steps in a list" aside="status + late flag" flush>
        <ul className={css.rows}>{vm.steps.map((s) => <li key={s.id}>
          <span className={css.rowMain}><b>{s.title}</b><span className={css.muted}>{s.owner?.name.split(" ")[0]} · {s.due ? fmtDayShort(s.due) : "No date"}</span></span>
          <StepState step={s} />
        </li>)}</ul>
      </SectionCard>
    </div>

    <SectionCard title="Phase strip">
      <h3 className={css.h3}>Compact (cards): only the current phase is named</h3>
      <div className={css.stack}>{vm.projects.slice(0, 3).map((p, i) => <PhaseStrip key={p.id} phases={i === 2 ? vm.phasesLate : vm.phases} hue={p.hue} />)}</div>
      <h3 className={css.h3}>Full (project page): every phase labelled, 44 px links, one selected</h3>
      <PhaseStrip phases={vm.phases} hue={orchid.hue} variant="full" hrefFor={(p) => `?phase=${p.id}`} selectedId="ph-shoot" />
      <h3 className={css.h3}>Full, client names (client view)</h3>
      <PhaseStrip phases={vm.phases} hue={orchid.hue} variant="full" clientNames />
    </SectionCard>

    <div className={css.two}>
      <SectionCard title="Clocks" icon={ClockIcon} aside={<a href="#clocks">Move a date</a>}>
        <ClockList clocks={vm.clocks} today={vm.today} />
      </SectionCard>
      <SectionCard title="Clock line">
        <ul className={css.lines}>{vm.clockLines.map((c) => <li key={c.label}><span className={css.muted}>{c.label}</span><ClockLine line={c.line} /></li>)}</ul>
        <p className={css.muted}>Day count + days left = plan length, always ({nDays(45)} on Orchid Towers launch).</p>
      </SectionCard>
    </div>

    <SectionCard title="Team" icon={Users} aside="role → person">
      <ul className={css.people}>{vm.people.map((p) => <li key={p.id}><PersonLine person={p} size={32} full role /></li>)}</ul>
    </SectionCard>

    <SectionCard title="Buttons" aside="one filled iris button per view; 44 px on phones">
      <div className={css.wrap}><PmButton variant="primary" size="lg">Approve</PmButton><PmButton size="lg">Request changes</PmButton><PmButton variant="text" size="lg" href="#buttons">Open</PmButton></div>
      <div className={css.wrap}><PmButton>Start</PmButton><PmButton href="#buttons">Remind client</PmButton><PmButton variant="text">Need help</PmButton><PmButton disabled>Move dates</PmButton></div>
      <div className={css.wrap}><PmButton size="sm">Start</PmButton><PmButton size="sm" variant="text">Mark all read</PmButton></div>
      <div className={css.narrow}><PmButton size="lg" block>Use this template</PmButton></div>
    </SectionCard>

    <div className={css.narrowCol}>
      <h2 className={css.h3}>Next step on a phone-width column</h2>
      <NextStepCard step={{ ...vm.cardNext, mine: true }} today={vm.today} primary={{ label: "Mark done" }} openHref="#next" eyebrow="Your next step" project aside={<a href="#help">Need help</a>} />
    </div>

    <section className={css.sheetDemo} aria-label="Sheet">
      <h2 className={css.h3}>Sheet (bottom sheet on a phone, side panel from 900 px)</h2>
      {vm.sheetOpen ? <p className={css.muted}>Open over the page.</p> : sheet}
    </section>
    {vm.sheetOpen ? sheet : null}
  </>;

  return vm.bare
    ? <PmPage bare={{ agency: vm.agency, project: orchid.name, contact: vm.people[0] }}>{body}</PmPage>
    : <PmPage>{body}</PmPage>;
}
