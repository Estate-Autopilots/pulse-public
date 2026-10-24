"use client";
// FLOW-C: the Collect screens and the small ones. Collect (a form, photos on the spot): the step's form filled right
// here (photos only from the camera, each with the time and the place), or one already sent chosen from the list; then
// the answers are the step's output. Things that must come in: each item marked received with its day (the clock can
// start when the critical ones are in). A quote or an invoice: made in Billing, chosen here. Fix a time. A message to
// send (copied; Pulse sends nothing outside itself). Name who does each role.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, CircleDashed, ClipboardCopy, ClipboardList, ExternalLink, MapPin, Receipt, Send, Users } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Rating } from "../kit";
import { styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import { FormFill } from "../sops/fill";
import type { FillForm } from "../sops/types";
import type { Work } from "./work";
import { dayText, str, strList, timeText, todayIso } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";

type Submission = { id: string; form: string; at: string | null; by: string | null; location: { lat: number; lng: number; accuracy?: number | null } | null };

export function CollectScreen({ w, form }: { w: Work; form: FillForm | null }) {
  const { d } = w, s = d.step, mod = s.module;
  const [subs, setSubs] = useState<Submission[] | null>(null), [err, setErr] = useState<string | null>(null), [filling, setFilling] = useState(true);
  const [scores, setScores] = useState<Record<string, number | null>>({}), [note, setNote] = useState("");
  const open = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped" && s.state !== "done";
  useEffect(() => {
    if (mod === "score" || !open) return; let on = true;
    flow<{ submissions: Submission[] }>(`steps/${s.id}/actions/candidates`, "POST", {}).then((r) => { if (on) setSubs(r.submissions); }).catch((e) => { if (on) setErr(why(e)); });
    return () => { on = false; };
  }, [mod, open, s.id]);
  const made = d.values.find((v) => v.side === "makes")?.value as Record<string, unknown> | undefined;
  if (mod === "score") {
    const scales = strList(d.settings.scales).length ? strList(d.settings.scales) : ["Overall"];
    return <div className={m.stack}><section className={m.card} aria-label="Score">
      <h3>Score</h3>
      <div className={m.grid2}>{scales.map((x) => <div key={x} className={m.lab}>{x}<Rating value={scores[x] ?? null} onChange={open ? (v) => setScores({ ...scores, [x]: v }) : undefined} readOnly={!open} label={x} /></div>)}</div>
      <label className={m.lab}>Note<input value={note} disabled={!open} onChange={(e) => setNote(e.target.value)} /></label>
      {open ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || scales.some((x) => !scores[x])}
        onClick={() => void w.act(`steps/${s.id}/actions/score`, { info: scores[scales[0]], behaviour: scores[scales[1] ?? scales[0]], note: note || undefined }, "Scored")}><Check size={14} aria-hidden="true" />Save the score</button></div> : null}
    </section></div>;
  }
  return <div className={m.stack}>
    {form && open && filling ? <section className={m.card} aria-label={form.name}>
      <h3><ClipboardList size={15} aria-hidden="true" />{form.name}<small>{mod === "site_visit" ? "photos from the camera only, with the time and the place" : "fill it here or on the phone"}</small></h3>
      <FormFill form={form} projectId={d.run.projectId ?? null} flowStepId={s.id} />
      <button type="button" className={css.linkBtn} onClick={() => setFilling(false)}>It was already sent from a phone: choose it below</button>
    </section> : null}
    {!form && open ? <PickForm stepId={s.id} module={mod} projectId={d.run.projectId ?? null} formId={str(d.settings.formId) || null} /> : null}
    {open ? <section className={m.card} aria-label="Forms sent">
      <h3>Forms sent{d.run.projectId ? " for this project" : ""}<small>{subs ? subs.length : ""}</small></h3>
      {err ? <p className={css.quiet}>{err}</p> : !subs ? <p className={css.quiet}>Looking…</p> : !subs.length ? <p className={css.quiet}>None sent yet. When it is sent, choose it here and the step is done.</p>
        : <ul className={m.submissions}>{subs.map((x) => <li key={x.id}><span><b>{x.form}</b><small>{x.by ?? "Someone"} · {timeText(x.at)}{x.location ? <> · <MapPin size={11} aria-hidden="true" /> {Number(x.location.lat).toFixed(5)}, {Number(x.location.lng).toFixed(5)}</> : ""}</small></span>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/pick`, { submissionId: x.id }, mod === "site_visit" ? "Visit used: its photos go on" : "Answers used: the step is done")}>Use this</button></li>)}</ul>}
    </section> : null}
    {made ? <section className={m.card} aria-label="What came in"><h3><Check size={15} aria-hidden="true" />What came in</h3>
      <p className={css.quiet}>{str(made.form) || "A form"}{made.location ? " · with its place" : ""}{made.href ? <> · <Link href={str(made.href)}>Open the form</Link></> : null}</p></section> : null}
    {!open && !made ? <p className={css.quiet}>{s.state === "waiting" ? s.stateText : "Its person fills it."}</p> : null}
  </div>;
}

export function IntakeScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const [on, setOn] = useState<Record<string, string>>({});
  const items = d.intake;
  const open = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped";
  const role = (k: string | null) => (k ? d.run.roles.find((r) => r.key === k)?.label ?? k : null);
  const crit = items.filter((i) => i.critical), inCrit = crit.filter((i) => i.receivedOn).length;
  return <div className={m.stack}><section className={m.card} aria-label="What must come in">
    <h3><ClipboardList size={15} aria-hidden="true" />What must come in<small>{inCrit} of {crit.length} critical in{d.run.day1 ? ` · Day 1 was ${dayText(d.run.day1)}` : " · the clock starts when they are"}</small></h3>
    <ul className={m.intake}>{items.map((i) => <li key={i.key} data-in={i.receivedOn ? "" : undefined}>{i.receivedOn ? <Check size={15} aria-hidden="true" /> : <CircleDashed size={15} aria-hidden="true" />}
      <span><b>{i.label}{i.critical ? " ·  critical" : ""}</b><small>{i.receivedOn ? `In ${dayText(i.receivedOn)}` : role(i.owner) ? `From the ${role(i.owner)}` : "Not in yet"}{i.note ? ` · ${i.note}` : ""}</small></span>
      {open ? i.receivedOn ? <button type="button" className={css.linkBtn} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/receive`, { item: i.key, on: null }, `${i.label}: not in`)}>Not in after all</button>
        : <form className={m.row} onSubmit={(e) => { e.preventDefault(); void w.act(`steps/${s.id}/actions/receive`, { item: i.key, on: on[i.key] || todayIso() }, `${i.label}: in`); }}>
          <input type="date" max={todayIso()} value={on[i.key] ?? todayIso()} onChange={(e) => setOn({ ...on, [i.key]: e.target.value })} aria-label={`${i.label} came in on`} />
          <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={w.busy}>It came in</button></form> : null}
    </li>)}</ul>
    {!items.length ? <p className={css.quiet}>No items are listed for this run.</p> : null}
  </section></div>;
}

