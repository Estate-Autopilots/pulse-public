"use client";
// FLOW-D "Try it" (owner, 21 Oct 2026: "nothing is tested end to end"): the draft runs as a test project with sample
// data. Pulse puts you in each person's place in turn ("You are the Site surveyor now"), with the step's own buttons
// filled with samples; on the right, who would have heard what, the alerts and the due dates; "A day passes" moves the
// clock so late steps and alerts show; "Throw the test away" removes it and everything it made.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, CalendarClock, CircleCheck, ExternalLink, FastForward, Hourglass, Sparkles, Trash2, UserRound } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { RunDetail, RunStep } from "../flow-types";
import { ModuleIcon } from "../builder/kinds";
import css from "./try.module.css";

const OPEN = new Set(["open", "in_progress", "in_review", "confirmed"]);
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const TRANSCRIPT = "Client: We want the work to start next week. The budget is ₹ 4.5 lakh.\nUs: Who approves the final design?\nClient: My partner, Meera. FOLLOW-UP: send the price sheet by Friday.\nPENDING: the site access letter.";
const TEXT = "A sample written by Try it: the main points, who it is for, and what happens next.";

type Act = { label: string; tone?: "primary" | "quiet"; run: () => Promise<unknown> };

/** The buttons a step's person would press, with sample data, by what the step does (its module). */
export function actsFor(s: RunStep, run: RunDetail): Act[] {
  const go = (path: string, body: unknown = {}) => flow(`steps/${s.id}/${path}`, "POST", body);
  const finish = (outputs: Record<string, unknown> = {}) => go("finish", { outputs });
  const first = s.makes[0]?.key ?? "done";
  const done: Act = { label: "Mark it done", tone: "quiet", run: () => finish() };
  switch (s.module) {
    case "decision": return s.makes.map((p) => ({ label: p.label, tone: "primary" as const, run: () => go("verdict", { answer: p.key }) }));
    case "approval": return [{ label: "Approve", tone: "primary", run: () => go("verdict", { answer: "approved" }) }, { label: "Send back with changes", run: () => go("verdict", { answer: "changes", note: "Try it: change the second paragraph" }) }];
    case "follow_up": return [{ label: "They said yes", tone: "primary", run: () => go("verdict", { answer: "yes" }) }, { label: "Closed: they said no", run: () => go("verdict", { answer: "no" }) }];
    case "share_review": return s.state === "in_review"
      ? [{ label: "They confirmed", tone: "primary", run: () => go("actions/confirm", {}) }, { label: "They asked for changes", run: () => go("actions/changes", { changes: ["Try it: a shorter headline"] }) }]
      : [{ label: "Send it to them", tone: "primary", run: () => go("actions/send", { message: "Here are the drafts for your review (Try it).", links: [] }) }];
    case "check": return [{ label: "Pre-check with Pip", run: () => go("actions/run", {}) }, { label: "It passes", tone: "primary", run: () => go("verdict", { answer: "passed" }) }];
    case "meeting": case "transcribe": return [{ label: "Paste a sample transcript", run: () => go("actions/transcript", { transcript: TRANSCRIPT }) },
      { label: "Summarise with Pip", run: () => go("actions/summarise", {}) }, { label: "Done", tone: "primary", run: () => finish() }];
    case "sales_xray": return [{ label: "Use a sample call", tone: "primary", run: () => go("actions/pick", { callId: "try", summary: "Wants a 5 kW rooftop system; asked about the subsidy.", items: ["5 kW panels", "Net meter"], objections: ["Price"], promises: ["Quote by Friday"], score: 7 }) }];
    case "quotation": return [{ label: "Use a sample quotation", tone: "primary", run: () => finish({ quote: { sample: true, number: "TRY-Q-1", total: 250000 } }) }];
    case "tax_invoice": return [{ label: "Use a sample invoice", tone: "primary", run: () => finish({ invoice: { sample: true, number: "TRY-INV-1", total: 250000 } }) }];
    case "data_capture": case "site_visit": return [{ label: s.module === "site_visit" ? "Use sample photos (with a place and time)" : "Use sample answers", tone: "primary",
      run: () => finish({ [first]: { sample: true, answers: { note: "Sample answer" }, location: { lat: 18.5204, lng: 73.8567, accuracy: 10 }, at: new Date().toISOString() } }) }];
    case "intake": return [{ label: "Mark everything received", tone: "primary", run: async () => { for (const i of run.intake.filter((x) => x.step === s.key && !x.receivedOn)) await go("actions/receive", { item: i.key, on: day(0) }); } }];
    case "schedule": return [{ label: "Fix it for tomorrow, 11:00", tone: "primary", run: () => go("actions/slot", { on: day(1), time: "11:00", place: "Online" }) }];
    case "doc_section": return [{ label: "Write a sample section", tone: "primary", run: () => go("actions/section", { text: TEXT, final: true }) }];
    case "doc": case "pip_draft": return [{ label: "Write a sample and mark it final", tone: "primary", run: async () => { await go("actions/section", { section: "Main", text: TEXT }); await go("actions/final", {}); } }];
    case "message": return [{ label: "It went", tone: "primary", run: () => go("actions/sent", { note: "Try it" }) }];
    case "wait": return [{ label: "Skip the wait (it is a test)", tone: "primary", run: () => finish() }];
    case "session": return [{ label: "Record a sample session", tone: "primary", run: async () => { await go("actions/note", { notes: "Try it: looked at two drafts.", decisions: ["Go ahead"], requests: [] }); await finish(); } }];
    default: return [{ ...done, tone: "primary" }];
  }
}

