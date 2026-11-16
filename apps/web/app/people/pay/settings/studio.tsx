"use client";
// HR-PEOPLE (owner, 13 Nov 2026, T1.1.10–11: the pay policy settings page "I hate it from heart"; "One thing I truly like is
// pay policy. But then why it is not connected to the HR desks … to the documents"; Codex concept pay 1, "Questions left,
// document right"): five plain answers on the left, each one sentence with Change; on the right the policy they write,
// live, with every number that came from an answer marked. Publish policy saves the answers, writes the document as the
// company's "pay" policy (HR desk → Pay & policy → Policies lists it) and asks everyone to accept it (My desk → Policies;
// AGREEMENTS' acceptance view reads the same document and acceptances). Claims, letters and payroll basics sit under
// More settings.
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { BadgeCheck, ChevronDown, FileText, PenLine, Send } from "lucide-react";
import { LETTER_DEFAULTS, LETTER_KINDS } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { celebrate, ProgressRing, toast } from "../../../kit/game";
import { SelectField } from "../../../kit/select-field";
import { LETTER_KIND, type Component } from "../model";
import { ANSWER_FIELDS, EXAMPLE_GROSS, inr, NOTICE_DEFAULT, payPolicyDoc } from "../policy-doc.mjs";
import type { PolicyRow } from "../policy-state";
import css from "../pay.module.css";

export type Policy = { approvers: string; probationApproval: string; managers: string; currency: string; probationDays: number; remindDays: number; noticeProbation: number | null;
  noticeConfirmed: number | null; offerDays: number; dayBasis: string; encashBasis: string; encashDivisor: number; components: Component[]; claimCategories: { key: string; label: string; cap?: number }[];
  claimThreshold: number | null; recoverMax: number; letters: Record<string, { title?: string; body?: string }>; founders: { id: string; name: string }[] | null; foundersNamed: boolean; canEdit: boolean; canEditApprovers: boolean };
export type DocState = { latest: PolicyRow | null; version: number | null; published: boolean; accepted: number; of: number; draft: boolean } | null;

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const SPLIT_HUES = ["var(--theme-action)", "color-mix(in srgb, var(--theme-action) 62%, var(--theme-surface))", "color-mix(in srgb, var(--theme-action) 36%, var(--theme-surface))", "color-mix(in srgb, var(--theme-action) 18%, var(--theme-surface))"];
/** Numbers the answers put in the document: days, months, percents and rupees. */
const MARK = /(₹[\d,]*\d(?:\.\d+)?|\b\d+(?:\.\d+)?%|\b\d+ (?:working days|days?|months?)\b)/g;

function marked(text: string): ReactNode {
  const parts = text.split(MARK);
  return parts.map((t, i) => (i % 2 ? <mark key={i} className={css.docMark}>{t}</mark> : <Fragment key={i}>{t.split(/\*\*([^*]+)\*\*/).map((x, j) => (j % 2 ? <b key={j}>{x}</b> : x))}</Fragment>));
}

/** The small Markdown the document is written in (headings, paragraphs, one table), drawn as a page. */
function DocPage({ body }: { body: string }) {
  // Line by line: "## " is a heading, a run of "|" lines is a table, other lines join into paragraphs (a blank line ends one).
  const out: ReactNode[] = [];
  const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
  let para: string[] = [], table: string[] = [];
  const flush = () => {
    if (para.length) { out.push(<p key={out.length}>{marked(para.join(" "))}</p>); para = []; }
    if (table.length >= 2) {
      const [head, , ...rest] = table;
      out.push(<div key={out.length} className={css.docTableWrap}><table className={css.docTable}><thead><tr>{cells(head).map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{rest.map((r) => <tr key={r}>{cells(r).map((c, j) => <td key={j}>{marked(c)}</td>)}</tr>)}</tbody></table></div>);
    }
    table = [];
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) { flush(); out.push(<h3 key={out.length}>{line.slice(3)}</h3>); }
    else if (line.startsWith("|")) { if (para.length) { out.push(<p key={out.length}>{marked(para.join(" "))}</p>); para = []; } table.push(line); }
    else if (!line.trim()) flush();
    else { if (table.length) flush(); para.push(line.trim()); }
  }
  flush();
  return <div className={css.docPaper}>{out}</div>;
}

