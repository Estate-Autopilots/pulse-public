"use client";
// PM-UI 08 setup wizard, the live part. Clocks: each date is a 44 px date button that opens the kit calendar (a bottom
// sheet on a phone); moving Day 0 moves Ads live with it and recomputes every phase (`planRows`), tinting what moved.
// People: each role has the kit PersonSelect; load words follow the person picked. Preview: colour and icon are live;
// "Create project" turns into "Creating…". Real wiring: `onClocks`, `onRoles`, `onIdentity`, `onCreate`.
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft, CalendarCheck, CalendarDays, CalendarRange, Camera, Check, ClipboardCheck, Clock3, Database, Flag, Image as ImageIcon, Laptop, Layers, Lightbulb,
  Loader2, Megaphone, Plus, ReceiptText, Users, type LucideIcon,
} from "lucide-react";
import { Calendar } from "../../../kit/date-picker";
import { Popover } from "../../../kit/popover";
import { PersonSelect } from "../../../kit/combobox";
import {
  clockEdited, datesOf, dayLabel, moveClock, planRows, type ClockDates, type ClocksBody, type PeopleBody, type PreviewBody, type SetupWizardVM, type WizardClock, type WizardHue, type WizardStep,
} from "../contract/setup-wizard";
import type { IconKey, IsoDate, ProjectRef } from "../contract/shared";
import { PROJECT_ICONS, PersonLine, PmButton, PmCard, SectionCard, daysBetween, fmtDay, fmtDayShort, fmtRange, hued, nDays } from "../kit";
import css from "./setup-wizard.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** A phase's icon by its name (presentation only; the template has no phase icons yet). */
const PHASE_ICONS: Record<string, LucideIcon> = {
  "Kick-off": Flag, "Brand blueprint": Layers, Shoot: Camera, "Creative assets": ImageIcon, "Landing page": Laptop,
  "CRM setup": Database, "Sales training": Users, Review: ClipboardCheck, "Ads live": Megaphone,
};
const PhaseIcon = ({ name }: { name: string }) => { const I = PHASE_ICONS[name] ?? Flag; return <I className={css.rowIcon} aria-hidden="true" />; };
const CLOCK_ICONS: Record<string, LucideIcon> = { invoice_paid: ReceiptText, inputs_complete: CalendarCheck, ads_live: Megaphone };
const HUE_NAMES: Record<WizardHue, string> = { indigo: "Indigo", teal: "Teal", green: "Green", sky: "Sky", amber: "Amber", pink: "Pink", orange: "Orange", slate: "Slate" };
/** `hued` for the picker's colours: indigo is not a kit hue, so it rides on the kit class and the CSS here sets its colour. */
const huedW = (h: WizardHue, className: string) => ({ ...hued(h === "indigo" ? "slate" : h, className), "data-hue": h });
const ICON_NAMES: Partial<Record<IconKey, string>> = { building: "Building", house: "House", landmark: "Landmark", store: "Shop", tree: "Tree", sun: "Sun", waves: "Waves", palm: "Palm" };

export type WizardCallbacks = {
  onClocks?: (dates: ClockDates) => void;
  onRoles?: (roles: Record<string, string | null>) => void;
  onIdentity?: (identity: { hue: WizardHue; icon: IconKey }) => void;
  onCreate?: () => void;
};

