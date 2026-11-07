"use client";
// FLOW-C: the Review screens (Review). Share for review: what is shared, the message to post (with the run's people
// tagged, copied for WhatsApp; Pulse sends nothing), Sent (a round), the client's written changes, and Confirmed with
// its date, every round on a timeline. Approve / Decide: what is decided on and the answers. Check: Pip pre-checks the
// drafts against the Word Library, the facts and the constraints; the person passes it or asks for changes.
import Link from "next/link";
import { useState } from "react";
import { Check, ClipboardCopy, CornerUpLeft, FileText, ListChecks, Send, Stamp } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../ui";
import type { Work } from "./work";
import { dayText, handed, needValues, settingFor, str, strList, todayIso } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";

type Change = { text: string; round: number; on: string };

/** The drafts a step was handed, each linking to the step that made it. */
export function Handed({ w, title = "What is shared" }: { w: Work; title?: string }) {
  const items = handed(w.d);
  const seen = new Set<string>();
  const list = items.filter((x) => { const k = `${x.recordId}:${x.section ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!list.length) return null;
  return <section className={m.card} aria-label={title}>
    <h3><FileText size={15} aria-hidden="true" />{title}<small>{list.length}</small></h3>
    <ul className={m.handed}>{list.map((x) => { const r = w.runRecords.find((y) => y.id === x.recordId);
      return <li key={`${x.recordId}:${x.section ?? ""}`}><Link href={`/runs/${w.d.run.id}?step=${encodeURIComponent(r?.stepKey ?? "")}`}>
        <b>{x.section ?? r?.code ?? r?.title ?? "A draft"}</b><small>{x.section ? r?.title : r ? `${r.statusLabel}${r.stepKey ? ` · step ${r.stepKey}` : ""}` : x.recordType}</small></Link></li>; })}</ul>
  </section>;
}

/** What reached a step that is not a record: a quote or an invoice, a form's answers, a slot, a verdict, a note. */
export function Reached({ w }: { w: Work }) {
  const items = needValues(w.d).filter((x) => x.value && typeof x.value === "object" && typeof x.value.recordId !== "string" && Object.keys(x.value).length);
  if (!items.length) return null;
  const label = (port: string) => w.d.step.needs.find((n) => n.key === port)?.label ?? port;
  const words = (v: Record<string, unknown>) => [v.type && v.number ? `${str(v.type)} ${str(v.number)}` : "", str(v.buyer), v.total !== undefined && v.total !== null ? str(v.total) : "", str(v.form),
    v.on ? dayText(str(v.on)) : "", str(v.answer), str(v.text), str(v.note)].filter(Boolean).join(" · ");
  return <section className={m.card} aria-label="What reached this step">
    <h3><FileText size={15} aria-hidden="true" />What reached this step</h3>
    <ul className={m.handed}>{items.map((x, i) => <li key={i}>{typeof x.value.href === "string" && /^\//.test(x.value.href) ? <Link href={x.value.href}><b>{label(x.port)}</b><small>{words(x.value) || "Open it"}</small></Link>
      : <span className={m.handedItem}><b>{label(x.port)}</b><small>{words(x.value) || "In"}</small></span>}</li>)}</ul>
  </section>;
}

export function ShareScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null;
  const data = (rec?.data ?? {}) as Record<string, unknown>;
  const tagged = strList(d.settings.tag).map((role) => { const p = d.run.people[role]; return p && "name" in p ? p.name : d.run.roles.find((r) => r.key === role)?.label ?? role; });
  const drafts = handed(d).map((x) => x.section ?? w.runRecords.find((y) => y.id === x.recordId)?.code ?? w.runRecords.find((y) => y.id === x.recordId)?.title).filter(Boolean) as string[];
  const client = str(d.run.fieldsText.find((f) => /client/i.test(f.label))?.text) || d.run.name.replace(/^Demo · /, "");
  const unique = [...new Set(drafts)];
  const draftMessage = () => [`Hi ${client.split(",")[0]}, ${unique.length ? `the ${unique.join(", ")}` : "the drafts"} for ${d.run.name.replace(/^Demo · /, "")} ${unique.length === 1 ? "is" : "are"} ready for your review.`,
    ...strList(data.items).map((l) => `• ${l}`), "", "Please write your changes here, or reply “Confirmed”.", tagged.length ? tagged.map((t) => `@${t.split(" ")[0]}`).join(" ") : ""].filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n").trim();
  const [message, setMessage] = useState(str(data.message) || draftMessage());
  const [links, setLinks] = useState(strList(data.items).join("\n"));
  const [changes, setChanges] = useState("");
  const [note, setNote] = useState("");
  const rounds = Number(data.rounds ?? 0), all = (Array.isArray(data.changes) ? data.changes : []) as Change[];
  const finishWhen = settingFor(d, "finishWhen") || "confirmed";
  const sla = Number(d.settings.slaDays) || null;
  if (!rec) return <div className={css.emptyWork}><Send size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The review opens when the drafts are in" : "Nothing shared yet"}</b><span>{s.state === "waiting" ? s.stateText : "Its person shares it."}</span></div>;
  async function copy() {
    try { await navigator.clipboard.writeText(message); notify({ id: "copy", tone: "success", title: "Copied", message: "Paste it in the client's WhatsApp group.", timeout: 2500 }); }
    catch { notify({ id: "copy", tone: "error", title: "Not copied", message: "Select the text and copy it." }); }
  }
  const sentOn = str(data.sent_on), confirmedOn = str(data.confirmed_on);
  return <div className={m.stack}>
    <Handed w={w} />
    <section className={m.card} aria-label="The message to post">
      <h3><Send size={15} aria-hidden="true" />The message to post<small>{str(d.settings.channel) || "the client's WhatsApp group"}</small></h3>
      {tagged.length ? <p className={m.tagged}>Tags {tagged.map((t) => <span key={t} className={m.person}>{t}</span>)}</p> : null}
      <textarea className={m.message} rows={8} value={message} disabled={!w.live} onChange={(e) => setMessage(e.target.value)} aria-label="The message" maxLength={4000} />
      <label className={m.lab}>Links to the drafts (one per line)<textarea rows={2} value={links} disabled={!w.live} onChange={(e) => setLinks(e.target.value)} placeholder="https://drive.google.com/…" /></label>
      <div className={m.row}>
        <button type="button" className={styles.btn} onClick={() => void copy()}><ClipboardCopy size={14} aria-hidden="true" />Copy for WhatsApp</button>
        {w.live && !confirmedOn ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || !message.trim()}
          onClick={() => void w.act(`steps/${s.id}/actions/send`, { message, links: links.split("\n").map((x) => x.trim()).filter(Boolean) }, finishWhen === "sent" ? "Sent: the step is done" : `Round ${rounds + 1} sent`)}>
          <Send size={14} aria-hidden="true" />{rounds ? `I posted round ${rounds + 1}` : "I posted it"}</button> : null}
        <small className={css.quiet}>Pulse does not post it: copy it, post it, then press {rounds ? `“I posted round ${rounds + 1}”` : "“I posted it”"}.</small>
      </div>
    </section>

    {rounds && !confirmedOn && !["done", "skipped"].includes(s.state) ? <section className={m.card} aria-label="The answer">
      <h3><Stamp size={15} aria-hidden="true" />The answer<small>{sentOn ? `waiting since ${dayText(sentOn)}${sla ? ` · answer within ${sla} working day${sla > 1 ? "s" : ""}` : ""}` : ""}</small></h3>
      {w.live ? <>
        <label className={m.lab}>Their written changes (one per line)<textarea rows={4} value={changes} onChange={(e) => setChanges(e.target.value)} placeholder="Paste what the client wrote" /></label>
        <div className={m.row}>
          <button type="button" className={styles.btn} disabled={w.busy || !changes.trim()} onClick={async () => { if (await w.act(`steps/${s.id}/actions/changes`, { changes: changes.split("\n").map((x) => x.trim()).filter(Boolean) }, "Changes recorded: make them, then post the next round")) setChanges(""); }}>
            <CornerUpLeft size={14} aria-hidden="true" />They asked for changes</button>
          <input className={m.grow} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (who confirmed, where)" aria-label="Note" />
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/confirm`, { note: note || undefined }, `Confirmed on ${dayText(todayIso())}`)}><Check size={14} aria-hidden="true" />They confirmed</button>
        </div>
      </> : <p className={css.quiet}>Waiting for the answer.</p>}
    </section> : null}

    <section className={m.card} aria-label="Rounds">
      <h3>Rounds<small>{rounds ? `${rounds} sent${all.length ? ` · ${all.length} change${all.length > 1 ? "s" : ""} asked` : ""}` : "not sent yet"}</small></h3>
      <ol className={m.timeline}>
        {Array.from({ length: rounds }, (_x, i) => i + 1).map((n) => <li key={n} data-on="">
          <b>Round {n} posted</b>{n === rounds && sentOn ? <small>{dayText(sentOn)}</small> : null}
          {all.filter((c) => Number(c.round) === n).length ? <ul>{all.filter((c) => Number(c.round) === n).map((c, i) => <li key={i}>{c.text}<small> · {dayText(c.on)}</small></li>)}</ul> : null}
        </li>)}
        <li data-on={confirmedOn ? "" : undefined} data-final=""><b>{confirmedOn ? `Confirmed ${dayText(confirmedOn)}` : "Confirmed"}</b><small>{confirmedOn ? rounds === 1 ? "first time" : `after ${rounds} rounds` : "not yet"}</small></li>
      </ol>
    </section>
    {d.step.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done{confirmedOn ? `: confirmed ${dayText(confirmedOn)}` : ""}. The steps that waited on it have opened.</p> : null}
  </div>;
}

