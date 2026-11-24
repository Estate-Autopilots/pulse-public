"use client";
// PM-UI: the Weekly update form (sheets/weekly-update.md). Local state so the preview is clickable: edit the three
// fields ("Edit" focuses the first), pick the health (better than the system needs a reason; Post update stays disabled
// until it is given), switch the client-safe version, Save draft, Post update (turns the page read-only). Pass the
// callbacks to wire real data, or post to each action's href.
import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, CircleCheck, Eye, Info, Pencil } from "lucide-react";
import type { UpdateHealth, UpdateSection, WeeklyUpdateVM } from "../contract/weekly-update";
import { HEALTH_WORDS, HealthChip, PmButton, ProjectTile, firstName, fmtDay, fmtDayShort, hued } from "../kit";
import css from "./weekly-update.module.css";

export type WeeklyUpdateDraft = { sections: Record<UpdateSection["key"], string[]>; health: UpdateHealth; reason: string; clientSafe: boolean };
type Props = {
  vm: WeeklyUpdateVM;
  /** Called on Post update with the edited update. */ onPost?: (draft: WeeklyUpdateDraft) => void;
  /** Called on Save draft. */ onSaveDraft?: (draft: WeeklyUpdateDraft) => void;
};

const RANK: Record<UpdateHealth, number> = { on_track: 0, at_risk: 1, late: 2 };
const BULLET = "• ";
const toText = (lines: string[]) => lines.map((l) => BULLET + l).join("\n");
const toLines = (text: string) => text.split("\n").map((l) => l.replace(/^\s*[•\-*]\s*/, "").trim()).filter(Boolean);