export function SetupWizardView({ vm, ...cb }: { vm: SetupWizardVM } & WizardCallbacks) {
  const [hue, setHue] = useState<WizardHue>(vm.project.hue);
  const [icon, setIcon] = useState<IconKey>(vm.project.icon);
  const [busy, setBusy] = useState(!!vm.nav.busy);
  const project = { ...vm.project, icon };
  const pickIdentity = (next: { hue: WizardHue; icon: IconKey }) => { setHue(next.hue); setIcon(next.icon); cb.onIdentity?.(next); };
  const create = () => { if (busy) return; setBusy(true); cb.onCreate?.(); };
  const b = vm.body;

  return <div className={css.wizard} aria-busy={busy || undefined}>
    <div className={css.top}>
      <Link href={vm.exitHref} className={css.exit} aria-label="Back to Projects"><ArrowLeft aria-hidden="true" /></Link>
      <p className={css.kicker}>New project</p>
    </div>
    <Stepper steps={vm.steps} />
    <Band project={project} hue={hue} template={vm.template.name} identity={b.kind === "preview" ? b.identity : undefined} onPick={pickIdentity} disabled={busy} />
    <header className={css.head}>
      <h1 className={css.h1}>{b.title}</h1>
      {b.kind === "people" ? <p className={css.sub}>{b.sub}</p> : null}
      {b.kind === "preview" ? <PreviewHead body={b} /> : null}
    </header>
    {b.kind === "clocks" ? <Clocks body={b} today={vm.today} onClocks={cb.onClocks} /> : null}
    {b.kind === "people" ? <People body={b} onRoles={cb.onRoles} /> : null}
    {b.kind === "preview" ? <Preview body={b} /> : null}

    <div className={css.bar}>
      {busy ? <PmButton variant="outline" size="lg" className={css.back} disabled>{vm.nav.back.label}</PmButton>
        : <PmButton variant="outline" size="lg" className={css.back} href={vm.nav.back.href}>{vm.nav.back.label}</PmButton>}
      {vm.nav.next.kind === "next"
        ? <PmButton variant="primary" size="lg" className={css.next} href={vm.nav.next.href}>{vm.nav.next.label}</PmButton>
        : <PmButton variant="primary" size="lg" className={cx(css.next, busy && css.busy)} disabled={busy} icon={busy ? Loader2 : undefined} onClick={create}>
          {busy ? vm.nav.next.busyLabel ?? "Creating…" : vm.nav.next.label}
        </PmButton>}
      <span className={css.srOnly} role="status">{busy ? "Creating the project" : ""}</span>
    </div>
  </div>;
}

/* ---------- Stepper (same four steps as the template picker) ---------- */

function Stepper({ steps }: { steps: WizardStep[] }) {
  return <nav aria-label="New project steps" className={css.stepperWrap}>
    <ol className={css.stepper}>{steps.map((s, i) => {
      const body = <>
        <span className={css.dot} aria-hidden="true">{s.state === "done" ? <Check /> : i + 1}</span>
        <span className={css.stepLabel}>{s.label}</span>
        {s.state === "done" ? <span className={css.srOnly}> (done)</span> : null}
      </>;
      return <li key={s.key} className={css.step} data-state={s.state}>
        {i ? <span className={css.line} aria-hidden="true" /> : null}
        {s.href ? <Link href={s.href} className={css.stepBody}>{body}</Link>
          : <span className={css.stepBody} aria-current={s.state === "current" ? "step" : undefined}>{body}</span>}
      </li>;
    })}</ol>
  </nav>;
}

/* ---------- Project band ---------- */

function Band({ project, hue, template, identity, onPick, disabled }: { project: ProjectRef; hue: WizardHue; template: string; identity?: PreviewBody["identity"]; onPick: (v: { hue: WizardHue; icon: IconKey }) => void; disabled?: boolean }) {
  const Icon = PROJECT_ICONS[project.icon];
  return <section {...huedW(hue, css.band)} aria-label="Project" data-identity={identity ? "" : undefined}>
    <div className={css.bandMain}>
      <span className={css.bandTile} aria-hidden="true"><Icon /></span>
      <p className={css.bandText}><b className={css.bandName}>{project.name}</b><span className={css.bandDot} aria-hidden="true"> · </span><span className={css.bandSub}>{template}</span></p>
    </div>
    {identity ? <div className={css.identity}>
      <p className={css.identityLabel}>Colour and icon</p>
      <div className={css.swatches} role="radiogroup" aria-label="Colour">
        {identity.hues.map((h) => <button key={h} type="button" role="radio" aria-checked={h === hue} aria-label={HUE_NAMES[h]} disabled={disabled}
          {...huedW(h, css.swatch)} onClick={() => onPick({ hue: h, icon: project.icon })}>
          <span className={css.swatchDot}>{h === hue ? <Check aria-hidden="true" /> : null}</span>
        </button>)}
      </div>
      <div className={css.icons} role="radiogroup" aria-label="Icon">
        {identity.icons.map((k) => { const I = PROJECT_ICONS[k]; return <button key={k} type="button" role="radio" aria-checked={k === project.icon} aria-label={ICON_NAMES[k] ?? k} disabled={disabled}
          className={css.iconBtn} onClick={() => onPick({ hue, icon: k })}><I aria-hidden="true" /></button>; })}
      </div>
    </div> : null}
  </section>;
}

