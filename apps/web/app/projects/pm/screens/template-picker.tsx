// PM-UI 07 Template picker (sheets/template-picker.md): step 1 of 4 of a new project. Title, quote line, the four-step
// stepper and one row of industry chips (server); the template cards and the preview are one client island
// (template-picker-client.tsx) so a tap picks a card and the phone sheet pulls up.
import Link from "next/link";
import { Check } from "lucide-react";
import type { TemplatePickerVM } from "../contract/template-picker";
import type { ScreenProps } from "../contract/shared";
import { PmPage } from "../kit";
import { TemplatePickerClient } from "./template-picker-client";
import css from "./template-picker.module.css";

export default function TemplatePicker({ vm }: ScreenProps<TemplatePickerVM>) {
  return <PmPage>
    <div className={css.wrap}>
      <header className={css.head}>
        <h1 className={css.title}>{vm.title}</h1>
        {vm.quote ? <p className={css.quote}>From quote {vm.quote.href ? <Link href={vm.quote.href} className={css.quoteLink}>{vm.quote.number}</Link> : vm.quote.number}: {vm.quote.title}, {vm.quote.parts} parts</p> : null}
        <div className={css.stepperBox}>
          <ol className={css.stepper} aria-label="New project steps">
            {vm.steps.map((s, i) => [
              i ? <li key={`l-${s.key}`} className={css.stepLine} role="presentation" /> : null,
              <li key={s.key} className={css.step} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
                <span className={css.stepNum} aria-hidden="true">{s.state === "done" ? <Check /> : s.n}</span>
                <span className={css.stepLabel}><span className={css.srOnly}>Step {s.n}: </span>{s.label}</span>
              </li>,
            ])}
          </ol>
        </div>
        <div className={css.industry} role="group" aria-labelledby="tp-industry">
          <span id="tp-industry" className={css.indLabel}>Industry</span>
          <div className={css.chips}>
            {vm.industries.map((c) => <Link key={c.id} href={c.href} className={css.chip} aria-current={c.selected ? "true" : undefined}>
              {c.label}{c.selected ? <Check aria-hidden="true" /> : null}
            </Link>)}
          </div>
        </div>
      </header>
      <TemplatePickerClient vm={vm} />
    </div>
  </PmPage>;
}