/** Approve or decide: what is decided on, then the answers. A decision's way not chosen is skipped. */
export function VerdictScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, mod = s.module;
  const [note, setNote] = useState("");
  const answers: { answer: string; label: string; primary?: boolean; back?: boolean }[] = mod === "decision" ? d.module.makes.map((p, i) => ({ answer: p.label, label: p.label, primary: i === 0 }))
    : mod === "follow_up" ? [{ answer: "accepted", label: "They said yes", primary: true }, { answer: "declined", label: "They said no" }, { answer: "not yet", label: "No answer yet", back: true }]
    : [{ answer: "approved", label: "Approve", primary: true }, { answer: "changes", label: "Send back with changes", back: true }];
  const last = [...d.values].reverse().find((v) => v.side === "makes" && v.kind === "verdict")?.value as Record<string, unknown> | undefined;
  return <div className={m.stack}>
    <Handed w={w} title={mod === "decision" ? "What it is decided on" : "What is approved"} />
    <Reached w={w} />
    <section className={m.card} aria-label="The answer">
      <h3><Stamp size={15} aria-hidden="true" />{mod === "decision" ? "Which way does it go?" : mod === "follow_up" ? "Their answer" : "Your answer"}{s.rounds > 1 ? <small>round {s.rounds}</small> : null}</h3>
      {mod === "decision" ? <p className={css.quiet}>The steps on the way not chosen are skipped for this run.</p> : null}
      {w.live ? <>
        <label className={m.lab}>Note{mod === "approval" ? " (what to change, when sending back)" : ""}<textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className={m.row}>{answers.map((a) => <button key={a.answer} type="button" className={`${styles.btn} ${a.primary ? styles.btnPrimary : ""}`} disabled={w.busy || (a.back && mod === "approval" && !note.trim())}
          onClick={() => void w.act(`steps/${s.id}/verdict`, { answer: a.answer, note: note || undefined }, a.back ? "Sent back: it is in progress again" : `${a.label}: recorded`)}>{a.back ? <CornerUpLeft size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{a.label}</button>)}</div>
      </> : last ? <p className={css.done}><Check size={14} aria-hidden="true" />{str(last.answer)}{last.note ? `: ${str(last.note)}` : ""}</p> : <p className={css.quiet}>Not answered yet.</p>}
    </section>
  </div>;
}

