"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CloudOff, FileText } from "lucide-react";
import { formatAmount, formatDate } from "@pulse/invoice-doc/browser";
import { Badge, Empty, Page, PageHeader, Panel, Skeleton, styles } from "../../ui";
import { STATUS_LABEL } from "../../erp/nav";
import css from "../../erp/erp.module.css";

// EST-1249 staff quote contract. Money is integer INR paise; GST is percentage points.
type SalespersonQuote = {
  id: string; name: string; status: string; validUntil: string | null;
  lines: { name: string; qty: number; rate: number; gstRate: number; total: number }[];
  taxable: number; tax: number; total: number; ownerApprovalNeeded: boolean; canOpenErp: boolean;
};
function subscribeOnline(change: () => void) {
  window.addEventListener("online", change); window.addEventListener("offline", change);
  return () => { window.removeEventListener("online", change); window.removeEventListener("offline", change); };
}
const browserOnline = () => navigator.onLine;
const serverOnline = () => true;

export function Quote({ id }: { id: string }) {
  const online = useSyncExternalStore(subscribeOnline, browserOnline, serverOnline);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ quote?: SalespersonQuote; status?: number } | null>(null);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v0/quotes/${encodeURIComponent(id)}`, {
          cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const quote = response.ok ? await response.json() as SalespersonQuote : undefined;
        if (!controller.signal.aborted) setResult({ quote, status: response.status });
      } catch { if (!controller.signal.aborted) setResult({ status: 0 }); }
    })();
    return () => controller.abort();
  }, [id, attempt, online]);
  const q = result?.quote;
  const retry = () => { setResult(null); setAttempt((n) => n + 1); };
  return <Page><section aria-label="Quotation" className={styles.stack}>
    <PageHeader title="Quotation" recent={false} context={q ? [q.name, `Valid until ${formatDate(q.validUntil)}`] : ["Your quotation, read-only"]} />
    {!online ? <p role="status" className={css.warn}>{q ? "You're offline. This quotation may have changed. Reconnect to refresh." : "You're offline. Reconnect to load this quotation."}</p> : null}
    {q ? <>
      <Panel title="Prepared for" tools={<Badge>{STATUS_LABEL[q.status] ?? q.status}</Badge>}>
        <div className={`${styles.panelBody} ${styles.stack}`}>
          <strong>{q.name}</strong><span>Valid until {formatDate(q.validUntil)}</span>
          {q.ownerApprovalNeeded ? <span><Badge tone="warning">Owner approval needed</Badge></span> : null}
        </div>
      </Panel>
      <Panel title="Items">
        {q.lines.length ? <ol className={css.rows}>{q.lines.map((line, i) => <li key={i}>
          <div className={styles.stack}>
            <strong>{line.name}</strong>
            <dl className={css.facts}>
              <div><dt>Quantity</dt><dd>{line.qty.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</dd></div>
              <div><dt>Rate</dt><dd>₹{formatAmount(line.rate)}</dd></div>
              <div><dt>GST</dt><dd>{line.gstRate}%</dd></div>
              <div><dt>Total</dt><dd>₹{formatAmount(line.total)}</dd></div>
            </dl>
          </div>
        </li>)}</ol> : <Empty icon={FileText} title="No items yet" text="Items will appear here when the quotation is prepared." />}
      </Panel>
      <Panel title="Quotation total"><div className={styles.panelBody}><dl className={css.totals}>
        <dt>Taxable value</dt><dd>₹{formatAmount(q.taxable)}</dd>
        <dt>GST</dt><dd>₹{formatAmount(q.tax)}</dd>
        <dt className={css.grand}>Total including GST</dt><dd className={css.grand}>₹{formatAmount(q.total)}</dd>
      </dl></div></Panel>
      {q.canOpenErp ? <a className={styles.btn} href={`/erp/documents/${encodeURIComponent(q.id)}`}>Open in ERP</a> : null}
    </> : result?.status === 404 ? <Panel title="Quotation unavailable"><Empty icon={FileText} title="This quotation isn't yours or no longer exists." /></Panel>
      : result ? <Panel title="Quotation unavailable"><Empty icon={CloudOff} title="Quotation couldn't load" text="Check your connection and try again.">
        <button type="button" className={styles.btn} disabled={!online} onClick={retry}>Try again</button>
      </Empty></Panel> : online ? <div role="status" aria-label="Loading quotation" aria-busy="true" className={styles.stack}>
        <Skeleton height={100} /><Skeleton height={180} /><Skeleton height={100} />
      </div> : null}
  </section></Page>;
}
