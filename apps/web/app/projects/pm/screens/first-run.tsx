// PM-UI 19 First run (sheets/first-run.md): the Projects page of a company with no projects yet. One line on what
// Projects does, three plain steps, ONE "Start your first project" button, and three templates (each one link that opens
// the wizard with it picked). Server component; nothing here is interactive beyond links.
import Link from "next/link";
import { AppWindow, ArrowDown, ArrowRight, Building, CalendarDays, ChevronRight, Layers, Megaphone, Play, Users, type LucideIcon } from "lucide-react";
import type { FirstRunStep, FirstRunVM, TemplateCardVM, TemplateIcon } from "../contract/first-run";
import type { ScreenProps } from "../contract/shared";
import { PmButton, PmPage } from "../kit";
import css from "./first-run.module.css";

const ICONS: Record<TemplateIcon, LucideIcon> = { building: Building, play: Play, browser: AppWindow, megaphone: Megaphone };
const STEP_ICONS: Record<FirstRunStep["key"], LucideIcon> = { template: Layers, dates: CalendarDays, team: Users };

function TemplateCard({ t }: { t: TemplateCardVM }) {
  const Icon = ICONS[t.icon];
  return <li>
    <Link href={t.href} className={css.tCard}>
      <span className={`${css.tPanel} ${css.hue}`} data-hue={t.hue}><span className={css.tTile}><Icon aria-hidden="true" /></span></span>
      <span className={css.tText}>
        <span className={css.tName}>{t.name}</span>
        <span className={css.tCounts}>{t.phases} phases · {t.steps} steps · {t.days} days</span>
      </span>
      <ChevronRight className={css.chev} aria-hidden="true" />
    </Link>
  </li>;
}

function TemplateSkeleton() {
  return <li aria-hidden="true">
    <span className={`${css.tCard} ${css.tSkel}`}>
      <span className={css.tPanel}><span className={`${css.tTile} ${css.bone}`} /></span>
      <span className={css.tText}><i className={css.bone} data-h="name" /><i className={css.bone} data-h="counts" /></span>
    </span>
  </li>;
}

export default function FirstRun({ vm }: ScreenProps<FirstRunVM>) {
  return <PmPage>
    <div className={css.wrap}>
      <section className={css.hero} aria-labelledby="pm-first-run-title">
        <h1 id="pm-first-run-title" className={css.headline}>{vm.headline}</h1>
        <div className={css.art} aria-hidden="true">
          {vm.art.map((a, i) => { const Icon = ICONS[a.icon]; return <span key={i} className={`${css.artTile} ${css.hue}`} data-hue={a.hue}><Icon /></span>; })}
        </div>
        <div className={css.stepsBox}>
          <ol className={css.steps} aria-label="How it works">
            {vm.steps.map((s, i) => {
              const Icon = STEP_ICONS[s.key];
              return [
                i ? <li key={`a-${s.key}`} className={css.arrow} aria-hidden="true"><ArrowDown data-dir="down" /><ArrowRight data-dir="right" /></li> : null,
                <li key={s.key} className={css.step}><span className={css.stepTile} aria-hidden="true"><Icon /></span><span className={css.stepLabel}>{s.label}</span></li>,
              ];
            })}
          </ol>
          {vm.start
            ? <PmButton variant="primary" size="lg" href={vm.start.href} className={css.startBtn}>{vm.start.label}</PmButton>
            : vm.note ? <p className={css.note}>{vm.note}</p> : null}
        </div>
      </section>

      {vm.templates ? <section className={css.templates} aria-labelledby="pm-first-run-templates">
        <div className={css.tHead}>
          <h2 id="pm-first-run-templates" className={css.tHeading}>{vm.templates.heading}</h2>
          <Link href={vm.templates.seeAll.href} className={css.seeAll}>{vm.templates.seeAll.label}</Link>
        </div>
        <ul className={css.tList} aria-busy={vm.templates.loading ? true : undefined}>
          {vm.templates.loading
            ? [0, 1, 2].map((i) => <TemplateSkeleton key={i} />)
            : vm.templates.items.map((t) => <TemplateCard key={t.id} t={t} />)}
        </ul>
      </section> : null}
    </div>
  </PmPage>;
}
