"use client";
// PM-UI 07 Template picker: the template cards (a radio group) and the preview of the picked one. One preview element:
// on a phone it is the bottom sheet (sticky above the tab bar; peek = name, counts, "Use this template"; pulled up =
// clocks, phases, roles); from 600 px it is the preview card beside (or under) the cards. Local state only: picked
// template + sheet open; the real page wires `useHref`.
import { useState, type CSSProperties } from "react";
import { AppWindow, Brush, Building, Flag, Layers, Megaphone, Plus, Receipt, Rocket, User, type LucideIcon } from "lucide-react";
import type { TemplateClockTag, TemplateIconKey, TemplateOption, TemplatePickerVM } from "../contract/template-picker";
import { PmButton, firstName, hued } from "../kit";
import css from "./template-picker.module.css";

const ICONS: Record<TemplateIconKey, LucideIcon> = { building: Building, brush: Brush, megaphone: Megaphone, browser: AppWindow, plus: Plus };
const CLOCK_ICONS: Record<TemplateClockTag["icon"], LucideIcon> = { invoice: Receipt, flag: Flag, rocket: Rocket };

const countsText = (t: TemplateOption, scratch: string) => t.counts ? `${t.counts.phases} phases · ${t.counts.steps} steps · ${t.counts.days} days` : scratch;

function Tile({ t, size }: { t: Pick<TemplateOption, "hue" | "icon">; size?: "lg" }) {
  const Icon = ICONS[t.icon];
  return <span {...hued(t.hue, css.tile)} data-size={size} aria-hidden="true"><Icon /></span>;
}

function Plan({ t }: { t: TemplateOption }) {
  const plan = t.plan;
  if (plan.kind === "blank") return <p className={css.blankNote}>{plan.note}</p>;
  const rows = Math.ceil(plan.phases.length / 2);
  return <>
    <ul className={css.clocks} aria-label="Clocks">
      {plan.clocks.map((c) => {
        const Icon = CLOCK_ICONS[c.icon];
        return <li key={c.key} className={css.clock}>
          <span className={css.clockIcon} aria-hidden="true"><Icon /></span>
          <span className={css.clockText}><strong>{c.label}</strong><span className={css.srOnly}> · </span><span className={css.muted}>{c.detail}</span></span>
        </li>;
      })}
    </ul>
    <section className={css.phases} aria-labelledby="tp-phases">
      <div className={css.subHead}>
        <h3 id="tp-phases" className={css.h3}>Phases ({plan.phases.length})</h3>
        <span className={css.totalTop}>Total: {plan.totalSteps} steps</span>
      </div>
      <ol className={css.phaseList} style={{ "--rows": rows } as CSSProperties}>
        {plan.phases.map((p, i) => <li key={p.id} className={css.phase}>
          <span className={css.phaseNum} aria-hidden="true">{i + 1}</span>
          <span className={css.phaseName}>{p.name}</span>
          <span className={css.phaseSteps}>{p.steps} steps</span>
        </li>)}
      </ol>
      <p className={css.totalRow}><span>Total</span><span>{plan.totalSteps} steps</span></p>
    </section>
    <section className={css.roles} aria-labelledby="tp-roles">
      <div className={css.subHead}><h3 id="tp-roles" className={css.h3}>Roles needed ({plan.roles.length})</h3></div>
      <ul className={css.roleList}>
        {plan.roles.map((r) => <li key={r.role} className={css.role}>
          <span className={css.roleIcon} aria-hidden="true"><User /></span>
          <span className={css.roleText}>
            <span className={css.roleName}>{r.role}</span>
            {r.suggested ? <span className={css.roleWho}>{firstName(r.suggested)} (suggested)</span> : null}
          </span>
        </li>)}
      </ul>
    </section>
  </>;
}

export function TemplatePickerClient({ vm }: { vm: TemplatePickerVM }) {
  const [picked, setPicked] = useState<string | null>(vm.pickedId);
  const [open, setOpen] = useState(!!vm.sheetOpen);
  const t = vm.templates.find((x) => x.id === picked) ?? null;

  return <div className={css.cols}>
    <section className={css.list} aria-labelledby="tp-templates">
      <h2 id="tp-templates" className={css.srOnly}>Templates</h2>
      <div className={css.cards} role="radiogroup" aria-labelledby="tp-templates">
        {vm.templates.map((o) => {
          const on = o.id === picked;
          return <button key={o.id} type="button" role="radio" aria-checked={on} className={css.card} data-on={on ? "" : undefined} onClick={() => setPicked(o.id)}>
            <Tile t={o} />
            <span className={css.cText}>
              <span className={css.cNameRow}>
                <span className={css.cName}>{o.name}</span>
                {o.recommended ? <span className={css.rec}>Recommended</span> : null}
              </span>
              <span className={css.cCounts}>{countsText(o, vm.scratchLabel)}</span>
            </span>
            <span className={css.radio} aria-hidden="true" />
          </button>;
        })}
      </div>
    </section>

    <section className={css.panel} data-open={open ? "" : undefined} data-empty={t ? undefined : ""} aria-labelledby="tp-preview">
      <button type="button" className={css.grip} aria-expanded={open} aria-controls="tp-plan" onClick={() => setOpen(!open)}>
        <span className={css.srOnly}>{open ? "Hide the plan" : "Show the plan"}</span>
      </button>
      <header className={css.pHead}>
        {t ? <Tile t={t} size="lg" /> : null}
        <div className={css.pTitles}>
          <h2 id="tp-preview" className={css.pTitle}>{t ? t.name : vm.emptyNote}</h2>
          {t ? <p className={css.pCounts}>{countsText(t, vm.scratchLabel)}</p> : null}
        </div>
      </header>
      <div className={css.pAct}>
        {t
          ? <PmButton variant="primary" size="lg" href={t.useHref} className={css.useBtn}>{vm.useLabel}</PmButton>
          : <PmButton variant="primary" size="lg" disabled className={css.useBtn}>{vm.useLabel}</PmButton>}
      </div>
      <div id="tp-plan" className={css.pBody}>
        {t ? <Plan t={t} /> : <div className={css.placeholder} aria-hidden="true"><Layers /></div>}
      </div>
    </section>
  </div>;
}
