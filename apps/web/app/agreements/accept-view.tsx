"use client";
// AGREEMENTS (owner, 13 Nov 2026, P1.2 / T1.2.1: "a full screen or a completely seventy to eighty percent coverage of
// screen. The UI, the colors make it so that the people just click on it. Progressively they are clicking on terms,
// agreeing on that, and then they have a nice animation that they have accepted and they can go back to work"): the
// policy acceptance view. When HR publishes a version of a policy (pay, leave, conduct …), each employee meets it on their
// next visit over whatever page they opened: the key terms one at a time, each ticked ("I understand"), then "I accept",
// a short celebration, and back to work. Concepts (Codex, reports/agreements-shots/concepts/accept): a checklist beside
// the term on a wide screen (2), a segmented bar on a phone (1), the finish card and "Done!" (3).
// "Not now" waits until the next visit (this tab's session); My desk → Policies and Agreements open it on demand
// (openAcceptance). The server checks every tick against that exact version (POST agreements/policies/:id/accept).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowLeft, Check, ChevronDown, FileCheck2, ShieldCheck, Signature } from "lucide-react";
import { TermIcon } from "./kinds";
import { parseMarkdown, plain } from "../lib/markdown.mjs";
import type { Block, Inline } from "../lib/markdown.mjs";
import { MarkdownBody } from "../hr/policy-reader";
import { ProgressRing, celebrate, gameCss, toast } from "../kit/game";
import { Avatar } from "../kit";
import { useOrgZone } from "../org-code";
import css from "./accept.module.css";

export type Term = { key: string; number: number | null; title: string; text: string };
/** A policy version to accept, or (AGREEMENTS round 14 Nov) an offer sent to the person: `type: "offer"`, its letter's
 *  words as the terms, `role` the job, `publishedBy` who sent it. */
export type DuePolicy = { id: string; kind: string; title: string; version: number; publishedAt: string | null; publishedBy: string | null; intro: string; terms: Term[];
  closing: { title: string; text: string } | null; type?: "offer"; role?: string };
export type Accepted = { documentId: string; kind: string; title: string; version: number; at: string; via: "steps" | "desk"; terms: number; current: boolean };
export type MyPolicies = { due: DuePolicy[]; accepted: Accepted[]; team: boolean };

export const ACCEPT_EVENT = "pulse:policy-accept";
/** Open the acceptance view: on one policy (its id), or on whatever waits. */
export function openAcceptance(id?: string) { window.dispatchEvent(new CustomEvent(ACCEPT_EVENT, { detail: { id } })); }

const LATER = "pulse-policy-later";
/** Words a term may use, in plain words: under the term that first uses them (its title's words first), at most four.
 *  `title`: only when the term's title uses the word. */
const PLAIN: [RegExp, string, string, boolean?][] = [
  [/\bfounders?\b/i, "Founder", "one of the people who started and own the company"],
  [/\bpropos(e|es|ed)\b/i, "Propose", "suggest a change for someone else to approve"],
  [/\bprobation\b/i, "Probation", "your first months, when both sides check the job is a good fit"],
  [/\boffers?\b/i, "Offer", "the job, pay and start date the company gives you in writing", true],
  [/\bnotice\b/i, "Notice", "the time between saying you will leave and your last day"],
  [/\bcalendar days\b/i, "Calendar days", "every day counts, weekends and holidays too"],
  [/\bin writing\b/i, "In writing", "by email or a letter, not only by word of mouth"],
  [/\badvances?\b/i, "Advance", "pay given early, taken back from later pay"],
  [/\bbasic\b/i, "Basic", "the main part of your pay"],
  [/\bgross\b/i, "Gross pay", "your monthly pay before anything is taken off"],
  [/\bHRA\b|house rent allowance/i, "House rent allowance", "a part of your pay meant for rent"],
  [/\bspecial allowance\b/i, "Special allowance", "a part with no fixed rule that makes up your full pay"],
  [/\bPF\b|provident fund/i, "PF", "Provident Fund, savings for when you retire. The company's share is extra, on top of your pay"],
  [/\bCTC\b/, "CTC", "cost to company: all the company spends on your pay in a year"],
  [/\bencash/i, "Encash", "to be paid for leave you did not take"],
  [/\bclaims?\b/i, "Claim", "asking the company to pay you back for money you spent on work"],
];
/** A pay table's rows the company pays on top (Employer PF) are shown apart, under their own line, so the rows above add
 *  up to the pay. The words are the policy's own; only where they sit on screen changes. */
