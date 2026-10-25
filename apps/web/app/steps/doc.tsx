"use client";
// FLOW-C: the Document screen (Write): any template document, e.g. a project blueprint or a brief. Its sections are tabs,
// each with its own draft or final state, written in the rich-text field and saved as you go (every save is a version).
// Pip works on the open section (draft from the write-up, critique against what good looks like, check against the
// Word Library, the facts and the known constraints). The section's typed records sit under it, comments beside it.
// A "section" step writes only its own section of the run's shared document and is done when its section is marked
// done; a whole-document step is done when the document is marked final (frozen).
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, CircleDot, History, Lock, MessageSquare, Snowflake } from "lucide-react";
import { Drawer, DrawerSection } from "../kit";
import { styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import { TextEditor } from "./editor";
import { RecordsInline } from "./records";
import { Comments } from "./comments";
import type { Work } from "./work";
import { collectType, dayText, str, strList, timeText, type RecordDetail } from "./types";
import css from "./work.module.css";

type Section = { text?: string; final?: boolean | null; updatedAt?: string; by?: string; step?: string };

export function DocScreen({ w }: { w: Work }) {
  const router = useRouter();
  const { d } = w, rec = w.rec?.record ?? null, mod = d.step.module;
  const sections = (rec?.data.sections ?? {}) as Record<string, Section>;
  const outline = strList(rec?.data.outline).length ? strList(rec?.data.outline) : strList(d.settings.sections).length ? strList(d.settings.sections) : Object.keys(sections);
  const own = mod === "doc_section" ? str(d.settings.section) || d.step.key : null;
  const names = outline.length ? [...outline, ...(own && !outline.includes(own) ? [own] : [])] : [own ?? "Text"];
  const firstOpen = own ?? names.find((n) => !sections[n]?.final) ?? names[0];
  const [tab, setTab] = useState(firstOpen);
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(names.map((n) => [n, str(sections[n]?.text)])));
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [versions, setVersions] = useState(false);
  const frozen = !!rec?.frozenAt;
  const canWrite = (n: string) => w.live && !!rec && !frozen && (own ? n === own : true) && !(own && sections[n]?.final);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function save(n: string) {
    if (!rec) return false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setSaving("saving");
    try {
      await flow(`steps/${d.step.id}/actions/section`, "POST", { section: n, text: texts[n] ?? "" });
      setDirty((x) => ({ ...x, [n]: false })); setSaving("saved");
      if (d.step.state === "open") router.refresh();
      return true;
    } catch { setSaving("failed"); return false; }
  }
  function change(n: string, v: string) {
    setTexts((x) => ({ ...x, [n]: v })); setDirty((x) => ({ ...x, [n]: true })); setSaving("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(n); }, 2500);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Pip works on the open section; an outline it drafts can be put at the end of it.
  const text = texts[tab] ?? "";
  const { focus } = w, writable = canWrite(tab);
  useEffect(() => {
    focus({ label: `“${tab}”`, text, use: writable ? { label: `Put this outline in “${tab}”`, put: (o) => change(tab, (texts[tab] ?? "").trim() ? `${texts[tab].trimEnd()}\n\n${o}` : o) } : undefined });
  }, [tab, text, writable]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go(n: string) { if (dirty[tab]) await save(tab); setTab(n); }
  /** The section is final: a section step is done with it (what waited on it opens); in a whole document it is one of its parts. */
  async function finish(n: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const ok = await w.act(`steps/${d.step.id}/actions/section`, { section: n, text: texts[n] ?? "", final: true }, own ? "Section done: the steps that needed it open" : `“${n}” is final`);
    if (ok) setDirty((x) => ({ ...x, [n]: false }));
  }
  const recType = collectType(d);
  const sec = sections[tab] ?? {};
  const wordsIn = (n: string) => (texts[n] ?? "").trim() ? (texts[n] ?? "").trim().split(/\s+/).length : 0;

  if (!rec) return <NoRecord w={w} />;
  return <div className={css.doc}>
    <header className={css.docHead}>
      <span className={css.docTitle}><b>{rec.title}</b>
        <small>{frozen ? <><Snowflake size={12} aria-hidden="true" />Final · frozen {dayText(rec.frozenAt)}</> : <>{rec.statusLabel} · version {rec.version}{rec.updatedAt ? ` · saved ${timeText(rec.updatedAt)}` : ""}</>}</small></span>
      <span className={css.saveState} data-s={saving} aria-live="polite">{saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "failed" ? "Not saved · it will try again" : dirty[tab] ? "Changes not saved yet" : ""}</span>
      <button type="button" className={styles.btn} onClick={() => setVersions(true)}><History size={14} aria-hidden="true" />Versions</button>
    </header>

    <div className={css.docTabs} role="tablist" aria-label="Sections">{names.map((n) => { const s = sections[n];
      return <button key={n} type="button" role="tab" aria-selected={tab === n} onClick={() => void go(n)} data-own={own === n ? "" : undefined}
        ref={tab === n ? (el) => { el?.scrollIntoView({ block: "nearest", inline: "nearest" }); } : undefined}>
        {s?.final ? <Check size={13} aria-label="final" /> : wordsIn(n) ? <CircleDot size={13} aria-label="draft" /> : <span className={css.dotEmpty} aria-hidden="true" />}{n}</button>; })}</div>

    <section className={css.section} aria-label={tab}>
      <div className={css.sectionHead}>
        <h2>{tab}</h2>
        <span className={css.chip} data-tone={sec.final ? "good" : wordsIn(tab) ? "warn" : "neutral"}>{sec.final ? "Final" : wordsIn(tab) ? "Draft" : "Not started"}</span>
        {sec.updatedAt ? <small>{sec.step && sec.step !== d.step.key ? `Written in step ${sec.step} · ` : ""}{timeText(sec.updatedAt)}</small> : null}
        {own && tab !== own ? <small className={css.lockNote}><Lock size={12} aria-hidden="true" />Another step writes this section</small> : null}
      </div>
      <TextEditor key={tab} value={text} onChange={(v) => change(tab, v)} onBlur={() => { if (dirty[tab]) void save(tab); }} readOnly={!writable} label={`Section ${tab}`}
        placeholder={`Write “${tab}” here. Pip, on the right, can draft an outline from the write-up.`} />
      {writable ? <div className={css.sectionFoot}>
        <small>{wordsIn(tab)} words</small>
        {own ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !wordsIn(tab)} onClick={() => void finish(tab)}><Check size={14} aria-hidden="true" />Mark section done</button>
          : <button type="button" className={styles.btn} disabled={w.busy || !wordsIn(tab)} onClick={() => void finish(tab)}><Check size={14} aria-hidden="true" />Section is final</button>}
      </div> : null}
      {own && tab === own && sec.final && d.step.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />This section is done; the steps that needed it have opened.</p> : null}
      {recType && (own ? tab === own : true) ? <RecordsInline w={w} type={recType} note={own ? "The records this section holds: kept with their source and status, they are what later steps use." : undefined} /> : null}
      <Comments w={w} recordId={rec.id} section={tab} />
    </section>

    {!own && w.live && !frozen ? <div className={css.finishBar}>
      <span>{names.filter((n) => sections[n]?.final).length} of {names.length} sections final</span>
      {mod === "pack" ? <>
        <button type="button" className={styles.btn} disabled={w.busy || d.step.state === "confirmed"} onClick={() => void w.act(`steps/${d.step.id}/actions/ready`, {}, "Written: ready to send")}>It is written</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${d.step.id}/finish`, {}, "Sent: the steps that waited on it open")}>It is sent</button>
      </> : <>
        <button type="button" className={styles.btn} disabled={w.busy} title="Nobody can change it after this, not even the steps that write its sections"
          onClick={async () => { for (const n of names) if (dirty[n]) await save(n); await w.act(`steps/${d.step.id}/actions/final`, {}, "Final: the document is frozen and the step is done"); }}><Snowflake size={14} aria-hidden="true" />Freeze as final</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={async () => { for (const n of names) if (dirty[n]) await save(n); await w.act(`steps/${d.step.id}/finish`, {}, "Done: the document goes to the steps that need it"); }}>
          <Check size={14} aria-hidden="true" />Done</button>
      </>}
    </div> : null}

    {versions ? <Versions w={w} rec={w.rec!} section={tab} onClose={() => setVersions(false)} onUse={writable ? (t) => { change(tab, t); setVersions(false); } : undefined} /> : null}
  </div>;
}

/** A step of this kind whose record is not made yet: the person cannot act on it, or it is not open. */
function NoRecord({ w }: { w: Work }) {
  const s = w.d.step;
  return <div className={css.emptyWork}><MessageSquare size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The document opens when the step does" : "Nothing written here"}</b>
    <span>{s.state === "waiting" ? s.stateText : w.d.canAct ? "Open the step to start its document." : "Its person writes it here."}</span></div>;
}

/** Earlier versions of the document: each save is one. A section's old text can be put back. */
function Versions({ w, rec, section, onClose, onUse }: { w: Work; rec: RecordDetail; section: string; onClose: () => void; onUse?: (text: string) => void }) {
  const [open, setOpen] = useState<{ version: number; text: string | null; error?: string } | null>(null);
  async function view(v: number) {
    setOpen({ version: v, text: null });
    try { const r = await flow<{ data: Record<string, unknown> }>(`records/${rec.record.id}/versions/${v}`); const s = (r.data.sections ?? {}) as Record<string, Section>; setOpen({ version: v, text: str(s[section]?.text) }); }
    catch (e) { setOpen({ version: v, text: null, error: why(e) }); }
  }
  return <Drawer title="Versions" onClose={onClose} size="md" icon={<History size={18} />} context={<span>{rec.record.title}</span>}>
    <DrawerSection>
      <p className={css.quiet}>Every save keeps the document as it was. Open one to read its “{section}”{onUse ? " and put it back" : ""}.</p>
      <ul className={css.versions}>{rec.versions.map((v) => <li key={v.version} aria-current={open?.version === v.version ? "true" : undefined}>
        <button type="button" onClick={() => void view(v.version)}><b>Version {v.version}</b><small>{v.note ?? v.status} · {v.savedBy ?? "Someone"} · {timeText(v.savedAt)}</small></button></li>)}</ul>
      {!rec.versions.length ? <p className={css.quiet}>No earlier versions yet.</p> : null}
    </DrawerSection>
    {open ? <DrawerSection title={`“${section}” in version ${open.version}`}>
      {open.error ? <p className={css.quiet}>{open.error}</p> : open.text === null ? <p className={css.quiet}>Opening…</p> : open.text ? <>
        <TextEditor value={open.text} onChange={() => undefined} readOnly label={`Version ${open.version}`} />
        {onUse ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => onUse(open.text!)}>Put this text back</button> : null}
      </> : <p className={css.quiet}>This section was empty in that version.</p>}
    </DrawerSection> : null}
  </Drawer>;
}
