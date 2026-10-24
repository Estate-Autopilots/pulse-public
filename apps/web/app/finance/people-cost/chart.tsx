import type { CSSProperties } from "react";
import { niceMax } from "../../lib/format";
import { rupees } from "../../people/pay/model";
import { mon, monthFull, short, type BudgetRow } from "./model";
import c from "./cost.module.css";

/** People cost month by month against the budget: actual (locked payroll), committed (pay records) and planned (open
 *  roles, offers and changes waiting) stacked, the budget a line across each month; a tip and an aria label per month. */
export function BudgetChart({ rows, label }: { rows: BudgetRow[]; label: string }) {
  const used = (r: BudgetRow) => (r.actual ?? 0) + (r.actual === null ? r.committed + r.planned : 0);
  const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(used(r), r.budget ?? 0))));
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const hasPlanned = rows.some((r) => r.actual === null && r.planned), hasBudget = rows.some((r) => r.budget !== null), hasActual = rows.some((r) => r.actual !== null);
  return <figure className={c.chart} role="group" aria-label={label}>
    <div className={c.legend} aria-hidden="true">
      {hasActual ? <span><i data-s="actual" />Paid (locked payroll)</span> : null}<span><i data-s="committed" />Committed (pay records)</span>
      {hasPlanned ? <span><i data-s="planned" />Planned (roles, offers, changes waiting)</span> : null}{hasBudget ? <span><i data-s="budget" />Budget</span> : null}
    </div>
    <div className={c.plot}>
      {[0, max / 2, max].map((t) => <div key={t} className={c.grid} data-base={t === 0 ? "" : undefined} style={{ bottom: pct(t) }}><span>{t ? short(t) : "₹0"}</span></div>)}
      <div className={c.cols}>{rows.map((r) => {
        const parts = r.actual !== null ? [["actual", r.actual]] as const : [["committed", r.committed], ["planned", r.planned]] as const;
        const total = used(r), over = r.budget !== null && total > r.budget;
        const words = `${monthFull(r.month)}: ${r.actual !== null ? `paid ${rupees(r.actual)}` : `committed ${rupees(r.committed)}${r.planned ? `, planned ${rupees(r.planned)}` : ""}`}${r.budget !== null ? `, budget ${rupees(r.budget)}${over ? `, over by ${rupees(total - r.budget)}` : `, ${rupees(r.budget - total)} left`}` : ", no budget"}`;
        return <span key={r.month} className={c.col} tabIndex={0} aria-label={words}>
          {over ? <span className={c.over} aria-hidden="true">▲</span> : null}
          <span className={c.stack}>{parts.filter(([, v]) => v > 0).map(([k, v]) => <i key={k} className={c.seg} data-s={k} style={{ "--h": `calc(${(v / max) * 190}px - 2px)` } as CSSProperties} />)}</span>
          {r.budget !== null ? <i className={c.budget} style={{ "--b": pct(r.budget) } as CSSProperties} /> : null}
          <span className={c.tip} aria-hidden="true"><b>{monthFull(r.month)}</b>
            {r.actual !== null ? <span>Paid {rupees(r.actual)}</span> : <><span>Committed {rupees(r.committed)}</span>{r.planned ? <span>Planned {rupees(r.planned)}</span> : null}</>}
            <span>{r.budget !== null ? `Budget ${rupees(r.budget)} · ${over ? `over by ${rupees(total - r.budget)}` : `${rupees(r.budget - total)} left`}` : "No budget set"}</span></span>
        </span>;
      })}</div>
    </div>
    <div className={c.axis} aria-hidden="true">{rows.map((r) => <span key={r.month}>{mon(r.month)}</span>)}</div>
  </figure>;
}