const EXTRA = /employer|paid by the company|company pays/i;
/** A table row named by a hard word ("Employer PF") gets the word's plain meaning after its rule, where it is read. */
/** A table cell starts with a capital on screen ("the rest" → "The rest"); the stored words stay as written. */
const capital = (cell: Inline[]): Inline[] => { const [first, ...rest] = cell; return first?.type === "text" ? [{ ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...rest] : cell; };
const hinted = (cell: Inline[], says: string): Inline[] => [...cell, { type: "break" }, { type: "em", children: [{ type: "text", text: says.charAt(0).toUpperCase() + says.slice(1) + "." }] }];
function withHints(row: Inline[][]): Inline[][] {
  row = row.map(capital);
  const hint = PLAIN.find(([re]) => re.test(plain(row[0] ?? [])));
  if (!hint) return row;
  const at = row.length > 2 ? 1 : 0;
  return row.map((cell, i) => (i === at ? hinted(cell, hint[2]) : cell));
}
/** A term with a table: a sentence before it that uses a hard word ("gross pay") gets the plain meaning right under it. */
function withSentenceHints(blocks: Block[]): Block[] {
  if (!blocks.some((b) => b.type === "table")) return blocks;
  return blocks.map((b) => {
    if (b.type !== "paragraph") return b;
    const hint = PLAIN.find(([re, , , title]) => !title && re.test(plain(b.children)));
    return hint ? { ...b, children: hinted(b.children, `${hint[1]}: ${hint[2]}`) } : b;
  });
}
function splitExtra(blocks: Block[]): Block[] {
  return blocks.flatMap((b): Block[] => {
    if (b.type !== "table") return [b];
    const rows = b.rows.map(withHints), extra = rows.filter((r) => EXTRA.test(plain(r[0] ?? [])));
    if (!extra.length || extra.length === rows.length) return [{ ...b, rows }];
    return [{ ...b, rows: rows.filter((r) => !extra.includes(r)) }, { type: "paragraph", children: [{ type: "strong", children: [{ type: "text", text: "Extra, on top of your pay:" }] }] },
      { ...b, head: [], rows: extra }];
  });
}

/** Each term's plain words: the title's first, then in reading order (each term explains its own). */
export function plainWords(terms: { title: string; text: string }[]) {
  const seen = new Set<string>();
  return terms.map((t) => {
    seen.clear();
    const at = ([re, , , title]: (typeof PLAIN)[number]) => { if (re.test(t.title)) return -1; if (title) return Infinity; const m = re.exec(t.text); return m ? m.index : Infinity; };
    const found = PLAIN.map((p) => ({ p, at: at(p) })).filter((x) => x.at !== Infinity && !seen.has(x.p[1])).sort((x, y) => x.at - y.at).slice(0, 3).map((x) => x.p);
    for (const [, word] of found) seen.add(word);
    return found;
  });
}
const later = (): string[] => { try { return JSON.parse(sessionStorage.getItem(LATER) ?? "[]"); } catch { return []; } };
const waitTillNextVisit = (ids: string[]) => { try { sessionStorage.setItem(LATER, JSON.stringify([...new Set([...later(), ...ids])])); } catch { /* private mode: it asks again */ } };
/** Pages where it never opens by itself: signing in, joining, a client's signing page. */
const QUIET = /^\/(login|join|invited|accept|welcome)(\/|$)/;

async function readDue(): Promise<DuePolicy[] | null> {
  try { const r = await fetch("/api/v0/agreements/policies?due=1", { cache: "no-store" }); return r.ok ? ((await r.json()) as MyPolicies).due : null; } catch { return null; }
}

/** Mounted once in the app's layout (staff seats): opens the view on the visit's first page when a policy waits. */
export function PolicyAcceptHost({ name, person }: { name: string; person: string }) {
  const [queue, setQueue] = useState<DuePolicy[] | null>(null);
  useEffect(() => {
    if (window.top !== window.self || QUIET.test(window.location.pathname)) return;
    let gone = false;
    const t = window.setTimeout(() => void readDue().then((due) => {
      // The compulsory two-step setup goes first; this asks again on the next visit.
      if (gone || !due || document.querySelector('[aria-labelledby="two-step-title"]')) return;
      const skip = new Set(later()), waiting = due.filter((d) => !skip.has(d.id));
      if (waiting.length) setQueue(waiting);
    }), 600);
    return () => { gone = true; window.clearTimeout(t); };
  }, []);
  useEffect(() => {
    const asked = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      void readDue().then((due) => {
        if (!due) toast("Policies did not load. Try again in a moment.", { tone: "bad" });
        else if (!due.length) toast("Nothing waits for you: every policy is accepted.");
        else setQueue(id ? [...due.filter((d) => d.id === id), ...due.filter((d) => d.id !== id)] : due);
      });
    };
    window.addEventListener(ACCEPT_EVENT, asked);
    return () => window.removeEventListener(ACCEPT_EVENT, asked);
  }, []);
  const reload = useCallback(() => void readDue().then((due) => setQueue(due?.length ? due : null)), []);
  if (!queue?.length) return null;
  return <AcceptView queue={queue} name={name} person={person} onReload={reload}
    onClose={(accepted, rest) => { if (rest.length) waitTillNextVisit(rest); setQueue(null); if (accepted) window.dispatchEvent(new Event("pulse:data-changed")); }} />;
}