type Doc = { id: string; type: string; number: string | null; status: string; total: number | string | null; issueDate: string | null; buyer: string | null };
export function MoneyScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, quote = s.module === "quotation";
  const [docs, setDocs] = useState<Doc[] | null>(null), [err, setErr] = useState<string | null>(null);
  const open = d.canAct && d.run.status === "running" && s.state !== "waiting" && s.state !== "skipped" && s.state !== "done";
  useEffect(() => { if (!open) return; let on = true;
    flow<{ documents: Doc[] }>(`steps/${s.id}/actions/candidates`, "POST", {}).then((r) => { if (on) setDocs(r.documents); }).catch((e) => { if (on) setErr(why(e)); });
    return () => { on = false; }; }, [open, s.id]);
  const made = d.values.find((v) => v.side === "makes")?.value as Record<string, unknown> | undefined;
  return <div className={m.stack}>
    <section className={m.card} aria-label={quote ? "The quotation" : "The invoice"}>
      <h3><Receipt size={15} aria-hidden="true" />{quote ? "The quotation" : "The invoice"}<small>made in Billing, chosen here</small></h3>
      {open ? <div className={m.row}><Link className={`${styles.btn} ${styles.btnPrimary}`} href={d.module.link ?? (quote ? "/erp/new?type=quotation" : "/erp/new?type=invoice")}><ExternalLink size={14} aria-hidden="true" />Make it in Billing</Link>
        <small className={css.quiet}>Then come back and choose it below.</small></div> : null}
      {made ? <p className={css.done}><Check size={14} aria-hidden="true" />{str(made.type)} {str(made.number)} · {str(made.buyer)} · {str(made.total)}{made.href ? <> · <Link href={str(made.href)}>Open it</Link></> : null}</p> : null}
    </section>
    {open ? <section className={m.card} aria-label="Recent documents"><h3>{quote ? "Quotations" : "Invoices"} for this client<small>{docs ? docs.length : ""}</small></h3>
      {err ? <p className={css.quiet}>{err}</p> : !docs ? <p className={css.quiet}>Looking…</p> : !docs.length ? <p className={css.quiet}>None yet.</p>
        : <ul className={m.submissions}>{docs.map((x) => <li key={x.id}><span><b>{x.number ?? "Draft"} · {x.buyer ?? "No buyer"}</b><small>{x.status} · {x.total ?? "—"}{x.issueDate ? ` · ${dayText(x.issueDate)}` : ""}</small></span>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/pick`, { documentId: x.id }, "Chosen: the step is done")}>Use this</button></li>)}</ul>}</section> : null}
  </div>;
}

export function SlotScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const made = d.values.find((v) => v.side === "makes" && v.kind === "slot")?.value as Record<string, unknown> | undefined;
  const [slot, setSlot] = useState({ on: str(made?.on), time: str(made?.time), place: str(made?.place), people: strList(made?.people).join(", ") || strList(d.settings.people).map((r) => { const p = d.run.people[r]; return p && "name" in p ? p.name : r; }).join(", ") });
  return <div className={m.stack}><section className={m.card} aria-label="The time">
    <h3>The time{made ? <span className={css.chip} data-tone="good">Fixed</span> : null}</h3>
    <div className={m.grid3}>
      <label className={m.lab}>Date<input type="date" value={slot.on} disabled={!w.live} onChange={(e) => setSlot({ ...slot, on: e.target.value })} /></label>
      <label className={m.lab}>Time<input type="time" value={slot.time} disabled={!w.live} onChange={(e) => setSlot({ ...slot, time: e.target.value })} /></label>
      <label className={m.lab}>Place or call link<input value={slot.place} disabled={!w.live} onChange={(e) => setSlot({ ...slot, place: e.target.value })} placeholder="https://meet.google.com/… or the office" /></label>
    </div>
    <label className={m.lab}>Who attends<input value={slot.people} disabled={!w.live} onChange={(e) => setSlot({ ...slot, people: e.target.value })} placeholder="Names, separated by commas" /></label>
    {w.live ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !slot.on} onClick={() => void w.act(`steps/${s.id}/actions/slot`, { on: slot.on, time: slot.time || undefined, place: slot.place || undefined, people: slot.people.split(",").map((x) => x.trim()).filter(Boolean) }, `Fixed for ${dayText(slot.on)}`)}>
      <Check size={14} aria-hidden="true" />Fix it</button><small className={css.quiet}>Pulse puts it on the run; it sends no calendar invite.</small></div> : null}
  </section></div>;
}

export function MessageScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const [text, setText] = useState(str(d.text) || str(d.settings.text)), [note, setNote] = useState("");
  const channel = str(d.settings.channel), to = str(d.settings.to);
  // FLOW-E: Gmail and WhatsApp as App actions: open the filled-in text in the app; Pulse sends an e-mail itself only from
  // the person's own Gmail where the company switched sending on.
  const [canSend, setCanSend] = useState(false), [mailTo, setMailTo] = useState(to);
  useEffect(() => { if (!w.live || channel !== "email") return; let on = true;
    flow<{ canSend?: boolean }>(`steps/${s.id}/actions/text`, "POST", {}).then((r) => { if (on) setCanSend(!!r.canSend); }).catch(() => null); return () => { on = false; }; }, [w.live, channel, s.id]);
  const phone = to.replace(/[^\d]/g, "");
  const href = channel === "whatsapp" ? `https://wa.me/${phone.length >= 8 ? phone : ""}?text=${encodeURIComponent(text)}`
    : channel === "email" ? `mailto:${/@/.test(mailTo) ? mailTo : ""}?subject=${encodeURIComponent(`${s.title} · ${d.run.name}`)}&body=${encodeURIComponent(text)}` : null;
  async function copy() { try { await navigator.clipboard.writeText(text); notify({ id: "copy", tone: "success", title: "Copied", message: channel === "email" ? "Paste it in the e-mail." : "Paste it in WhatsApp.", timeout: 2500 }); } catch { notify({ id: "copy", tone: "error", title: "Not copied", message: "Select the text and copy it." }); } }
  return <div className={m.stack}><section className={m.card} aria-label="The message">
    <h3><Send size={15} aria-hidden="true" />The message<small>{channel === "email" ? "an e-mail" : channel === "whatsapp" ? "a WhatsApp" : "to send"}{to ? ` to ${to}` : ""}</small></h3>
    <textarea className={m.message} rows={7} value={text} disabled={!w.live} onChange={(e) => setText(e.target.value)} aria-label="The message" />
    {channel === "email" && w.live ? <label className={m.lab}>To<input value={mailTo} onChange={(e) => setMailTo(e.target.value)} placeholder="name@example.com" /></label> : null}
    <div className={m.row}>{href ? <a className={styles.btn} href={href} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true" />{channel === "whatsapp" ? "Open in WhatsApp" : "Open in your mail app"}</a> : null}
      {canSend && w.live ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !/@/.test(mailTo)} onClick={() => void w.act(`steps/${s.id}/actions/send`, { to: mailTo }, "Sent from your Gmail: the step is done")}><Send size={14} aria-hidden="true" />Send from Pulse</button> : null}
      <button type="button" className={styles.btn} onClick={() => void copy()}><ClipboardCopy size={14} aria-hidden="true" />Copy it</button><small className={css.quiet}>{canSend ? "Send it from Pulse, or open it in your mail app and say it went." : "Pulse does not send it here: open it or copy it, send it, then say it went."}</small></div>
    {w.live ? <div className={m.row}><input className={m.grow} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (to whom, when)" aria-label="Note" />
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/sent`, { note: note || undefined }, "Sent: the step is done")}><Check size={14} aria-hidden="true" />It went</button></div> : null}
  </section></div>;
}

export function AssignScreen({ w, holders }: { w: Work; holders: Record<string, { id: string; name: string }[]> }) {
  const { d } = w, s = d.step;
  const roles = strList(d.settings.roles).length ? d.run.roles.filter((r) => strList(d.settings.roles).includes(r.key)) : d.run.roles;
  return <div className={m.stack}><section className={m.card} aria-label="Who does each role">
    <h3><Users size={15} aria-hidden="true" />Who does each role<small>naming someone gives them that role&apos;s steps on this run</small></h3>
    <ul className={m.submissions}>{roles.map((r) => { const p = d.run.people[r.key], name = p && "name" in p ? p.name : null;
      return <li key={r.key}><span><b>{r.label}</b><small>{name ?? "Nobody named"}{r.note ? ` · ${r.note}` : ""}</small></span>
        {w.live && (holders[r.key] ?? []).length ? <select aria-label={`Who is the ${r.label}`} value={p && "id" in p ? p.id : ""} disabled={w.busy} onChange={(e) => { if (e.target.value) void w.act(`steps/${s.id}/actions/name`, { role: r.key, personId: e.target.value }, `${r.label} named`); }}>
          <option value="">Choose someone</option>{(holders[r.key] ?? []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select> : null}</li>; })}</ul>
    {w.live ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/finish`, {}, "Done: everyone named has their steps")}><Check size={14} aria-hidden="true" />Done</button></div> : null}
  </section></div>;
}

/** Wait: for a time or a date it goes on by itself; until something arrives, whoever sees it come marks it, with what came. */
export function WaitScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step;
  const [note, setNote] = useState(""), [url, setUrl] = useState("");
  const byInput = str(d.settings.until) === "input";
  return <div className={m.stack}><section className={m.card} aria-label="Waiting">
    <h3><CircleDashed size={15} aria-hidden="true" />{byInput ? "Waiting until it arrives" : "The run waits here"}</h3>
    {byInput ? w.live ? <>
      <label className={m.lab}>What came<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The signed agreement, by courier" /></label>
      <label className={m.lab}>Link (if any)<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>
      <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/arrived`, { note: note || undefined, url: /^https:\/\//.test(url) ? url : undefined }, "Arrived: the run goes on")}><Check size={14} aria-hidden="true" />It arrived</button></div>
    </> : <p className={css.quiet}>{s.state === "done" ? "It arrived." : "Its person marks it when it arrives."}</p>
      : <p className={css.quiet}>{s.state === "done" ? "The wait is over; the run went on." : d.settings.until === "field" ? "Until the run's date comes; then it goes on by itself." : `For ${str(d.settings.hours) || "a while"} hours; then it goes on by itself.`}</p>}
  </section></div>;
}

type FormsList = { canEdit: boolean; forms: { id: string; name: string; status: string; photos: number }[]; templates: { key: string; name: string; summary?: string }[] };
/** A Collect step without its form: fill one of the company's live forms here, or (leadership) add a ready-made one. */
function PickForm({ stepId, module, projectId, formId }: { stepId: string; module: string; projectId: string | null; formId: string | null }) {
  const [list, setList] = useState<FormsList | null>(null), [form, setForm] = useState<FillForm | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true;
    fetch("/api/v0/forms").then((r) => (r.ok ? r.json() : Promise.reject(new Error("The forms did not load.")))).then((x: FormsList) => { if (on) setList(x); }).catch((e: Error) => { if (on) setErr(e.message); });
    return () => { on = false; }; }, []);
  async function load(id: string) {
    setBusy(true);
    try { const r = await fetch(`/api/v0/forms/${encodeURIComponent(id)}/blank`); if (!r.ok) throw new Error("That form did not open."); setForm(((await r.json()) as { form: FillForm }).form); }
    catch (e) { setErr(why(e)); } finally { setBusy(false); }
  }
  async function install(key: string) {
    setBusy(true);
    try { const r = await fetch(`/api/v0/forms/templates/${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const x = await r.json().catch(() => ({})) as { formIds?: string[]; error?: string }; if (!r.ok || !x.formIds?.length) throw new Error(x.error ?? "The form was not added.");
      notify({ id: "form", tone: "success", title: "Form added", message: "It is in Processes → More → Forms too.", timeout: 3000 }); await load(x.formIds[0]); }
    catch (e) { setErr(why(e)); setBusy(false); }
  }
  if (form) return <section className={m.card} aria-label={form.name}>
    <h3><ClipboardList size={15} aria-hidden="true" />{form.name}<small>{module === "site_visit" ? "photos from the camera only, with the time and the place" : "fill it here or on the phone"}</small></h3>
    <FormFill form={form} projectId={projectId} flowStepId={stepId} />
    <button type="button" className={css.linkBtn} onClick={() => setForm(null)}>Choose another form</button>
  </section>;
  const live = (list?.forms ?? []).filter((f) => f.status === "live").sort((a, b) => (module === "site_visit" ? b.photos - a.photos : 0));
  const templates = (list?.templates ?? []).sort((a, b) => (module === "site_visit" ? Number(b.key === "site_visit") - Number(a.key === "site_visit") : 0));
  return <section className={m.card} aria-label="The form">
    <h3><ClipboardList size={15} aria-hidden="true" />The form<small>{formId ? "the step's form could not be opened" : "no form is chosen for this step yet"}</small></h3>
    {err ? <p className={css.quiet}>{err}</p> : !list ? <p className={css.quiet}>Looking for the company&apos;s forms…</p> : <>
      {live.length ? <div className={m.row}><select aria-label="A form to fill" defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void load(e.target.value); }}>
        <option value="">Fill one of the company&apos;s forms…</option>{live.map((f) => <option key={f.id} value={f.id}>{f.name}{f.photos ? ` · ${f.photos} photo${f.photos > 1 ? "s" : ""}` : ""}</option>)}</select></div> : null}
      {list.canEdit && templates.length ? <><p className={css.quiet}>{live.length ? "Or add a ready-made form:" : "The company has no forms yet. Add a ready-made one and fill it here:"}</p>
        <div className={m.row}>{templates.map((t) => <button key={t.key} type="button" className={styles.btn} disabled={busy} onClick={() => void install(t.key)}>Add “{t.name}”</button>)}</div></> : null}
      {!live.length && !list.canEdit ? <p className={css.quiet}>The company has no forms yet: leadership adds one in Processes → More → Forms.</p> : null}
      <p className={css.quiet}>Leadership can make it the step&apos;s own form in the process&apos;s builder, so the next run opens it here by itself.</p>
    </>}
  </section>;
}
