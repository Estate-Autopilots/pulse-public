'use client';
// CA-ACCESS (owner, 8 Nov 2026: "CA desk is absolutely pathetic … make it a much cleaner one"): the CA's place inside
// Finance, built from Codex concept C ("Calm list", reports/ca-access/concepts/ca-view-c.png) with concept 4's phone
// cards. One month at a time: the month-close steps (GSTR-1, GSTR-3B, TDS, bank), the bills and invoices To verify /
// Asked / Verified, and one bill's panel: its PDF, its numbers, Verified or Ask, and the thread with the owner. The
// owner sees the same page: what the CA checked, the questions to answer, and who has CA access.
import Link from 'next/link';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronDown, CircleHelp, Download, FileText, MessageCircle, RotateCcw, Send, X } from 'lucide-react';
import { post } from '../../records';
import { SelectField } from '../../kit/select-field';
import { Menu } from '../../kit/menu';
import { styles } from '../../ui';
import { inr } from '../../lib/finance-view.mjs';
import css from './ca.module.css';

export type Rec = { kind: string; key: string; body: Record<string, unknown>; at?: string };
export type DocCheck = { key: string; status: 'verified' | 'asked'; by: string | null; at: string };
export type Note = { id: string; key: string; by: string | null; mine: boolean; ca: boolean; body: string; at: string };
export type Tick = { month: string; item: string; by: string | null; at: string };
export type DeskData = { records: Rec[]; files: { key: string; name: string; mime: string }[]; checks?: DocCheck[]; notes?: Note[]; ticks?: Tick[];
  synthetic: boolean; accountant: boolean; canManage: boolean; company: string };
type Thread = { key: string; check: DocCheck | null; notes: Note[] };

const KIND: Record<string, string> = { purchase: 'Purchase bill', sales: 'Sales invoice', reimbursement: 'Receipt' };
const TABS = [['open', 'To verify'], ['asked', 'Asked'], ['verified', 'Verified']] as const;
type Tab = (typeof TABS)[number][0];
const STEPS = [
  { item: 'gstr1', label: 'GSTR-1', due: 11 },
  { item: 'gstr3b', label: 'GSTR-3B', due: 20 },
  { item: 'tds', label: 'TDS paid', due: 7 },
  { item: 'bank', label: 'Match bank lines', due: 0 },
] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string) => `${LONG[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;
const day = (d: string) => /^\d{4}-\d{2}-\d{2}/.test(d) ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '';
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); };
/** The month after `m` (YYYY-MM), for a return's due date. */
const nextMonth = (m: string) => { const y = Number(m.slice(0, 4)), n = Number(m.slice(5, 7)); return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`; };
const text = (x: unknown) => x === null || x === undefined ? '' : String(x);
const money = (x: unknown, cur: unknown) => { const n = Number(x); return x === null || x === undefined || x === '' || !Number.isFinite(n) ? '' : inr(n, text(cur) || 'INR'); };
const docDate = (r: Rec) => /^\d{4}-\d{2}-\d{2}/.test(text(r.body.date)) ? text(r.body.date).slice(0, 10) : text(r.at).slice(0, 10);