/* ---------- Step 2: clocks ---------- */

function Clocks({ body, today, onClocks }: { body: ClocksBody; today: IsoDate; onClocks?: (d: ClockDates) => void }) {
  const was = useMemo(() => datesOf(body.clocks, "was"), [body.clocks]);
  const [dates, setDates] = useState<ClockDates>(() => datesOf(body.clocks));
  const [open, setOpen] = useState<string | null>(body.pickerOpen ?? null);
  const rows = useMemo(() => planRows(body.phases, dates, was), [body.phases, dates, was]);
  const day0 = body.clocks.find((c) => c.isDay0) ?? body.clocks[0];
  const target = body.clocks[body.clocks.length - 1];
  const span = daysBetween(dates[day0.key], dates[target.key]);
  const moved = rows.filter((r) => r.moved);
  const shifts = new Set(moved.map((r) => r.shift));
  const shift = shifts.size === 1 ? moved[0].shift : null;
  const movedText = moved.length === 0 ? null
    : `${moved.length} ${moved.length === 1 ? "phase moves" : "phases move"}${shift !== null ? ` ${shift > 0 ? "+" : "−"}${nDays(Math.abs(shift))}` : ""}`;

  const pick = (c: WizardClock, d: IsoDate) => { const next = moveClock(body.clocks, dates, c.key, d); setDates(next); onClocks?.(next); };

  return <div className={cx(css.cols, css.clockCols)}>
    <PmCard className={css.clockCard} label="Clocks" as="section">
      <ul className={css.clockRows}>{body.clocks.map((c) => {
        const changed = clockEdited(c, dates, was);
        const Icon = CLOCK_ICONS[c.key] ?? CalendarDays;
        const sub = [c.isDay0 ? null : dayLabel(dates[day0.key], dates[c.key]), changed ? `was ${fmtDayShort(c.was)}` : null].filter(Boolean).join(" · ");
        return <li key={c.key} className={css.clockRow} data-changed={changed ? "" : undefined}>
          <span className={css.clockIcon} aria-hidden="true"><Icon /></span>
          <span className={css.clockText}>
            <span className={css.clockName}>{c.label}{changed ? <span className={cx(css.changed, css.changedWide)}>Changed</span> : null}</span>
            {sub ? <span className={css.clockSub}>{changed ? <span className={cx(css.changed, css.changedNarrow)}>Changed</span> : null}<span>{sub}</span></span> : null}
          </span>
          <DateButton label={c.label} value={dates[c.key]} today={today} open={open === c.key} onOpen={() => setOpen(c.key)} onClose={() => setOpen((k) => (k === c.key ? null : k))} onPick={(d) => pick(c, d)} />
        </li>;
      })}</ul>
      <p className={css.span}><CalendarRange aria-hidden="true" />{nDays(span)} from Day 0</p>
    </PmCard>

    <SectionCard title="Due dates preview" className={css.planCard}>
      <ol className={css.planRows}>{rows.map((r) => <li key={r.id} className={css.planRow} data-moved={r.moved ? "" : undefined}>
        <PhaseIcon name={r.name} />
        <span className={css.rowName}>{r.name}</span>
        <span className={css.rowDate}>{fmtRange(r.start, r.end)}{r.moved ? <span className={css.srOnly}> (moved {r.shift > 0 ? "+" : "−"}{nDays(Math.abs(r.shift))})</span> : null}</span>
      </li>)}</ol>
      {movedText ? <p className={css.movedNote}><CalendarDays aria-hidden="true" />{movedText}</p> : null}
    </SectionCard>
  </div>;
}

