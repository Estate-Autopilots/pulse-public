"use client";
// CONTRACTS-PRO: a clause's words on screen, read by the same parser as the PDF: bold and defined terms, lettered points,
// tables, notes and filled fields — never raw Markdown ("**", "## ", "- "). Used where a clause is shown on its own
// (the client's link page, with "Ask for a change" on each clause).
import { fillRuns, parseContract, type ContractMeta, type ContractRun } from "@pulse/invoice-doc/browser";
import css from "./sign.module.css";

const Runs = ({ runs }: { runs: ContractRun[] }) => <>{runs.map((r, i) => r.bold ? <strong key={i}>{r.text}</strong> : r.gap ? <mark key={i} className={css.gap}>{r.text}</mark> : <span key={i}>{r.text}</span>)}</>;

export function ContractText({ text, meta, refs = null }: { text: string; meta: ContractMeta | null; refs?: Map<string, { number: string; title: string }> | null }) {
  const { blocks } = parseContract(text);
  return <div className={css.rich}>{blocks.map((b, i) => {
    if (b.kind === "heading") return <h3 key={i} className={css.richHead}>{b.number && !b.number.startsWith("Schedule") ? `${b.number} ` : ""}{b.title}</h3>;
    if (b.kind === "para") return <p key={i} className={b.number ? css.richNum : undefined}>{b.number ? <span className={css.richNo}>{b.number}</span> : null}<Runs runs={fillRuns(b.runs, meta, refs)} /></p>;
    if (b.kind === "item") return <p key={i} className={css.richItem} data-depth={b.depth}><span className={css.richNo}>{b.number}</span><Runs runs={fillRuns(b.runs, meta, refs)} /></p>;
    if (b.kind === "note") return <p key={i} className={css.richNote}><Runs runs={fillRuns(b.runs, meta, refs)} /></p>;
    if (b.kind === "table") return <div key={i} className={css.richTableWrap}><table className={css.richTable}><tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => k === 0
      ? <th key={j} scope="col"><Runs runs={fillRuns(c, meta, refs)} /></th> : <td key={j}><Runs runs={fillRuns(c, meta, refs)} /></td>)}</tr>)}</tbody></table></div>;
    return <hr key={i} />;
  })}</div>;
}
/** "3. Fees" as the PDF numbers it: clauses count in order; Background and Schedules carry no clause number. */
export function clauseHeads(titles: string[]) {
  let n = 0;
  return titles.map((t) => (!t ? "Opening" : /^(background|recitals|whereas)$/i.test(t) || /^(schedule|annexure|annex|appendix)\b/i.test(t) || /^(signatures?|execution)$/i.test(t) ? t : `${++n}. ${t.replace(/^\s*\d{1,2}[.)]?\s*/, "")}`));
}