/** The sheet over the page: the policies waiting, one after the other. */
export function AcceptView({ queue, name, person, onClose, onReload }: { queue: DuePolicy[]; name: string; person: string;
  /** `rest`: the ids not accepted, which wait until the next visit. */ onClose: (accepted: boolean, rest: string[]) => void; onReload: () => void }) {
  const [at, setAt] = useState(0), [accepted, setAccepted] = useState<string[]>([]);
  const sheet = useRef<HTMLDivElement>(null);
  const policy = queue[Math.min(at, queue.length - 1)];
  const close = useCallback(() => onClose(accepted.length > 0, queue.map((q) => q.id).filter((id) => !accepted.includes(id))), [accepted, onClose, queue]);
  useEffect(() => {
    const root = document.documentElement, before = root.style.overflow, was = document.activeElement as HTMLElement | null;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = before; was?.focus?.({ preventScroll: true }); };
  }, []);
  // Tab stays inside the sheet; Escape is "Not now".
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab" || !sheet.current) return;
    const all = [...sheet.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return <div className={css.backdrop} data-policy-accept="">
    <div ref={sheet} className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="policy-accept-title" onKeyDown={keys}>
      <PolicySteps key={policy.id} policy={policy} name={name} person={person} next={queue[at + 1] ?? null} position={queue.length > 1 ? `${at + 1} of ${queue.length}` : null}
        onAccepted={() => setAccepted((a) => [...a, policy.id])} onNext={() => setAt((i) => i + 1)} onClose={close} onReload={onReload} />
    </div>
  </div>;
}