export function CaDesk({ data, month: asked, today, tools, quarterly = false }: { data: DeskData; month?: string; today: string; /** FIX-PEOPLE-MONEY C3: more actions in the month bar, beside Download (the owner's Your CA). */ tools?: ReactNode;
  /** The company files GST every quarter (QRMP): GSTR-1 and GSTR-3B fall due after the quarter, as Finance Overview says. */ quarterly?: boolean }) {
  const docs = useMemo(() => [...new Map(data.records.filter((r) => r.kind in KIND).map((r) => [r.key, r])).values()]
    .sort((a, b) => docDate(b).localeCompare(docDate(a))), [data.records]);
  const months = useMemo(() => [...new Set([today.slice(0, 7), ...docs.map((d) => docDate(d).slice(0, 7)).filter(Boolean)])].sort().reverse(), [docs, today]);
  // The month a CA closes now is last month; else the newest month with bills.
  const last = months.find((m) => m < today.slice(0, 7) && docs.some((d) => docDate(d).startsWith(m))) ?? months[0];
  const [month, setMonth] = useState(asked && months.includes(asked) ? asked : last);
  const [checks, setChecks] = useState<DocCheck[]>(data.checks ?? []);
  const [notes, setNotes] = useState<Note[]>(data.notes ?? []);
  const [ticks, setTicks] = useState<Tick[]>(data.ticks ?? []);
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = (key: string) => checks.find((c) => c.key === key)?.status ?? null;
  const inMonth = docs.filter((d) => docDate(d).startsWith(month));
  const lists: Record<Tab, Rec[]> = { open: inMonth.filter((d) => !status(d.key)), asked: inMonth.filter((d) => status(d.key) === 'asked'), verified: inMonth.filter((d) => status(d.key) === 'verified') };
  const shown = lists[tab];
  const current = open ? docs.find((d) => d.key === open) ?? null : null;
  const synthetic = data.synthetic;

  const apply = (t: Thread) => {
    setChecks((cs) => [...cs.filter((c) => c.key !== t.key), ...(t.check ? [t.check] : [])]);
    setNotes((ns) => [...ns.filter((n) => n.key !== t.key), ...t.notes]);
  };
  const run = async (work: () => Promise<void>) => { setError(null); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not save. Try again.'); } };
  const mark = (key: string, next: 'verified' | 'asked' | null, note?: string, advance = false) => run(async () => {
    apply(await post<Thread>('finance/desk/check', { key, status: next, note: note ?? '', synthetic }));
    // Verified inside a bill's panel opens the next one waiting, so a CA works down the list; on a card it stays on the list.
    if (next === 'verified' && advance) { const rest = lists.open.filter((d) => d.key !== key); setOpen(rest[0]?.key ?? null); }
  });
  const reply = (key: string, body: string) => run(async () => apply(await post<Thread>('finance/desk/note', { key, body, synthetic })));
  const tick = (item: string, done: boolean) => run(async () => {
    const r = await post<{ ticks: Tick[] }>('finance/desk/close', { month, item, done, synthetic });
    setTicks((ts) => [...ts.filter((t) => t.month !== month), ...r.ticks]);
  });

  const sales = inMonth.filter((d) => d.kind === 'sales'), bills = inMonth.filter((d) => d.kind === 'purchase');
  const checked = (list: Rec[]) => list.filter((d) => status(d.key) === 'verified').length;
  const noGstin = bills.filter((d) => !text(d.body.vendorGSTIN)).length;
  const hint: Record<string, ReactNode> = {
    gstr1: sales.length ? `${checked(sales)} of ${sales.length} sales invoices checked` : 'No sales invoices this month',
    gstr3b: bills.length ? <>{checked(bills)} of {bills.length} bills checked{noGstin ? <span className={css.warnText}>{noGstin === 1 ? '1 bill has' : `${noGstin} bills have`} no GST number</span> : null}</> : 'No purchase bills this month',
    tds: 'Tax held back from vendor and salary payments',
    bank: 'Every bank line matched to the books',
  };
  const canTick = data.accountant || data.canManage;

  return <div className={css.wrap}>
    <div className={css.monthRow}>
      <label className={css.monthPick}><span className={css.monthWord}>Month</span>
        <SelectField size="sm" value={month} onChange={(e) => { setMonth(e.target.value); setOpen(null); }} aria-label="Month">{months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</SelectField></label>
      <p className={css.monthNote}>{lists.open.length ? `${lists.open.length} to check` : inMonth.length ? 'Everything this month is checked' : 'No bills or invoices this month yet'}</p>
      <div className={css.monthTools}><DownloadMenu month={month} synthetic={synthetic} />{tools}</div>
    </div>

    <ol className={css.steps} aria-label={`Month close, ${monthName(month)}`} id="close">
      {STEPS.map((s, i) => { const t = ticks.find((x) => x.month === month && x.item === s.item);
        // Quarterly filers: GSTR-1 by the 13th and GSTR-3B by the 22nd of the month after the quarter (Mar, Jun, Sep, Dec).
        const gst = quarterly && (s.item === 'gstr1' || s.item === 'gstr3b');
        const qEnd = `${month.slice(0, 4)}-${String(Math.ceil(Number(month.slice(5, 7)) / 3) * 3).padStart(2, '0')}`;
        const dueMonth = nextMonth(gst ? qEnd : month).slice(0, 7), dueDay = gst ? (s.item === 'gstr1' ? 13 : 22) : s.due;
        const due = dueDay ? `${dueDay} ${MONTHS[Number(dueMonth.slice(5, 7)) - 1]}` : '';
        const quarter = gst && s.item === 'gstr1' ? `${MONTHS[Number(qEnd.slice(5, 7)) - 3]}–${MONTHS[Number(qEnd.slice(5, 7)) - 1]} quarter · ` : '';
        const late = !t && dueDay ? today > `${dueMonth}-${String(dueDay).padStart(2, '0')}` : false;
        return <li key={s.item} data-done={t ? '' : undefined} data-late={late ? '' : undefined} data-wait={!t && s.item === 'bank' ? '' : undefined}>
          <button type="button" className={css.step} disabled={!canTick} aria-pressed={!!t} onClick={() => void tick(s.item, !t)}
            title={t ? `Done${t.by ? ` by ${t.by}` : ''}. Tap to undo.` : canTick ? 'Tap when it is done' : undefined}>
            <span className={css.stepMark} aria-hidden="true">{t ? <Check size={14} /> : i + 1}</span>
            <span className={css.stepText}><b>{s.label}</b>{due ? <small className={css.stepDue}>{t ? 'Done' : late ? `Late · ${due}${canTick ? ' · tap when done' : ''}` : `${quarter}due ${due}`}</small> : <small className={css.stepDue}>{t ? 'Done' : 'Needs bank statement'}</small>}<small>{t ? `Done${t.by ? ` by ${t.by}` : ''}` : hint[s.item]}</small></span>
          </button>
        </li>; })}
    </ol>

    <div className={css.tabs} role="tablist" aria-label="Bills and invoices">
      {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={css.tab} onClick={() => setTab(k)}>{label}<span>{lists[k].length}</span></button>)}
    </div>

    {error ? <p className={css.error} role="alert">{error}</p> : null}

    <div className={css.body} data-open={current ? '' : undefined}>
      <section className={css.list} aria-label={`${TABS.find(([k]) => k === tab)?.[1]}, ${monthName(month)}`}>
        {shown.length ? <>
          <table className={css.table}>
            <thead><tr><th scope="col">Date</th><th scope="col">Party</th><th scope="col">Type</th><th scope="col">Bill no.</th><th scope="col" className={css.num}>Amount</th>{tab === 'open' ? null : <th scope="col">Status</th>}<th scope="col"><span className={css.srOnly}>Open</span></th></tr></thead>
            <tbody>{shown.map((d) => <tr key={d.key} data-selected={open === d.key ? '' : undefined} onClick={() => setOpen(d.key)}>
              <td>{day(docDate(d))}</td>
              <td><button type="button" className={css.rowOpen} onClick={() => setOpen(d.key)} aria-label={`Open ${text(d.body.vendor) || 'this bill'}`}>{text(d.body.vendor) || '—'}</button></td>
              <td><span className={css.kind} data-kind={d.kind}>{KIND[d.kind]}</span></td>
              <td className={css.mono}>{text(d.body.invoiceNo) || <span className={css.missing}>Not given</span>}</td>
              <td className={css.num}>{money(d.body.total, d.body.currency) || <span className={css.missingChip}>Amount missing</span>}</td>
              {tab === 'open' ? null : <td><StatusChip s={status(d.key)} /></td>}
              <td className={css.openCell}><span aria-hidden="true">{data.accountant ? 'Check' : 'Open'} ›</span></td>
            </tr>)}</tbody>
          </table>
          <ul className={css.cards}>{shown.map((d) => <li key={d.key} className={css.card}>
            <button type="button" className={css.cardOpen} onClick={() => setOpen(d.key)}>
              <span className={css.cardTop}><b>{text(d.body.vendor) || 'Bill'}</b><span className={css.cardAmt}>{money(d.body.total, d.body.currency) || <span className={css.missingChip}>Amount missing</span>}</span></span>
              <span className={css.cardMeta}><span className={css.kind} data-kind={d.kind}>{KIND[d.kind]}</span> {text(d.body.invoiceNo) || 'No bill no.'} · {day(docDate(d))}</span>
            </button>
            {data.accountant && !status(d.key) ? <div className={css.cardActions}>
              <button type="button" className={css.verify} onClick={() => void mark(d.key, 'verified')}><Check size={16} aria-hidden="true" />Verified</button>
              <button type="button" className={css.ask} onClick={() => setOpen(d.key)}><MessageCircle size={16} aria-hidden="true" />Ask</button>
            </div> : tab === 'open' ? null : <div className={css.cardStatus}><StatusChip s={status(d.key)} /></div>}
          </li>)}</ul>
        </> : <p className={css.empty}>{tab === 'open' ? (inMonth.length ? 'Nothing waiting. Every bill this month has an answer.' : 'No bills or invoices for this month yet. They appear here as they reach your finance mail.')
          : tab === 'asked' ? 'No open questions this month.' : 'Nothing verified this month yet.'}</p>}
      </section>

      {current ? <DocPanel key={current.key} doc={current} data={data} check={checks.find((c) => c.key === current.key) ?? null} notes={notes.filter((n) => n.key === current.key)}
        onClose={() => setOpen(null)} onMark={mark} onReply={reply} /> : null}
    </div>
  </div>;
}

function StatusChip({ s }: { s: 'verified' | 'asked' | null }) {
  return <span className={css.chip} data-s={s ?? 'open'}>{s === 'verified' ? 'Verified' : s === 'asked' ? 'Asked' : 'To verify'}</span>;
}

function DocPanel({ doc, data, check, notes, onClose, onMark, onReply }: { doc: Rec; data: DeskData; check: DocCheck | null; notes: Note[]; onClose: () => void;
  onMark: (key: string, s: 'verified' | 'asked' | null, note?: string, advance?: boolean) => Promise<void>; onReply: (key: string, body: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false); const [q, setQ] = useState(''); const [r, setR] = useState(''); const [busy, setBusy] = useState(false);
  const b = doc.body, cur = b.currency;
  const file = data.files.find((f) => f.key === doc.key);
  const fileUrl = file ? `/api/v0/finance/desk/files/${encodeURIComponent(file.key)}?${new URLSearchParams({ ...(data.synthetic ? { pilot: 'synthetic' } : {}), inline: '1' })}` : null;
  const gstin = doc.kind === 'sales' ? text(b.clientGSTIN) : text(b.vendorGSTIN);
  const facts: [string, string][] = ([['Bill no.', text(b.invoiceNo)], [doc.kind === 'sales' ? 'Client GSTIN' : 'Vendor GSTIN', gstin || 'Missing'],
    ...(doc.kind === 'purchase' && b.ourGSTINPresent !== undefined ? [['Our GSTIN on the bill', b.ourGSTINPresent ? 'Yes' : 'No']] : []),
    ['Taxable value', money(b.taxable, cur)], ['CGST', money(b.cgst, cur)], ['SGST', money(b.sgst, cur)], ['IGST', money(b.igst, cur)]] as [string, string][]).filter(([, v]) => v);
  const act = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } finally { setBusy(false); } };
  const ask = (e: FormEvent) => { e.preventDefault(); if (!q.trim()) return; void act(async () => { await onMark(doc.key, 'asked', q.trim()); setQ(''); setAsking(false); }); };
  const send = (e: FormEvent) => { e.preventDefault(); if (!r.trim()) return; void act(async () => { await onReply(doc.key, r.trim()); setR(''); }); };
  return <>
    <div className={css.scrim} onClick={onClose} aria-hidden="true" />
    <aside className={css.panel} aria-label={`${text(b.vendor) || 'Bill'}: details`}>
      <header className={css.panelHead}>
        <div><h2>{text(b.vendor) || 'Bill'}</h2><p>{KIND[doc.kind]} · {day(docDate(doc))}</p></div>
        <button type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
      </header>
      {fileUrl ? <div className={css.preview}>
        {file?.mime === 'application/pdf' ? <object data={fileUrl} type="application/pdf" aria-label={`Preview of ${file.name}`}><a href={fileUrl}>Open the bill</a></object> : null}
        <a className={css.fileLink} href={fileUrl} target="_blank" rel="noreferrer"><FileText size={14} aria-hidden="true" />{file?.name ?? 'Open the bill'}</a>
      </div> : <p className={css.noFile}>No PDF is filed for this one yet.</p>}
      <dl className={css.facts}>{facts.map(([k, v]) => <div key={k} data-warn={v === 'Missing' || v === 'No' ? '' : undefined}><dt>{k}</dt><dd>{v}</dd></div>)}
        <div className={css.total}><dt>Total</dt><dd>{money(b.total, cur) || '—'}</dd></div></dl>

      {data.accountant ? check ? <div className={css.done} data-s={check.status}>
          <span>{check.status === 'verified' ? <Check size={16} aria-hidden="true" /> : <CircleHelp size={16} aria-hidden="true" />}{check.status === 'verified' ? 'You verified this' : 'You asked about this'} · {when(check.at)}</span>
          <span className={css.doneActions}>{check.status === 'asked' ? <button type="button" className={css.verifySmall} disabled={busy} onClick={() => void act(() => onMark(doc.key, 'verified'))}><Check size={14} aria-hidden="true" />Verified</button> : null}
            <button type="button" className={css.undo} disabled={busy} onClick={() => void act(() => onMark(doc.key, null))}><RotateCcw size={14} aria-hidden="true" />Undo</button></span>
        </div>
        : asking ? <form className={css.askForm} onSubmit={ask}>
          <label>What do you want to ask the owner?<textarea value={q} onChange={(e) => setQ(e.target.value)} maxLength={2000} rows={3} autoFocus placeholder="For example: the GSTIN on this bill is missing. Can you send the corrected bill?" /></label>
          <div className={css.row}><button type="button" className={css.quiet} onClick={() => setAsking(false)}>Cancel</button><button className={css.askSend} disabled={busy || !q.trim()}><Send size={14} aria-hidden="true" />Send question</button></div>
        </form>
        : <div className={css.actions}>
          <button type="button" className={css.verify} disabled={busy} onClick={() => void act(() => onMark(doc.key, 'verified', undefined, true))}><Check size={17} aria-hidden="true" />Verified</button>
          <button type="button" className={css.ask} disabled={busy} onClick={() => setAsking(true)}><MessageCircle size={17} aria-hidden="true" />Ask</button>
        </div>
      : <p className={css.ownerState} data-s={check?.status ?? 'open'}>{check?.status === 'verified' ? `Verified by ${check.by ?? 'your CA'} · ${when(check.at)}` : check?.status === 'asked' ? `${check.by ?? 'Your CA'} asked a question. Answer below.` : 'Your CA has not checked this yet.'}</p>}

      <section className={css.thread} aria-label="Comments">
        {notes.length ? <ul>{notes.map((n) => <li key={n.id} data-mine={n.mine ? '' : undefined}><span className={css.who}><b>{n.by ?? 'Someone'}</b>{n.ca ? <em>CA</em> : null}<time>{when(n.at)}</time></span><p>{n.body}</p></li>)}</ul>
          : <p className={css.quietText}>No comments yet.</p>}
        <form className={css.reply} onSubmit={send}><label className={css.srOnly} htmlFor={`reply-${doc.key}`}>Write a reply</label>
          <input id={`reply-${doc.key}`} value={r} onChange={(e) => setR(e.target.value)} maxLength={2000} placeholder={data.accountant ? 'Write to the owner…' : 'Reply to your CA…'} />
          <button disabled={busy || !r.trim()} aria-label="Send"><Send size={16} aria-hidden="true" /></button></form>
      </section>
    </aside>
  </>;
}

