"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Link2, Pencil, Unlink } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { celebrate } from "../kit/game";
import { SelectField } from "../kit/select-field";
import { Switch } from "../kit/switch";
import { Modal, post } from "../records";
import { styles } from "../ui";
import type { PromiseField } from "./plan-more";
import css from "./plan-clocks.module.css";

/** PM-BUILD-2 (2310): the actions of "What we promised" and "Set up this project". The database decides who may. */
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not save. Try again.";

/** Change (or first fill in) what was promised. Sales' own change is the promise; anyone else's goes to sales to confirm. */
export function PromiseEdit({ projectId, fields, bySales, first, confirmers, waiting }: { projectId: string; fields: PromiseField[]; bySales: boolean; first: boolean; confirmers?: string | null;
  /** A change already waiting for sales (a new one replaces it). */ waiting?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    const values = Object.fromEntries(fields.map((x) => [x.key, String(f.get(x.key) ?? "").trim() || null]));
    try {
      const r = await post<{ confirmed: boolean }>(`projects/${projectId}/promise`, { values, note: f.get("note") || null });
      notify({ id: "promise", tone: "success", title: r.confirmed ? "Saved" : "Sent to sales to confirm", message: r.confirmed ? "The lead and the heads are told." : "It counts once sales confirms it.", timeout: 4000 });
      setOpen(false); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  const label = first ? "Add the numbers" : "Change";
  const [now, setNow] = useState<Record<string, string>>({});
  return <>
    <button type="button" className={styles.btn} onClick={() => setOpen(true)}><Pencil size={13} aria-hidden="true" />{label}</button>
    {open ? <Modal title={first ? "What we promised" : "Change what we promised"} sub={bySales ? "Your numbers are the promise." : `${confirmers ?? "Sales"} confirms it.`}
      size="sm" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}>
        <button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button>
        <button form="promise-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{bySales ? "Save" : "Send to sales"}</button></div>}>
      <form id="promise-form" onSubmit={save} className={css.promiseForm}>
        {waiting ? <p className={css.promiseWaiting} data-wide="">Already waiting for sales: {waiting}. Sending a new change replaces it.</p> : null}
        {fields.map((x) => <label key={x.key} className={styles.field} data-wide={x.kind === "text" ? "" : undefined}>{x.label}{x.unit ? ` (${x.unit})` : ""}
          {x.kind === "text" ? <input name={x.key} defaultValue={x.value ?? ""} maxLength={400} placeholder="In the client's own words" />
            : <input name={x.key} inputMode="decimal" pattern="[0-9]*[.]?[0-9]*" defaultValue={x.value ?? ""} onChange={(e) => setNow((m) => ({ ...m, [x.key]: e.target.value }))} />}
          {!first && x.kind !== "text" && now[x.key] !== undefined && now[x.key] !== String(x.value ?? "") ? <small className={css.changed}>{x.value ?? "—"} → {now[x.key] || "—"}</small> : null}
          {x.hint ? <small className={css.hint}>{x.hint}</small> : null}</label>)}
        {bySales ? null : <label className={styles.field} data-wide="">Why it changes (sales reads this)<textarea name="note" maxLength={300} rows={2} required minLength={3} placeholder="For example: the client raised the target on the call" /></label>}
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}
  </>;
}

/** Sales confirms or turns down a proposed change. */
export function PromiseAnswer({ projectId }: { projectId: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function answer(accept: boolean, el: HTMLElement) {
    setBusy(true);
    try { await post(`projects/${projectId}/promise/answer`, { accept }); if (accept) celebrate(el, { id: `promise-${projectId}` });
      notify({ id: "promise", tone: "success", title: accept ? "Confirmed" : "Turned down", timeout: 3000 }); router.refresh(); }
    catch (err) { notify({ id: "promise", tone: "error", title: "Not saved", message: msg(err) }); } finally { setBusy(false); }
  }
  return <span className={css.promiseAnswer}>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={(e) => answer(true, e.currentTarget)}>Confirm</button>
    <button type="button" className={styles.btn} disabled={busy} onClick={(e) => answer(false, e.currentTarget)}>Turn down</button></span>;
}

/** Who holds a role on this project: a person, or nobody here (its steps that nobody started are left out). */
export function RolePick({ projectId, role, value, people, outside }: { projectId: string; role: string; value: string; people: { id: string; name: string }[]; outside: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function pick(v: string) {
    setBusy(true);
    try {
      const r = await post<{ assigned: number; notMade: number; back: number }>(`projects/${projectId}/roles`, { roles: { [role]: v === "" ? null : v } });
      notify({ id: `role-${role}`, tone: "success", title: v === "none" ? `${role}: nobody on this project` : `${role} set`,
        message: v === "none" ? `${r.notMade} ${r.notMade === 1 ? "step is" : "steps are"} left out. Pick someone later to bring ${r.notMade === 1 ? "it" : "them"} back.`
          : r.assigned ? `${r.assigned} ${r.assigned === 1 ? "step is" : "steps are"} theirs now.` : undefined, timeout: 4000 });
      router.refresh();
    } catch (err) { notify({ id: `role-${role}`, tone: "error", title: "Not saved", message: msg(err) }); } finally { setBusy(false); }
  }
  return <SelectField size="sm" aria-label={`Who does ${role}`} value={value} disabled={busy} searchable={people.length > 8} onChange={(e) => pick(e.target.value)}>
    <option value="">Choose who</option>
    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    <option value="none">{outside ? "No outside partner here" : "Nobody on this project"}</option>
  </SelectField>;
}

/** Link a group chat to this project (or unlink it). */
export function ChatLinkButton({ projectId, channelId, name, on }: { projectId: string; channelId: string; name: string; on: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await post(`projects/${projectId}/chats`, { channelId, on }); notify({ id: `chat-${channelId}`, tone: "success", title: on ? `Linked: ${name}` : `Unlinked: ${name}`, timeout: 3000 }); router.refresh(); }
    catch (err) { notify({ id: `chat-${channelId}`, tone: "error", title: "Not saved", message: msg(err) }); } finally { setBusy(false); }
  }
  return on ? <button type="button" className={styles.btn} disabled={busy} onClick={go}><Link2 size={13} aria-hidden="true" />Link</button>
    : <button type="button" className={css.unlink} disabled={busy} onClick={go} aria-label={`Unlink ${name}`} title={`Unlink ${name}`}><Unlink size={12} aria-hidden="true" /></button>;
}

/** A condition of the plan holds (its steps are made) or not. */
export function ConditionSwitch({ projectId, k, label, sub, on }: { projectId: string; k: string; label: string; sub: string; on: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [val, setVal] = useState(on);
  async function flip(next: boolean) {
    setBusy(true); setVal(next);
    try { const r = await post<{ tasks: number; notMade: number }>(`projects/${projectId}/condition`, { key: k, on: next });
      notify({ id: `cond-${k}`, tone: "success", title: next ? `${r.tasks} ${r.tasks === 1 ? "step" : "steps"} added` : `${r.notMade} ${r.notMade === 1 ? "step" : "steps"} left out`, timeout: 3000 }); router.refresh(); }
    catch (err) { setVal(!next); notify({ id: `cond-${k}`, tone: "error", title: "Not saved", message: msg(err) }); } finally { setBusy(false); }
  }
  return <div className={css.condRow}><Switch checked={val} disabled={busy} onChange={flip} label={label} hideLabel /><span><b>{label}</b><small>{sub}</small></span></div>;
}