function PolicySteps({ policy, name, person, next, position, onAccepted, onNext, onClose, onReload }: { policy: DuePolicy; name: string; person: string; next: DuePolicy | null;
  position: string | null; onAccepted: () => void; onNext: () => void; onClose: () => void; onReload: () => void }) {
  const zone = useOrgZone();
  const n = policy.terms.length, offer = policy.type === "offer";
  const [step, setStep] = useState(0), [ticked, setTicked] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<{ text: string; stale?: boolean } | null>(null), [done, setDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), burstAt = useRef<HTMLSpanElement>(null), pane = useRef<HTMLDivElement>(null);
  // A long term (the pay table) scrolls: "More below" until its end, where "I understand" waits.
  const [more, setMore] = useState(false);
  // A long term: the button stays at the bottom of the pane (the words fade under it), with "More below".
  const measure = useCallback(() => { const el = pane.current; setMore(!!el && el.scrollHeight - el.clientHeight - el.scrollTop > 4); }, []);
  useEffect(() => { pane.current?.scrollTo({ top: 0 }); const f = requestAnimationFrame(measure); window.addEventListener("resize", measure); return () => { cancelAnimationFrame(f); window.removeEventListener("resize", measure); }; }, [step, measure]);
  const day = useMemo(() => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: zone }), [zone]);
  const blocks = useMemo(() => policy.terms.map((t) => splitExtra(withSentenceHints(parseMarkdown(t.text).blocks))), [policy.terms]);
  const words = useMemo(() => plainWords(policy.terms), [policy.terms]);
  const tables = useMemo(() => blocks.map((b) => b.some((x) => x.type === "table")), [blocks]);
  const intro = useMemo(() => (policy.intro ? parseMarkdown(policy.intro).blocks : null), [policy.intro]);
  const closing = useMemo(() => (policy.closing?.text ? parseMarkdown(policy.closing.text).blocks : null), [policy.closing]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step, done]);
  useEffect(() => { if (done) celebrate(burstAt.current, { big: true }); }, [done]);
  const finish = step >= n;
  // Under the term; a term with a table explains its words where they are used instead (withHints, withSentenceHints).
  const shown = finish || tables[step] ? [] : words[step];
  const plainBox = shown.length ? <dl className={css.plain} aria-label="In plain words"><p>In plain words</p>
    {shown.map(([, word, says]) => <div key={word}><dt>{word}</dt><dd>{says}</dd></div>)}</dl> : null;
  const term = finish ? null : policy.terms[step];
  const name1 = name.trim().split(/\s+/)[0] || name;
  function understood() {
    if (step === ticked) setTicked(ticked + 1);
    setStep(step < ticked ? ticked : step + 1);
  }
  async function accept() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/v0/agreements/${offer ? "offers" : "policies"}/${policy.id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ terms: policy.terms.map((t) => t.key) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError({ text: d.error ?? "Could not save. Try again.", stale: r.status === 409 }); return; }
      onAccepted(); setDone(true);
    } catch { setError({ text: "No connection. Try again in a moment." }); }
    finally { setBusy(false); }
  }

  if (done) return <div className={css.done}>
    <span ref={burstAt} className={css.doneTick} aria-hidden="true"><Check size={44} strokeWidth={3} /></span>
    <h2 id="policy-accept-title" ref={heading} tabIndex={-1}>Done! Thanks, {name1}.</h2>
    <p>{offer ? `You accepted the offer${policy.role ? ` as ${policy.role}` : ""} on ${day.format(new Date())}. Welcome aboard!` : `You accepted the ${policy.title}, version ${policy.version}, on ${day.format(new Date())}.`}</p>
    <ul className={css.doneList}><li><Check size={15} strokeWidth={3} aria-hidden="true" />{n === 1 ? "Read and accepted" : `All ${n} terms ticked`}</li>
      <li><ShieldCheck size={15} aria-hidden="true" />Saved to your record</li></ul>
    <p className={css.doneWhere}>{offer ? <>Your signed letter is in <span className={css.nowrap}>My pay → Letters</span>.</> : <>You can read it again any time in <span className={css.nowrap}>My desk → Agreements</span>.</>}</p>
    <div className={css.doneActions}>
      {next ? <><button type="button" className={gameCss.primary} onClick={onNext}>Next: {next.title}</button>
        <button type="button" className={gameCss.quiet} onClick={onClose}>Back to work</button></>
        : <button type="button" className={gameCss.primary} onClick={onClose}>Back to work</button>}
    </div>
  </div>;

  return <>
    <header className={css.head}>
      <div className={css.headText}>
        <p className={css.eyebrow}><FileCheck2 size={15} aria-hidden="true" />{offer ? "A job offer for you" : policy.version > 1 ? "HR updated a policy" : "A new policy to accept"}{position ? ` · ${position}` : ""}</p>
        <h2 id="policy-accept-title" className={css.title}>{offer && policy.role ? `${policy.title}: ${policy.role}` : policy.title}</h2>
        <p className={css.meta}>{offer ? null : <span>{policy.version > 1 ? `Version ${policy.version}` : "First version"}</span>}
          {policy.publishedBy ? <span className={offer ? undefined : css.by}>{offer ? "Sent by" : "published by"} {policy.publishedBy}</span> : null}
          {policy.publishedAt ? <span>{day.format(new Date(policy.publishedAt))}</span> : null}</p>
      </div>
      <div className={css.headSide}>
        <span className={css.ring}><ProgressRing value={n ? ticked / n : 1} size={72} stroke={7} label={`${ticked} of ${n} terms ticked`} tone={n && ticked === n ? "good" : undefined}>
          <b className={css.ringCount}>{ticked}/{n}</b><small className={css.ringWord}>ticked</small></ProgressRing></span>
        <button type="button" className={css.later} onClick={onClose}>Not now</button>
      </div>
    </header>
    <div className={css.barRow}><ol className={css.bar} aria-hidden="true">{policy.terms.map((t, i) => <li key={t.key} data-state={i < ticked ? "done" : i === step ? "now" : "next"} />)}</ol>
      <span className={css.barText} data-done={finish ? "" : undefined}>{finish ? <><Check size={14} strokeWidth={3} aria-hidden="true" />All {n} ticked</> : `${ticked} of ${n} ticked`}</span></div>
    <div className={css.body}>
      <nav className={css.rail} aria-label="Terms">
        <ol>{policy.terms.map((t, i) => {
          const state = i < ticked ? "done" : i === step ? "now" : "next";
          return <li key={t.key}><button type="button" className={css.railItem} data-state={state} aria-current={i === step ? "step" : undefined} disabled={i > ticked} onClick={() => setStep(i)}>
            <span className={css.railDot} aria-hidden="true">{state === "done" ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
            <span className={css.railName}>{t.title || policy.title}<span className={gameCss.srOnly}>{state === "done" ? " (ticked)" : ""}</span></span>
          </button></li>;
        })}</ol>
      </nav>
      {finish ? <section className={css.term} aria-labelledby="policy-finish-title"><div className={css.termScroll}><div className={css.finishInner}>
        <span className={css.signIcon} aria-hidden="true"><Signature size={36} /></span>
        <div className={css.finishText}>
          <h3 id="policy-finish-title" ref={heading} tabIndex={-1}>{offer ? "Last step: accept the offer" : "Last step: accept the policy"}</h3>
          <p>{n === 1 ? "You read it." : `You ticked all ${n} terms.`} Press “I accept” to add your name and today’s date.</p>
        </div>
        <div className={css.sign}>
          <p>{offer ? `I accept this offer${policy.role ? ` as ${policy.role}` : ""}.` : `I accept the ${policy.title}, version ${policy.version}.`}</p>
          <span className={css.signer}><Avatar name={name} id={person} photoAt={null} size={40} /><b>{name}</b><small>{day.format(new Date())}</small></span>
        </div>
        {error ? <p className={css.error} role="alert">{error.text}</p> : null}
      </div></div>
        {/* "I accept" sits where "I understand" sat on every term. */}
        <div className={css.termFoot}>
          <button type="button" className={css.back} onClick={() => setStep(n - 1)} disabled={!n}><ArrowLeft size={15} aria-hidden="true" />Read the terms again</button>
          {error?.stale ? <button type="button" className={`${gameCss.primary} ${css.big}`} onClick={onReload}>Read the new version</button>
            : <button type="button" className={`${gameCss.primary} ${css.big}`} onClick={() => void accept()} disabled={busy} aria-busy={busy || undefined}><Check size={18} aria-hidden="true" />{busy ? "Saving…" : "I accept"}</button>}
        </div>
      </section> : <section className={css.term} aria-labelledby="policy-term-title">
        <div ref={pane} className={css.termScroll} onScroll={measure}><div key={step} className={css.termCard}>
          <div className={css.termTop}><span className={css.termIcon} aria-hidden="true"><TermIcon title={term!.title} kind={policy.kind} size={22} /></span><span className={css.termChip}>Term {step + 1} of {n}</span></div>
          <h3 id="policy-term-title" ref={heading} tabIndex={-1} className={css.termTitle}>{term!.title || policy.title}</h3>
          <div className={css.prose}><MarkdownBody blocks={blocks[step]} anchors={false} /></div>
          {plainBox}
          {step === 0 && (intro || closing) ? <details className={css.intro}><summary><ChevronDown size={16} aria-hidden="true" />{closing ? "What happens when you accept" : "About this policy"}</summary>
            {intro ? <div className={css.prose}><MarkdownBody blocks={intro} anchors={false} /></div> : null}
            {closing ? <div className={css.prose}><MarkdownBody blocks={closing} anchors={false} /></div> : null}
          </details> : null}
        </div></div>
        {/* The button keeps one place on every term: the foot of the pane (concept 2). A long term fades under it. */}
        <div className={css.termFoot} data-more={more ? "" : undefined}>
          <span className={css.footText}><span className={css.count}>{step === n - 1 && step >= ticked ? "Last one!" : !ticked ? "Read it, then press I understand" : `${ticked} ${ticked === 1 ? "term" : "terms"} ticked · ${n - ticked} to go`}</span>
            {step < n - 1 && !more ? <span className={css.next}>Next: {policy.terms[step + 1].title || policy.title}</span> : null}
            {more ? <button type="button" className={css.moreLink} onClick={() => pane.current?.scrollBy({ top: pane.current.clientHeight * 0.75, behavior: "smooth" })}><ArrowDown size={14} aria-hidden="true" />More below</button> : null}</span>
          <button type="button" className={`${gameCss.primary} ${css.big}`} onClick={understood}>
            <Check size={18} aria-hidden="true" />{step < ticked ? "Continue" : "I understand"}
          </button>
        </div>
      </section>}
    </div>
  </>;
}
