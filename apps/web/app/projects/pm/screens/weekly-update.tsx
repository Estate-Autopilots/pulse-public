// PM-UI: Weekly update (sheets/weekly-update.md, PICKS 13 "R Single-column form"). One calm form at every width: title
// row with the week pill, the project line, the Project Coordinator's draft band, three flat fields, the health pills
// with "System says", the client-safe switch and preview, then Post update. Phone = full width; from 600 px of content a
// centred sheet (~720 px, ~900 px from 960 px). Preview: /projects/pm/preview/weekly-update?state=default|
// better-needs-reason|worse|client-off|posted|loading. Signed in: Kavya Rao, Growth lead (the project's lead).
import type { ScreenProps } from "../contract/shared";
import type { WeeklyUpdateVM } from "../contract/weekly-update";
import { PmPage } from "../kit";
import WeeklyUpdateForm from "./weekly-update-client";
import css from "./weekly-update.module.css";

export default function WeeklyUpdate({ vm }: ScreenProps<WeeklyUpdateVM>) {
  return <PmPage width="narrow">
    <div className={css.root}>{vm.mode === "loading" ? <LoadingSheet vm={vm} /> : <WeeklyUpdateForm vm={vm} />}</div>
  </PmPage>;
}

/** Skeleton of the same blocks at the same heights (title row, project line, draft band, three fields sized to their
 *  lines, health pills and the "System says" line, switch row, preview, buttons). */
function LoadingSheet({ vm }: { vm: WeeklyUpdateVM }) {
  return <div className={css.sheet} aria-busy="true" aria-label="Loading the weekly update">
    <div className={css.titleRow}><span className={css.skBack} /><span className={css.sk} data-w="title" /><span className={css.sk} data-w="pill" /></div>
    <div className={css.skBand} data-h="project" />
    <div className={css.skBand} data-h="draft" />
    {vm.sections.map((s) => <div key={s.key} className={css.field}>
      <span className={css.sk} data-w="label" />
      <div className={css.skBox} data-lines={Math.min(4, Math.max(1, s.lines.length))} />
    </div>)}
    <div className={css.health}>
      <span className={css.sk} data-w="label" data-area="label" />
      <div className={css.skPills} data-area="pills">{vm.health.options.map((o) => <span key={o.key} className={css.skPill} />)}</div>
      <span className={css.sk} data-w="system" data-area="system" />
    </div>
    <div className={css.skSwitchRow}><span className={css.sk} data-w="switch" /><span className={css.skKnob} /></div>
    {vm.clientSafe.on ? <div className={css.skBand} data-h="preview" /> : null}
    <div className={css.buttons}><span className={css.skBtn} /><span className={css.skBtn} /></div>
    <p className={css.srOnly} role="status">Loading…</p>
  </div>;
}
