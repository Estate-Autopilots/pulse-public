"use client";
// My Pulse actions: thank a colleague (kudos), and "Not right?" on something Pulse knows, which becomes a request to HR.
import { HeartHandshake, PencilLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { Drawer, DrawerFooter, PersonChip, PersonSelect } from "../kit";
import { useDoParam } from "../lib/do-param";
import { styles } from "../ui";
import css from "./my-pulse.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "Not saved";

export function ThankButton({ colleagues }: { colleagues: { id: string; name: string; pod: string | null }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [to, setTo] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useDoParam("thank", () => setOpen(true));
  async function save(e?: FormEvent) {
    e?.preventDefault(); setBusy(true); setError("");
    try { await post("kudos", { to, note }); setOpen(false); setTo(""); setNote(""); router.refresh();
      notify({ id: "kudos", tone: "success", title: `Thanks sent to ${colleagues.find((c) => c.id === to)?.name.split(" ")[0] ?? "them"}`, message: "They see it on their My Pulse. Nobody ranks kudos.", timeout: 3000 }); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  const who = colleagues.find((c) => c.id === to);
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setOpen(true)}><HeartHandshake size={13} aria-hidden="true" />Thank a colleague</button>
    {open ? <Drawer title="Thank a colleague" help="They, their head and HR see it. Nobody ranks kudos." icon={<HeartHandshake size={16} />} size="sm" onClose={() => setOpen(false)}
      context={who ? <PersonChip person={who} size="sm" /> : undefined}
      footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button type="submit" form="kudos-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !to || note.trim().length < 3}>Send thanks</button></DrawerFooter>}>
      <form id="kudos-form" className={css.form} onSubmit={save}>
        <div className={css.formField}><span>Who</span><PersonSelect label="Who" people={colleagues.map((c) => ({ ...c, role: null }))} value={to || null} onChange={(p) => setTo(p?.id ?? "")} placeholder="Choose a colleague…" /></div>
        <label>What for<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} required placeholder="Covered the shoot at short notice; the client loved the reel" /></label>
      </form>
    </Drawer> : null}
  </>;
}

export function CorrectButton({ label, value }: { label: string; value: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [proposed, setProposed] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("me/corrections", { label, value, proposed, note }); setOpen(false); setProposed(""); setNote(""); router.refresh();
      notify({ id: "correction", tone: "success", title: "Sent to HR", message: "It is in your requests with HR; you will see the answer there.", timeout: 3000 }); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setOpen(true)} aria-label={`${label}: not right?`}><PencilLine size={12} aria-hidden="true" />Not right?</button>
    {open ? <Drawer title={`${label}: not right?`} help="HR checks it and corrects your record; it shows in your requests with HR." size="sm" icon={<PencilLine size={16} />} onClose={() => setOpen(false)}
      footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button type="submit" form="correct-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || proposed.trim().length < 2}>Send to HR</button></DrawerFooter>}>
      <form id="correct-form" className={css.form} onSubmit={save}>
        <p className={css.muted}>Pulse shows: <b>{value || "nothing"}</b></p>
        <label>What it should be<input value={proposed} onChange={(e) => setProposed(e.target.value)} maxLength={300} required autoFocus /></label>
        <label>Anything HR should know (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      </form>
    </Drawer> : null}
  </>;
}

/** UX-5A: a compact My desk tile: a figure and one line; the details open in the side drawer. `aside` holds the tile's
 *  own action (Thank a colleague, the payslip) outside the tile's button. */
export function DeskTile({ title, icon, figure, unit, line, aside, children, tone, ...anchor }: { title: string; icon: ReactNode; figure: ReactNode; unit?: string; line?: ReactNode; aside?: ReactNode; children?: ReactNode; tone?: "attention";
  /** The destinations registry's anchor (`{...dest(id)}`): Ctrl+K's spotlight lands here. */ "data-dest"?: string }) {
  const [open, setOpen] = useState(false);
  return <section className={css.tile} aria-label={title} data-tone={tone} {...anchor}>
    <button type="button" className={css.tileBtn} onClick={() => setOpen(true)} aria-haspopup="dialog" disabled={!children}>
      <span className={css.tileHead}>{icon}<span>{title}</span></span>
      <span className={css.tileFigure}><b>{figure}</b>{unit ? <small>{unit}</small> : null}</span>
      {line ? <span className={css.tileLine}>{line}</span> : null}
    </button>
    {aside ? <span className={css.tileAside}>{aside}</span> : null}
    {open ? <Drawer title={title} icon={icon} onClose={() => setOpen(false)}>{children}</Drawer> : null}
  </section>;
}