export default function WeeklyUpdateForm({ vm, onPost, onSaveDraft }: Props) {
  const uid = useId();
  const firstField = useRef<HTMLTextAreaElement>(null);
  const [texts, setTexts] = useState(() => Object.fromEntries(vm.sections.map((s) => [s.key, toText(s.lines)])) as Record<UpdateSection["key"], string>);
  const [picked, setPicked] = useState<UpdateHealth>(vm.health.picked);
  const [reason, setReason] = useState(vm.health.reason);
  const [reasonTouched, setReasonTouched] = useState(!!vm.health.reasonError);
  const [clientOn, setClientOn] = useState(vm.clientSafe.on);
  const [posted, setPosted] = useState(vm.mode === "posted" ? vm.posted : null);
  const [notice, setNotice] = useState("");

  const sys = vm.health.system;
  const sysWord = HEALTH_WORDS[sys.key].word;
  const better = RANK[picked] < RANK[sys.key];
  const reasonMissing = better && !reason.trim();
  const reasonError = better && reasonTouched && reasonMissing ? vm.health.reasonError ?? "Reason is required" : undefined;
  const readOnly = !!posted;

  const draft = (): WeeklyUpdateDraft => ({
    sections: Object.fromEntries(vm.sections.map((s) => [s.key, toLines(texts[s.key])])) as WeeklyUpdateDraft["sections"],
    health: picked, reason: better ? reason.trim() : "", clientSafe: clientOn,
  });
  const edit = () => {
    const el = firstField.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  const post = () => {
    if (reasonMissing) { setReasonTouched(true); return; }
    onPost?.(draft());
    setPosted({ by: vm.viewer.person, on: vm.today, clientShared: clientOn });
    setNotice("Update posted.");
  };
  const save = () => { onSaveDraft?.(draft()); setNotice("Draft saved."); };
  /** Enter starts a new bullet line. */
  const onKey = (key: UpdateSection["key"]) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const next = `${value.slice(0, a)}\n${BULLET}${value.slice(b)}`;
    setTexts((t) => ({ ...t, [key]: next }));
    requestAnimationFrame(() => { const at = a + 1 + BULLET.length; el.setSelectionRange(at, at); });
  };

  const postedWhen = posted ? (posted.on === vm.today ? "today" : `on ${fmtDay(posted.on)}`) : "";
  const postedBy = posted ? (posted.by.id === vm.viewer.person.id ? firstName(posted.by) : posted.by.name) : "";

  return <form className={css.sheet} aria-labelledby={`${uid}-title`} onSubmit={(e) => { e.preventDefault(); if (!readOnly) post(); }}>
    <header className={css.titleRow}>
      <Link href={vm.project.href} className={css.backBtn} aria-label={`Back to ${vm.project.name}`}><ArrowLeft aria-hidden="true" /></Link>
      <h1 id={`${uid}-title`} className={css.h1}>Weekly update</h1>
      <span className={css.week}>Week of {fmtDayShort(vm.weekOf)}</span>
    </header>

    <div {...hued(vm.project.hue, css.project)}>
      <ProjectTile project={vm.project} />
      <span className={css.projectText}>
        <span className={css.projectName}>{vm.project.name}</span>
        <HealthChip health={vm.project.health} />
      </span>
    </div>

    {posted ? <p className={css.postedLine}><CircleCheck aria-hidden="true" /><span>Posted {postedWhen} by {postedBy}{posted.clientShared ? <> <span className={css.keep}>· client-safe version shared</span></> : null}</span></p>
      : vm.draftBy ? <div className={css.draft}>
        <Pencil aria-hidden="true" />
        <p className={css.draftText}><span className={css.draftBy}>Draft by {vm.draftBy}</span> <span className={css.keep}>· edit before posting</span></p>
        <button type="button" className={css.editLink} onClick={edit}>Edit</button>
      </div> : null}

    {vm.sections.map((s, i) => <div key={s.key} className={css.field}>
      <label htmlFor={readOnly ? undefined : `${uid}-${s.key}`} className={css.label} id={`${uid}-${s.key}-l`}>{s.label}</label>
      {readOnly
        ? <ul className={css.readBox} aria-labelledby={`${uid}-${s.key}-l`}>{toLines(texts[s.key]).map((l) => <li key={l}>{l}</li>)}</ul>
        : <textarea id={`${uid}-${s.key}`} ref={i === 0 ? firstField : undefined} className={css.box} value={texts[s.key]}
          rows={Math.max(1, texts[s.key].split("\n").length)} spellCheck
          onChange={(e) => { const v = e.target.value; setTexts((t) => ({ ...t, [s.key]: v })); }} onKeyDown={onKey(s.key)} />}
    </div>)}

    <div className={css.health} data-better={better ? "" : undefined}>
      <span id={`${uid}-health`} className={css.label} data-area="label">Project health</span>
      <div className={css.pills} role="radiogroup" aria-labelledby={`${uid}-health`} data-area="pills">
        {vm.health.options.map((o) => <label key={o.key} className={css.pill} data-tone={HEALTH_WORDS[o.key].tone} data-checked={picked === o.key ? "" : undefined} data-disabled={readOnly ? "" : undefined}>
          <input type="radio" name={`${uid}-health`} value={o.key} checked={picked === o.key} disabled={readOnly} className={css.radio}
            onChange={() => { setPicked(o.key); setReasonTouched(false); }} />
          <span className={css.dot} aria-hidden="true" />
          <span>{o.label}</span>
        </label>)}
      </div>
      <p className={css.system} data-area="system" data-alert={better && !readOnly ? "" : undefined} id={`${uid}-sys`}>
        {better && !readOnly ? <Info aria-hidden="true" /> : null}
        <span><b>System says:</b> {sysWord}{sys.reason ? ` (${sys.reason})` : ""}</span>
      </p>
      {better && !readOnly ? <div className={css.reasonField} data-area="reason">
        <label htmlFor={`${uid}-reason`} className={css.label} data-part="label">Reason <span className={css.labelNote}>(needed to mark better than the system)</span></label>
        <textarea id={`${uid}-reason`} className={css.box} data-part="box" data-invalid={reasonError ? "" : undefined} rows={2} value={reason} required
          aria-invalid={reasonError ? true : undefined} aria-describedby={reasonError ? `${uid}-reason-err` : `${uid}-sys`}
          placeholder="Why is the project on track this week?"
          onChange={(e) => setReason(e.target.value)} onBlur={() => setReasonTouched(true)} />
        {reasonError ? <p id={`${uid}-reason-err`} className={css.error} data-part="error">{reasonError}</p> : null}
      </div> : null}
    </div>

    <div className={css.client}>
      <label className={css.switchRow}>
        <span className={css.switchText}>
          <span className={css.switchLabel}>{vm.clientSafe.label}</span>
          <span className={css.muted}>{vm.clientSafe.help}</span>
        </span>
        <input type="checkbox" role="switch" className={css.switch} checked={readOnly ? !!posted?.clientShared : clientOn} disabled={readOnly}
          onChange={(e) => setClientOn(e.target.checked)} />
      </label>
      {(readOnly ? posted?.clientShared : clientOn) ? <div className={css.preview}>
        <p className={css.previewLabel}><Eye aria-hidden="true" />Client-safe preview</p>
        <p className={css.previewText}>{vm.clientSafe.preview}</p>
      </div> : null}
    </div>

    <div className={css.buttons}>
      {readOnly
        ? <PmButton variant="outline" size="lg" href={vm.actions.backToProject.href ?? vm.project.href}>{vm.actions.backToProject.label}</PmButton>
        : <>
          <PmButton variant="primary" size="lg" type="submit" disabled={reasonMissing} aria-describedby={reasonMissing ? `${uid}-why` : undefined}>{vm.actions.post.label}</PmButton>
          <PmButton variant="outline" size="lg" onClick={save}>{vm.actions.saveDraft.label}</PmButton>
        </>}
    </div>
    {reasonMissing && !readOnly ? <p id={`${uid}-why`} className={css.srOnly}>Add a reason to post this update.</p> : null}
    <p className={css.srOnly} role="status" aria-live="polite">{notice}</p>
  </form>;
}