export function PolicyStudio({ policy, doc, company, head, aside }: { policy: Policy; doc: DocState; company: string; /** Who approves a claim first ("pod head"). */ head: string; /** More settings (payroll basics), saved on their own. */ aside?: ReactNode }) {
  const router = useRouter();
  const [p, setP] = useState(policy), [base, setBase] = useState(policy), [open, setOpen] = useState<string | null>(null), [letter, setLetter] = useState("offer");
  const [busy, setBusy] = useState<"" | "save" | "publish">(""), [error, setError] = useState("");
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP({ ...p, [k]: v });
  const changes = (Object.keys(p) as (keyof Policy)[]).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(base[k])).length;
  const d = useMemo(() => payPolicyDoc(p, { company, head }), [p, company, head]);
  const latest = doc?.latest ?? null;
  // The document differs from what was last written (or nothing was written yet): publishing writes a new version.
  const docChanged = !latest || latest.body?.trim() !== d.body.trim() || latest.status === "draft";
  const own = p.letters[letter] ?? {}, def = LETTER_DEFAULTS[letter as keyof typeof LETTER_DEFAULTS];
  // An opened answer comes into view with its first field ready (on a phone it opened below the fold).
  useEffect(() => {
    if (!open) return;
    const box = document.getElementById(`edit-${open}`), r = box?.getBoundingClientRect();
    // Only when the fields are not already in view (a desktop page stays put, its status and Publish visible).
    if (r && (r.bottom > window.innerHeight - 96 || r.top < 72)) box?.closest("section")?.scrollIntoView({ block: "start", behavior: "smooth" });
    box?.querySelector<HTMLElement>("input, select, button[aria-haspopup]")?.focus({ preventScroll: true });
  }, [open]);

  async function write(publish: boolean) {
    setBusy(publish ? "publish" : "save"); setError("");
    try {
      if (changes) { await post("comp/policy", { ...p, components: p.components.map(({ amount: _a, ...c }) => c) }); setBase(p); }
      let id = latest?.id ?? "", revision = latest?.revision ?? 1, version = latest?.version ?? 0;
      if (docChanged) {
        // The HR policy documents' draft: into the latest draft, or the next version on top of a published one.
        const saved = await post("hr/policies/draft", { kind: "pay", title: d.title, body: d.body, version, revision: latest?.status === "draft" ? latest.revision ?? 1 : 1 }) as { id: string; version: number; revision: number };
        id = saved.id; revision = saved.revision; version = saved.version;
      }
      if (publish && (docChanged || latest?.status === "draft")) {
        await post("hr/policies/publish", { documentId: id, revision });
        celebrate(document.querySelector("[data-publish]"), { id: `pay-policy-${version}` });
        toast(`Pay policy version ${version} published. Everyone is asked to read and accept it.`);
      } else toast(publish ? "Nothing new to publish: everyone already has this version." : "Saved. Publish when you are ready.");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(""); }
  }

  const field = (label: string, input: ReactNode, wide = false) => <label className={`${styles.field}${wide ? ` ${styles.wide}` : ""}`}>{label}{input}</label>;
  const editors: Record<string, ReactNode> = {
    approve: <>{field("Pay changes, offers, pauses and bonuses are approved by", <SelectField value={p.approvers} disabled={!p.canEditApprovers} onChange={(e) => set("approvers", e.target.value)}><option value="founders">A founder</option><option value="leadership">Leadership</option><option value="second_hr">A second person in HR</option></SelectField>)}
      {field("Ending probation", <SelectField value={p.probationApproval} disabled={!p.canEditApprovers} onChange={(e) => set("probationApproval", e.target.value)}><option value="hr">HR records it</option><option value="founder">A founder approves it</option></SelectField>)}
      {field("Managers see", <SelectField value={p.managers} onChange={(e) => set("managers", e.target.value)}><option value="none">Nothing about pay</option><option value="status">Status and dates, never amounts</option></SelectField>)}
      <p className={`${styles.wide} ${css.quiet}`}>Founders: {p.founders?.map((f) => f.name).join(", ") || "none named, so leadership counts as founders"}.{!p.canEditApprovers ? " Only leadership changes who approves." : ""}</p></>,
    probation: <>{field("Probation (days)", <input inputMode="numeric" value={num(p.probationDays)} onChange={(e) => set("probationDays", Number(e.target.value) || 0)} />)}
      {field("Reminder (days before it ends)", <input inputMode="numeric" value={num(p.remindDays)} onChange={(e) => set("remindDays", Number(e.target.value) || 1)} />)}
      {field("An offer stays open (days)", <input inputMode="numeric" value={num(p.offerDays)} onChange={(e) => set("offerDays", Number(e.target.value) || 7)} />)}</>,
    notice: <>{field("During probation (days)", <input inputMode="numeric" value={num(p.noticeProbation ?? NOTICE_DEFAULT.probation)} onChange={(e) => set("noticeProbation", e.target.value === "" ? null : Number(e.target.value))} />)}
      {field("After probation (days)", <input inputMode="numeric" value={num(p.noticeConfirmed ?? NOTICE_DEFAULT.confirmed)} onChange={(e) => set("noticeConfirmed", e.target.value === "" ? null : Number(e.target.value))} />)}</>,
    day: <>{field("A day's pay is monthly pay ÷", <SelectField value={String(p.encashDivisor)} onChange={(e) => set("encashDivisor", Number(e.target.value))}><option value="30">30</option><option value="26">26 working days</option></SelectField>)}
      {field("Unused leave is paid out at", <SelectField value={p.encashBasis} onChange={(e) => set("encashBasis", e.target.value)}><option value="basic">Basic pay</option><option value="gross">Gross pay</option><option value="none">Not paid out</option></SelectField>)}
      {field("Advances paid back within (months)", <input inputMode="numeric" value={num(p.recoverMax)} onChange={(e) => set("recoverMax", Number(e.target.value) || 1)} />)}</>,
    split: <div className={`${styles.wide} ${css.splitEdit}`}><table className={css.policyTable}><thead><tr><th scope="col">Part</th><th scope="col">Share</th><th scope="col">Of</th><th scope="col">At most a month (₹)</th></tr></thead><tbody>
      {p.components.map((c, i) => { const put = (x: Partial<Component>) => set("components", p.components.map((y, j) => (j === i ? { ...y, ...x } : y)));
        return <tr key={c.key}><td><input aria-label={`Name of ${c.key}`} value={c.label} onChange={(e) => put({ label: e.target.value })} />{c.kind === "employer" ? <small className={css.quiet}>Paid by the company</small> : null}</td>
          <td>{c.balance ? "The rest" : <input aria-label={`Share of ${c.label}, percent`} inputMode="decimal" value={num(c.pct)} onChange={(e) => put({ pct: Number(e.target.value) || 0 })} />}</td>
          <td>{c.balance ? "" : <SelectField aria-label={`${c.label} is a share of`} value={c.of ?? "gross"} onChange={(e) => put({ of: e.target.value })}><option value="gross">Gross pay</option>{p.components.filter((y) => y.key !== c.key && y.kind === "earning").map((y) => <option key={y.key} value={y.key}>{y.label}</option>)}</SelectField>}</td>
          <td><input aria-label={`Most a month for ${c.label}`} inputMode="numeric" value={c.cap ? String(c.cap / 100) : ""} placeholder="No limit" onChange={(e) => put({ cap: e.target.value ? Number(e.target.value) * 100 : undefined })} /></td></tr>; })}
    </tbody></table></div>,
  };
  const parts = p.components.filter((c) => c.kind === "earning").map((c, i) => ({ c, amount: d.split.components[c.key] ?? 0, hue: SPLIT_HUES[i % SPLIT_HUES.length] }));
  // Each part's arc starts where the one before it ended (a pure fold: nothing is reassigned during render).
  const stops = parts.reduce<{ at: number; out: string[] }>((acc, x) => { const to = acc.at + (x.amount / EXAMPLE_GROSS) * 360; return { at: to, out: [...acc.out, `${x.hue} ${acc.at}deg ${to}deg`] }; }, { at: 0, out: [] }).out;
  const donut = `conic-gradient(${stops.join(", ") || "var(--theme-surface-subtle) 0deg 360deg"})`;
  const shareAccepted = doc?.published && doc.of ? doc.accepted / doc.of : 0;

  return <div className={css.studio}>
    <div className={css.answers}>
      {d.answers.map((a, i) => <section key={a.key} className={css.answer} data-open={open === a.key ? "" : undefined} aria-labelledby={`ans-${a.key}`}>
        <header className={css.answerHead}>
          <span className={css.answerNo} aria-hidden="true">{i + 1}</span>
          <h2 id={`ans-${a.key}`}>{a.title}</h2>
          {p.canEdit ? <button type="button" className={`${styles.btn} ${open === a.key ? styles.btnPrimary : styles.btnGhost} ${css.change}`} aria-expanded={open === a.key} aria-controls={`edit-${a.key}`} onClick={() => setOpen(open === a.key ? null : a.key)}>
            {open === a.key ? "Done" : <><PenLine size={13} aria-hidden="true" />Change</>}</button> : null}
        </header>
        <p className={css.answerSentence}>{a.sentence}</p>
        {a.more ? <p className={css.answerMore}>{a.more}</p> : null}
        {a.key === "split" && parts.length ? <div className={css.split}>
          <span className={css.donut} style={{ background: donut }} role="img" aria-label={`For ${inr(EXAMPLE_GROSS)} a month: ${parts.map((x) => `${x.c.label} ${inr(x.amount)}`).join(", ")}`}><span><b>{inr(EXAMPLE_GROSS)}</b><small>a month</small></span></span>
          <ul className={css.splitList}>{parts.map((x) => <li key={x.c.key}><i style={{ background: x.hue }} aria-hidden="true" /><span>{x.c.label}</span><b>{inr(x.amount)}</b></li>)}
            {p.components.filter((c) => c.kind === "employer").map((c) => <li key={c.key} className={css.quiet}><i aria-hidden="true" /><span>{c.label} (company pays)</span><b>{inr(d.split.components[c.key] ?? 0)}</b></li>)}</ul>
        </div> : null}
        {open === a.key ? <div id={`edit-${a.key}`} className={`${styles.modalBody} ${css.answerEdit}`} data-fields={ANSWER_FIELDS[a.key as keyof typeof ANSWER_FIELDS].join(" ")}>{editors[a.key]}</div> : null}
      </section>)}
      <details className={css.moreSettings}>
        <summary><ChevronDown size={15} aria-hidden="true" />More settings: claims, letters and payroll</summary>
        <section className={css.section} aria-label="Claims"><header><h2>Claims</h2></header><div className={styles.modalBody}>
          {field("Above this, HR or a founder approves too (₹)", <input inputMode="numeric" value={num(p.claimThreshold)} placeholder="Never" onChange={(e) => set("claimThreshold", e.target.value === "" ? null : Number(e.target.value))} />)}
          <div className={styles.wide}><table className={css.policyTable}><thead><tr><th scope="col">What people can claim</th><th scope="col">Limit a month (₹)</th></tr></thead><tbody>
            {p.claimCategories.map((c, i) => <tr key={c.key}><td><input aria-label={`Category ${c.key}`} value={c.label} onChange={(e) => set("claimCategories", p.claimCategories.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} /></td>
              <td><input aria-label={`Limit for ${c.label}`} inputMode="numeric" value={c.cap ? String(c.cap) : ""} placeholder="No limit" onChange={(e) => set("claimCategories", p.claimCategories.map((y, j) => (j === i ? { ...y, cap: e.target.value ? Number(e.target.value) : undefined } : y)))} /></td></tr>)}
          </tbody></table></div></div></section>
        <section className={css.section} aria-label="Letters"><header><h2>Letters</h2><span className={css.quiet}>{"Words in double braces are filled in, such as {{firstName}} and {{role}}."}</span></header><div className={styles.modalBody}>
          {field("Letter", <SelectField value={letter} onChange={(e) => setLetter(e.target.value)}>{LETTER_KINDS.filter((k) => k !== "start").map((k) => <option key={k} value={k}>{LETTER_KIND[k]}</option>)}</SelectField>)}
          {field("Title", <input value={own.title ?? ""} placeholder={def.title} onChange={(e) => set("letters", { ...p.letters, [letter]: { ...own, title: e.target.value } })} />)}
          {field("Words", <textarea className={css.letterBody} value={own.body ?? def.body} onChange={(e) => set("letters", { ...p.letters, [letter]: { ...own, body: e.target.value } })} />, true)}
          {own.body || own.title ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { const next = { ...p.letters }; delete next[letter]; set("letters", next); }}>Use Pulse’s wording</button> : null}
        </div></section>
        {aside}
      </details>
    </div>
    <aside className={css.docSide} aria-label="The pay policy document">
      <div className={css.docStrip}>
        {doc?.published ? <ProgressRing value={shareAccepted} size={56} stroke={7} label={`${doc.accepted} of ${doc.of} accepted`} tone={doc.accepted >= doc.of ? "good" : undefined}>
          <b className={css.docRingNum}>{Math.round(shareAccepted * 100)}%</b></ProgressRing> : <span className={css.docIcon} aria-hidden="true"><FileText size={22} /></span>}
        <div className={css.docStripText}>
          <b>{doc?.published ? `Version ${doc.version} · ${doc.accepted} of ${doc.of} accepted` : "Not published yet"}</b>
          <span>{open ? "Press Done on the open answer, then publish." : changes || docChanged ? (doc?.published ? "Your changes make a new version." : "Publish to ask everyone to accept it.") : "Everyone has this version."}</span>
        </div>
        {p.canEdit ? <button type="button" data-publish="" className={`${styles.btn} ${styles.btnPrimary} ${css.publish}`} disabled={!!busy || !!open || (!changes && !docChanged)} title={open ? "Press Done on the open answer first" : undefined} onClick={() => void write(true)}>
          {busy === "publish" ? "Publishing…" : !changes && !docChanged ? <><BadgeCheck size={15} aria-hidden="true" />Published</> : <><Send size={15} aria-hidden="true" />Publish policy</>}</button> : null}
      </div>
      {error ? <p role="alert" className={css.warn}>{error}</p> : null}
      <article className={css.doc}>
        <header className={css.docHead}><FileText size={20} aria-hidden="true" /><span><b>Pay policy</b><small>{company}{doc?.version ? ` · version ${doc.published && !docChanged ? doc.version : (doc.version ?? 0) + (doc.published ? 1 : 0)}` : ""}</small></span></header>
        <DocPage body={d.body} />
      </article>
      {p.canEdit && (changes || docChanged) ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={!!busy} onClick={() => void write(false)}>{busy === "save" ? "Saving…" : "Save without publishing"}</button> : null}
    </aside>
  </div>;
}