/** A quality test or a words, claims and constraints check on the drafts it was handed. */
export function CheckScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null;
  type Finding = { level: string; rule: string; text: string; where?: string; suggestion?: string; basis?: string };
  const findings = (Array.isArray(rec?.data.findings) ? rec!.data.findings : []) as Finding[];
  const [note, setNote] = useState("");
  const fix = findings.filter((f) => f.level === "fix").length, look = findings.filter((f) => f.level === "check").length;
  return <div className={m.stack}>
    <Handed w={w} title="The drafts it checks" />
    <section className={m.card} aria-label="Pip's pre-check">
      <h3><ListChecks size={15} aria-hidden="true" />Pip&apos;s pre-check<small>{rec?.data.findings ? `${fix} to fix · ${look} to look at` : "not run yet"}</small></h3>
      <p className={css.quiet}>Against the Word Library, the facts and their status, the known constraints, offers past their date and numbers that differ between drafts. Pip suggests; you decide.</p>
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/run`, {}, "Pre-checked")}>{rec?.data.findings ? "Check again" : "Pre-check with Pip"}</button></div> : null}
      {findings.length ? <ul className={css.findings}>{findings.map((f, i) => <li key={i} data-level={f.level}><b>{f.text}</b>{f.suggestion ? <span>{f.suggestion}</span> : null}<small>{f.rule}{f.where ? ` · ${f.where}` : ""}</small></li>)}</ul>
        : rec?.data.findings ? <p className={css.ok}>Nothing to fix.</p> : null}
    </section>
    {w.live ? <section className={m.card} aria-label="Your decision">
      <h3><Stamp size={15} aria-hidden="true" />Your decision</h3>
      <label className={m.lab}>Note<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What has to change, or why it passes" /></label>
      <div className={m.row}>
        <button type="button" className={styles.btn} disabled={w.busy || !note.trim()} onClick={() => void w.act(`steps/${s.id}/verdict`, { answer: "changes", note }, "Changes asked: it is in progress again")}><CornerUpLeft size={14} aria-hidden="true" />Changes needed</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/verdict`, { answer: "passed", note: note || undefined }, "Passed: the steps after it open")}><Check size={14} aria-hidden="true" />It passes</button>
      </div>
    </section> : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Checked and passed.</p> : null}
  </div>;
}