/** FIX-PEOPLE-MONEY C3 (owner, 10 Nov 2026: "a Download button at the BOTTOM"): the month's downloads are one menu in
 *  the month bar, at the top beside the month, as plain CSV that opens in Excel; the old registers view is its last line. */
export function DownloadMenu({ month, synthetic }: { month: string; synthetic: boolean }) {
  const q = (extra: Record<string, string>) => `?${new URLSearchParams({ ...extra, ...(synthetic ? { pilot: 'synthetic' } : {}) })}`;
  const go = (href: string) => () => { window.location.assign(href); };
  return <Menu label="Download" className={`${styles.btn} ${styles.btnPrimary} ${css.toolBtn}`} items={[
    { key: 'gst', icon: <Download size={15} aria-hidden="true" />, label: `GST register, ${monthName(month)}`, text: 'GST register', hint: 'Sales and bills, with the checks. Opens in Excel.', onSelect: go(`/api/v0/finance/desk/exports/gst${q({ month })}`) },
    { key: 'tally', icon: <Download size={15} aria-hidden="true" />, label: 'Tally register CSV', hint: 'All registers, for TallyPrime’s import.', onSelect: go(`/api/v0/finance/desk/exports/tally${q({})}`) },
    { key: 'zoho', icon: <Download size={15} aria-hidden="true" />, label: 'Zoho Books CSV', hint: 'The same, for Zoho Books.', onSelect: go(`/api/v0/finance/desk/exports/zoho-books${q({})}`) },
    { key: 'registers', separator: true, icon: <FileText size={15} aria-hidden="true" />, label: 'See all registers', href: `/finance/desk?view=registers${synthetic ? '&pilot=synthetic' : ''}` },
  ]} buttonLabel="Download"><Download size={15} aria-hidden="true" /><span className={css.dlText}>Download</span><ChevronDown size={14} aria-hidden="true" /></Menu>;
}

export function TwoStepNeeded() {
  return <div className={css.gate}><h2>One more step to open the books</h2>
    <p>To keep the company’s books safe, a CA signs in with a second step: a code from an app, a passkey, or a code sent by e-mail.</p>
    <ol><li>Open <b>Account</b> and turn on two-step sign-in.</li><li>Sign out, then sign in again with the second step.</li><li>Come back here. Your bills will be waiting.</li></ol>
    <Link className={css.verify} href="/account">Open Account</Link></div>;
}
