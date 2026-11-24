"use client";
// PM-UI Client inputs: the page body. Local state so the preview is clickable: Upload opens the sheet (a bottom sheet on
// a phone, a small centred dialog from 600 px), a chosen file marks the row Done. `onUpload` is where the real upload
// plugs in later (POST to the input's `uploadTo`).
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Camera, Check, CheckCheck, FileText, FolderOpen, Image as ImageIcon, Layers, Link2, Megaphone, MessageCircle, ShieldCheck, Sheet,
  Upload, Video, type LucideIcon,
} from "lucide-react";
import { Avatar } from "../../../avatar";
import type { ClientInput, ClientInputIcon, ClientInputsVM, JourneyStep } from "../contract/client-inputs";
import { Chip, PmButton, PmCard, firstName, fmtDayShort } from "../kit";
import css from "./client-inputs.module.css";

const ICONS: Record<ClientInputIcon, LucideIcon> = {
  file: FileText, layers: Layers, table: Sheet, shield: ShieldCheck, image: ImageIcon, video: Video, link: Link2,
};
const JOURNEY_ICONS: Record<JourneyStep["key"], LucideIcon> = {
  share_inputs: FileText, review_materials: Layers, approve_ads: CheckCheck, ads_live: Megaphone,
};

/** "3 of 5" in a ring (accent arc on a soft track). */
function Ring({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className={css.ring} role="img" aria-label={`${done} of ${total} in`}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle className={css.track} cx="50" cy="50" r="44" pathLength={100} />
      {done ? <circle className={css.arc} cx="50" cy="50" r="44" pathLength={100} strokeDasharray={`${pct} 100`} /> : null}
    </svg>
    <span className={css.ringText} aria-hidden="true">{done} of {total}</span>
  </div>;
}

/** One input row: icon, name (+ "Due by" and the error line), state chip, and Upload on a missing one. */
function InputRow({ item, primary, onOpen }: { item: ClientInput; primary: boolean; onOpen: (id: string) => void }) {
  const Icon = ICONS[item.icon] ?? FileText;
  const needed = item.state === "needed";
  return <li className={css.row} data-state={item.state}>
    <Icon className={css.rowIcon} aria-hidden="true" />
    <span className={css.rowName}>{item.name}</span>
    {needed ? <span className={css.sub}>
      <span className={css.chip}><Chip tone="action">Your turn</Chip></span>
      {item.due ? <span className={css.due}>Due by {fmtDayShort(item.due)}</span> : null}
    </span> : <span className={css.chip}><Chip tone="done" icon={Check}>Done</Chip></span>}
    {needed && item.failed ? <span className={css.failed} role="alert">Upload failed. Try again</span> : null}
    {needed ? <span className={css.btn}>
      <PmButton variant={primary ? "primary" : "outline"} icon={Upload} onClick={() => onOpen(item.id)} aria-label={`${item.failed ? "Try again" : "Upload"}: ${item.name}`}>
        {item.failed ? "Try again" : "Upload"}
      </PmButton>
    </span> : null}
  </li>;
}

/** The four journey steps: a list on a phone, a row joined by a line from 600 px of column. */
function Journey({ steps, left, total }: { steps: JourneyStep[]; left: number; total: number }) {
  return <ol className={css.journey}>{steps.map((s) => {
    const Icon = JOURNEY_ICONS[s.key];
    return <li key={s.key} className={css.jStep} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
      <span className={css.dot} aria-hidden="true">{s.state === "done" ? <Check className={css.tick} /> : <Icon className={css.dotIcon} />}</span>
      <span className={css.jText}>
        <span className={css.jLabel}>{s.label}{s.date ? <span className={css.jDate}><span className={css.jSep}> · </span>{fmtDayShort(s.date)}</span> : null}
          {s.state === "done" ? <span className={css.srOnly}> (done)</span> : null}</span>
        {s.note ? <span className={css.jNote}>{s.note}</span> : null}
        {s.key === "share_inputs" && s.state === "current" && left > 0 ? <span className={css.jLeft}>{left} of {total} left</span> : null}
      </span>
    </li>;
  })}</ol>;
}

/** The upload sheet: "Take a photo", "Choose a file", "Cancel". */
function UploadSheet({ item, onClose, onPick }: { item: ClientInput; onClose: () => void; onPick: (file: File) => void }) {
  const photo = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Opening focus goes to the first option (never a ring round the whole panel).
    first.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const Icon = ICONS[item.icon] ?? FileText;
  const picked = (e: ChangeEvent<HTMLInputElement>) => { const f = e.currentTarget.files?.[0]; if (f) onPick(f); };
  return <div className={css.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="ci-sheet-title">
      <span className={css.grip} aria-hidden="true" />
      <header className={css.dHead}>
        <span className={css.dIcon} aria-hidden="true"><Icon /></span>
        <h2 id="ci-sheet-title" className={css.dTitle}>{item.name}</h2>
      </header>
      <div className={css.dBody}>
        <button ref={first} type="button" className={css.pick} onClick={() => photo.current?.click()}><Camera aria-hidden="true" />Take a photo</button>
        <button type="button" className={css.pick} onClick={() => file.current?.click()}><FolderOpen aria-hidden="true" />Choose a file</button>
        <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={picked} />
        <input ref={file} type="file" hidden onChange={picked} />
        <PmButton variant="text" block onClick={onClose} className={css.cancel}>Cancel</PmButton>
      </div>
    </div>
  </div>;
}

export default function ClientInputsBody({ vm, onUpload }: { vm: ClientInputsVM; /** Real upload (later): the input and the chosen file. */ onUpload?: (inputId: string, file: File) => void }) {
  const [items, setItems] = useState(vm.inputs);
  const [open, setOpen] = useState<string | null>(vm.openUploadFor ?? null);
  const close = useCallback(() => setOpen(null), []);
  const total = items.length;
  const done = items.filter((i) => i.state === "done").length;
  const left = total - done;
  const firstNeeded = items.find((i) => i.state === "needed")?.id;
  const sheetItem = open ? items.find((i) => i.id === open) : undefined;
  const lead = vm.team.person;
  const titleText = left === 0 ? `All ${total} are in. Thank you` : `We need from you, ${left} of ${total} left`;
  // The middle dot is drawn with even space both sides (margins, not spaces, so the heavy title's tight tracking cannot
  // squeeze one side); the heading's name keeps a plain reading.
  const title = left === 0 ? titleText : <>We need from you<span className={css.dotSep} aria-hidden="true">·</span><span className={css.nowrap}>{left} of {total} left</span></>;

  return <>
    <div className={css.col}>
      <PmCard as="section" className={css.needCard} label="We need from you">
        <div className={css.head}>
          <div className={css.headText}>
            <h2 className={css.title} aria-label={titleText}>{title}</h2>
            <p className={css.lede}>{vm.sub}</p>
          </div>
          <Ring done={done} total={total} />
        </div>
        <ul className={css.rows}>
          {items.map((i) => <InputRow key={i.id} item={i} primary={i.id === firstNeeded} onOpen={setOpen} />)}
        </ul>
      </PmCard>

      <PmCard as="section" className={css.journeyCard} label="Your journey">
        <h2 className={css.cardTitle}>Your journey</h2>
        <Journey steps={vm.journey} left={left} total={total} />
      </PmCard>

      <PmCard as="section" className={css.teamCard} label="Your team">
        <Avatar name={lead.name} id={lead.id} photoAt={lead.photoAt} size={56} className={css.teamFace} />
        <div className={css.teamText}>
          <p className={css.teamName}>Your team: {firstName(lead)}</p>
          <p className={css.teamRole}>{lead.role}</p>
        </div>
        <PmButton variant="outline" icon={MessageCircle} href={vm.team.chatHref} className={css.chat}>Chat</PmButton>
      </PmCard>
    </div>
    {sheetItem ? <UploadSheet item={sheetItem} onClose={close} onPick={(f) => {
      onUpload?.(sheetItem.id, f);
      setItems((list) => list.map((x) => (x.id === sheetItem.id ? { ...x, state: "done", failed: false } : x)));
      setOpen(null);
    }} /> : null}
  </>;
}