export function TryIt({ processId, initial }: { processId: string; initial: RunDetail }) {
  const router = useRouter();
  const [run, setRun] = useState(initial), [pick, setPick] = useState<string | null>(null), [busy, setBusy] = useState(false), [text, setText] = useState<string | null>(null);
  const reload = useCallback(async () => setRun(await flow<RunDetail>(`runs/${run.id}`)), [run.id]);
  const open = useMemo(() => run.steps.filter((s) => OPEN.has(s.state)), [run.steps]);
  const step = run.steps.find((s) => s.id === pick && OPEN.has(s.state)) ?? open[0] ?? null;
  const role = (s: RunStep) => s.role ?? (s.who?.name ? s.who.name : "Whoever started it");
  // A step that waits for something typed in by hand (not for an earlier step): Try it types in a sample, or skips it.
  const asked = run.steps.filter((s) => s.state === "waiting").flatMap((s) => s.waitingFor.filter((w) => !w.from).map((w) => ({ s, w })));
  useEffect(() => {
    let gone = false;
    if (step?.module === "message") flow<{ text: string }>(`steps/${step.id}/actions/text`, "POST", {}).then((r) => { if (!gone) setText(r.text); }).catch(() => {});
    return () => { gone = true; };
  }, [step?.id, step?.module]);
  const act = async (a: { run: () => Promise<unknown>; label: string }) => {
    setBusy(true);
    try { await a.run(); await reload(); }
    catch (e) { notify({ id: "try", tone: "error", title: `${a.label}: not done`, message: why(e) }); }
    finally { setBusy(false); }
  };
  const later = (days: number) => act({ label: "Time", run: async () => setRun(await flow<RunDetail>(`runs/${run.id}/later`, "POST", { days })) });
  const discard = async () => {
    setBusy(true);
    try { await flow(`runs/${run.id}/discard`, "POST", {}); notify({ id: "try", tone: "success", title: "The test is thrown away", timeout: 2500 }); router.push(`/processes/${encodeURIComponent(processId)}`); }
    catch (e) { notify({ id: "try", tone: "error", title: "Not thrown away", message: why(e) }); setBusy(false); }
  };
  const done = run.status === "done", counts = run.counts;
  const due = run.steps.filter((s) => OPEN.has(s.state) && s.due.on).sort((a, z) => (a.due.on ?? "").localeCompare(z.due.on ?? ""));
  return <div className={css.wrap}>
    <div className={css.bar}>
      <p className={css.pip}><Sparkles size={15} aria-hidden="true" /><span>{run.pip || "Pip has nothing to say yet."}</span></p>
      <div className={css.barTools}>
        <span className={css.count}>{counts.done} of {counts.total} done{counts.skipped ? ` · ${counts.skipped} skipped` : ""}{run.day ? ` · Day ${run.day}` : ""}</span>
        <button type="button" className={styles.btn} onClick={() => void later(1)} disabled={busy || done} title="Moves the test's clock: late steps and alerts show"><FastForward size={14} aria-hidden="true" />A day passes</button>
        <button type="button" className={styles.btn} onClick={() => void later(3)} disabled={busy || done}>3 days pass</button>
        <button type="button" className={`${styles.btn} ${css.danger}`} onClick={() => void discard()} disabled={busy}><Trash2 size={14} aria-hidden="true" />Throw the test away</button>
      </div>
    </div>
    <div className={css.grid}>
      <nav className={css.steps} aria-label="The steps of the test">
        <ol>{run.steps.map((s) => <li key={s.id}><button type="button" data-state={s.state} aria-current={step?.id === s.id ? "step" : undefined} disabled={!OPEN.has(s.state)} onClick={() => setPick(s.id)}>
          <span className={css.dot} data-state={s.state} aria-hidden="true" /><span><b>{s.title}</b><small>{s.state === "skipped" ? s.stateText : s.stateText}</small></span></button></li>)}</ol>
      </nav>
      <section className={css.main} aria-label="Your turn">
        {done ? <div className={css.done}><CircleCheck size={28} aria-hidden="true" /><h2>Done: every step ran.</h2>
          <p>{counts.done} steps done{counts.skipped ? `, ${counts.skipped} skipped on ways not taken or not for this one` : ""}. Throw the test away, or go back and change the process.</p>
          <div className={css.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void discard()} disabled={busy}>Throw the test away</button>
            <Link className={styles.btn} href={`/processes/${encodeURIComponent(processId)}`}>Back to the builder</Link></div></div>
          : step ? <div className={css.turn}>
            <p className={css.you}><UserRound size={16} aria-hidden="true" />You are <b>{role(step)}</b> now</p>
            <h2><span className={css.icon}><ModuleIcon name={step.icon} size={18} /></span>{step.title}</h2>
            <p className={css.what}>{[step.moduleName, step.kind, step.due.text].filter(Boolean).join(" · ")}</p>
            {step.checklist.length ? <ul className={css.check}>{step.checklist.slice(0, 8).map((c) => <li key={c}>{c}</li>)}</ul> : null}
            {step.module === "message" && text ? <blockquote className={css.text}>{text}</blockquote> : null}
            <div className={css.acts}>{actsFor(step, run).map((a) => <button key={a.label} type="button" className={`${styles.btn} ${a.tone === "primary" ? styles.btnPrimary : ""}`} disabled={busy} onClick={() => void act(a)}>{a.label}</button>)}</div>
            <p className={css.quiet}>Or do it on its own screen: <Link href={`/steps/${step.id}`} target="_blank"><ExternalLink size={12} aria-hidden="true" /> open the step</Link></p>
            {open.length > 1 ? <p className={css.quiet}>Also open now: {open.filter((s) => s.id !== step.id).map((s) => <button key={s.id} type="button" className={css.link} onClick={() => setPick(s.id)}>{s.title} ({role(s)})</button>)}</p> : null}
          </div>
            : <div className={css.done}><Hourglass size={26} aria-hidden="true" /><h2>Nothing is open right now.</h2>
              {asked.length ? <><p>These wait for something someone types in or uploads:</p>
                {asked.map(({ s, w }) => <div key={`${s.id}-${w.port}`} className={css.row}><span className={css.quiet}><b>{s.title}</b>: {w.label}{w.ownerRole ? ` (from the ${w.ownerRole})` : ""}</span>
                  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void act({ label: "Typed in", run: () => flow(`steps/${s.id}/input`, "POST", { port: w.port, value: { sample: true, text: `Sample ${w.label.toLowerCase()} (Try it)`, on: day(1) } }) })}>Type in a sample</button>
                  <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ label: "Skipped", run: () => flow(`steps/${s.id}/skip`, "POST", { why: "Not needed in this test" }) })}>Skip it</button></div>)}</>
                : <p>Steps are waiting: for a date, or for something to arrive. Let a day pass.</p>}</div>}
      </section>
      <aside className={css.side} aria-label="What happened">
        <h3><BellRing size={14} aria-hidden="true" />Who heard what</h3>
        {run.notices.length ? <ul className={css.notices}>{run.notices.slice(0, 30).map((n, i) => <li key={i}><b>{n.to}</b><span>{n.title}</span><small suppressHydrationWarning>{n.sent ? (n.how === "Work task" ? "as a Work task" : "in Pulse") : n.how === "Work task" ? "would get a Work task" : "would hear it in Pulse"} · {new Date(n.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</small></li>)}</ul>
          : <p className={css.quiet}>Nobody yet.</p>}
        <h3><BellRing size={14} aria-hidden="true" />Alerts</h3>
        {run.alerts.length ? <ul className={css.alerts}>{run.alerts.map((a) => <li key={a.key}><b>{a.name}</b><small>{run.steps.find((s) => s.key === a.step)?.title ?? ""}</small></li>)}</ul> : <p className={css.quiet}>None. Let a few days pass to see one.</p>}
        <h3><CalendarClock size={14} aria-hidden="true" />Due</h3>
        {due.length ? <ul className={css.due}>{due.map((s) => <li key={s.id} data-late={s.due.late ? "" : undefined}><b>{s.title}</b><small>{s.due.text}</small></li>)}</ul> : <p className={css.quiet}>No due dates on the open steps.</p>}
      </aside>
    </div>
  </div>;
}