/** A clock's date as a 44 px button with a calendar icon; opens the kit calendar (a bottom sheet under 600 px). */
function DateButton({ label, value, today, open, onOpen, onClose, onPick }: { label: string; value: IsoDate; today: IsoDate; open: boolean; onOpen: () => void; onClose: () => void; onPick: (d: IsoDate) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={ref} type="button" className={css.dateBtn} data-open={open ? "" : undefined} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${label}: ${fmtDay(value)}. Change date`} onClick={() => (open ? onClose() : onOpen())}>
      <CalendarDays aria-hidden="true" /><span>{fmtDayShort(value)}</span>
    </button>
    <Popover open={open} onClose={onClose} anchor={ref} label={`Choose the date for ${label}`} placement="bottom-end" focus="none" sheet>
      <Calendar value={{ date: value, time: null }} today={today} quick={false} label={`Choose the date for ${label}`}
        onChange={(v) => { if (v.date) onPick(v.date); onClose(); }} />
    </Popover>
  </>;
}

/* ---------- Step 3: people ---------- */

function People({ body, onRoles }: { body: PeopleBody; onRoles?: (r: Record<string, string | null>) => void }) {
  const [map, setMap] = useState<Record<string, string | null>>(() => Object.fromEntries(body.roles.map((r) => [r.role, r.personId])));
  const set = (role: string, id: string | null) => { const next = { ...map, [role]: id }; setMap(next); onRoles?.(next); };
  return <div className={cx(css.cols, css.peopleCols)}>
    <PmCard className={css.rolesCard} label="Roles" as="section" pad={false}>
      <ul className={css.roleRows}>{body.roles.map((r) => {
        const id = map[r.role];
        const load = id ? body.load[id] : undefined;
        return <li key={r.role} className={css.roleRow}>
          <span className={css.roleName}>{r.role}</span>
          {load ? <span className={css.load} data-tone={load.tone}>{load.word}</span> : null}
          <span className={css.pick}><PersonSelect people={body.team} value={id} label={r.role} onChange={(p) => set(r.role, p?.id ?? null)} /></span>
          {load?.hint ? <p className={css.hint}><Lightbulb aria-hidden="true" />{load.hint}</p> : null}
        </li>;
      })}</ul>
    </PmCard>
    <SectionCard title="Client contact" className={css.contactCard}>
      {body.contact ? <PersonLine person={body.contact} full size={32} meta={body.clientName ?? undefined} className={css.contact} /> : <p className={css.muted}>No contact yet</p>}
      <PmButton variant="outline" size="sm" icon={Plus} href={body.addContactHref} className={css.addContact}>Add contact</PmButton>
    </SectionCard>
  </div>;
}

/* ---------- Step 4: preview and create ---------- */

function PreviewHead({ body }: { body: PreviewBody }) {
  const s = body.summary;
  return <>
    <p className={css.summary}>{s.phases} phases · {s.steps} steps · {s.days} days · {s.target.label} {fmtDayShort(s.target.date)}</p>
    <p className={css.clockLine}><Clock3 aria-hidden="true" />{body.clocks.map((c) => `${c.short} ${fmtDayShort(c.date)}`).join(" · ")}</p>
  </>;
}

function Preview({ body }: { body: PreviewBody }) {
  const total = body.phases.reduce((n, p) => n + p.steps, 0);
  return <div className={css.cols}>
    <SectionCard title="Phases" aside={<span className={css.muted}>{total} steps</span>} className={css.planCard}>
      <ol className={css.planRows}>{body.phases.map((r) => <li key={r.id} className={css.planRow} data-counts="">
        <PhaseIcon name={r.name} />
        <span className={css.rowName}>{r.name}</span>
        <span className={css.rowDate}>{fmtRange(r.start, r.end)}</span>
        <span className={css.rowSteps}>{r.steps} steps</span>
      </li>)}</ol>
    </SectionCard>
    <SectionCard title="First 5 steps" className={css.firstCard}>
      <ol className={css.firstRows}>{body.firstSteps.map((s) => <li key={s.id} className={css.firstRow}>
        <span className={css.firstTitle}>{s.title}</span>
        <span className={css.firstMeta}><PersonLine person={s.owner} full size={24} /><span className={css.firstDate}>{fmtDayShort(s.due)}</span></span>
      </li>)}</ol>
    </SectionCard>
  </div>;
}
