'use client';
/* eslint-disable @next/next/no-img-element -- receipts and screenshots are private API pictures (no-store), not static assets for next/image. */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Camera, Check, FileText, History, MessageCircle, Paperclip, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { Modal, post } from '../records';
import { Badge, styles } from '../ui';
import { notify } from '@pulse/ui-shell';
import { KIND_WORDS, rupees, type Entry, type EntryKind, type EntryOptions, type Quick, type WaScreen } from './entry-types';
import css from './entries.module.css';

/* FIN-ENTRY: add, edit and delete finance entries by hand, by one line, or from a WhatsApp payment screenshot. */

const KINDS: EntryKind[] = ['expense', 'income', 'bill', 'refund', 'transfer'];
const today = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const toRupees = (minor: number | null | undefined) => minor ? String(minor / 100) : '';
const toMinor = (s: string) => { const n = Number(String(s).replace(/[,₹\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null; };
const dayName = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
async function getJson<T>(path: string): Promise<T> { const r = await fetch(`/api/v0/${path}`); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? 'Could not load'); return d as T; }

export type Draft = {
 kind: EntryKind; direction: 'in' | 'out' | 'neutral'; amount: string; gst: string; date: string; category: string; accountFrom: string; accountTo: string;
 clientId: string; projectId: string; vendor: string; note: string; billStatus: 'unpaid' | 'paid'; dueDate: string; quickText?: string; whatsapp?: string;
};
const blank = (): Draft => ({ kind: 'expense', direction: 'out', amount: '', gst: '', date: today(), category: '', accountFrom: '', accountTo: '', clientId: '', projectId: '', vendor: '', note: '', billStatus: 'unpaid', dueDate: '' });
export const fromEntry = (e: Entry): Draft => ({ kind: e.kind, direction: e.direction, amount: toRupees(e.amountMinor), gst: toRupees(e.gstMinor), date: e.date, category: e.category ?? '', accountFrom: e.accountFrom ?? '',
 accountTo: e.accountTo ?? '', clientId: e.clientId ?? '', projectId: e.projectId ?? '', vendor: e.vendor ?? '', note: e.note ?? '', billStatus: e.billStatus ?? 'unpaid', dueDate: e.dueDate ?? '' });
export const fromQuick = (q: Quick, text: string): Draft => ({ ...blank(), kind: q.kind, direction: q.direction, amount: toRupees(q.amountMinor), gst: toRupees(q.gstMinor), date: q.date ?? today(), category: q.category ?? '',
 accountFrom: q.accountFrom ?? '', accountTo: q.accountTo ?? '', clientId: q.clientId ?? '', vendor: q.vendor ?? '', note: q.note ?? '', dueDate: q.dueDate ?? '', quickText: text });
const fromScreen = (s: WaScreen): Draft => ({ ...blank(), kind: s.suggestion.kind, direction: s.suggestion.direction, amount: toRupees(s.suggestion.amountMinor), date: s.suggestion.date, category: s.suggestion.category ?? '',
 clientId: s.suggestion.clientId ?? '', vendor: s.suggestion.vendor ?? '', note: s.suggestion.note ?? '', whatsapp: s.sha256 });

/** A photo is made smaller in the browser before it is sent (the long side at 1600 px); a PDF goes as it is. */
async function readFile(file: File): Promise<{ name: string; data: string }> {
 const raw = await new Promise<string>((done, failed) => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.onerror = () => failed(new Error('Could not read the file')); r.readAsDataURL(file); });
 if (!file.type.startsWith('image/') || file.size < 900_000) return { name: file.name, data: raw };
 const img = await new Promise<HTMLImageElement>((done, failed) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => failed(new Error('Could not read the photo')); i.src = raw; });
 const scale = Math.min(1, 1600 / Math.max(img.width, img.height)), canvas = document.createElement('canvas');
 canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
 canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
 return { name: file.name.replace(/\.\w+$/, '') + '.jpg', data: canvas.toDataURL('image/jpeg', 0.82) };
}

const ICON = { in: ArrowDownLeft, out: ArrowUpRight, neutral: ArrowLeftRight } as const;

/** The entry form in the side drawer: new, from a line, from a screenshot, or an existing entry to change. */
export function EntryDrawer({ options, draft: start, entry, screen, onClose, onSaved }: { options: EntryOptions; draft?: Draft; entry?: Entry; screen?: WaScreen; onClose: () => void; onSaved?: (e: Entry) => void }) {
 const router = useRouter();
 const [d, setD] = useState<Draft>(start ?? (entry ? fromEntry(entry) : blank()));
 const [files, setFiles] = useState<{ name: string; data: string }[]>([]), [kept, setKept] = useState(entry?.files ?? []);
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), [reason, setReason] = useState('');
 const [history, setHistory] = useState<{ action: string; at: string; by: string | null; changes: { field: string; from: unknown; to: unknown }[] }[] | null>(null);
 const camera = useRef<HTMLInputElement>(null), picker = useRef<HTMLInputElement>(null);
 const set = (k: keyof Draft, v: string) => setD((x) => ({ ...x, [k]: v }));
 const kind = (k: EntryKind) => setD((x) => ({ ...x, kind: k, direction: k === 'income' ? 'in' : k === 'transfer' ? 'neutral' : k === 'refund' ? (x.direction === 'out' ? 'out' : 'in') : 'out',
  category: x.category || (k === 'income' ? options.settings.categories.find((c) => /client/i.test(c)) ?? '' : '') }));
 const minor = toMinor(d.amount), over = !!minor && minor > options.settings.approvalMinor && !options.canApprove;
 const projects = options.projects.filter((p) => !d.clientId || !p.clientId || p.clientId === d.clientId);
 const clientName = options.clients.find((c) => c.id === d.clientId)?.name ?? '';
 const [typed, setTyped] = useState<string | null>(null), clientText = typed ?? clientName;
 const showFrom = d.kind === 'transfer' || d.direction === 'out', showTo = d.kind === 'transfer' || d.direction === 'in';
 const readOnly = !options.canWrite || !!entry?.deleted;
 useEffect(() => { if (entry) void getJson<{ history: NonNullable<typeof history> }>(`finance/entries/${entry.id}`).then((r) => setHistory(r.history)).catch(() => setHistory([])); }, [entry]);

 async function addFiles(list: FileList | null) {
  if (!list) return;
  try { const read = await Promise.all([...list].slice(0, 4 - files.length - kept.length).map(readFile)); setFiles((x) => [...x, ...read]); } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the file'); }
 }
 async function save(e: FormEvent) {
  e.preventDefault(); setBusy(true); setError('');
  try {
   const body = { ...d, amountMinor: minor, gstMinor: toMinor(d.gst) ?? 0, files: files.length ? files : undefined };
   const saved = await post<Entry>(entry ? `finance/entries/${entry.id}` : 'finance/entries', body);
   for (const f of entry?.files ?? []) if (!kept.some((k) => k.id === f.id)) await post(`finance/entries/files/${f.id}/remove`);
   onSaved?.(saved); router.refresh(); onClose();
   // MODULES-1024: the dialog closed with no word of what happened (J10 asks for a confirmation on every action).
   if (!entry) notify({ id: `fin-entry-${saved.id}`, tone: 'success', title: saved.status === 'pending' ? 'Sent for approval' : 'Entry added', message: `${KIND_WORDS[saved.kind]} · ${rupees(saved.amountMinor)}`, timeout: 4000 });
  } catch (x) { setError(x instanceof Error ? x.message : 'Could not save'); } finally { setBusy(false); }
 }
 async function act(path: string, body: Record<string, unknown> = {}) {
  setBusy(true); setError('');
  try { await post(path, body); router.refresh(); onClose(); } catch (x) { setError(x instanceof Error ? x.message : 'Could not save'); } finally { setBusy(false); }
 }
 const title = entry ? `${KIND_WORDS[entry.kind]} · ${rupees(entry.amountMinor)}` : screen ? 'Confirm as entry' : 'Add entry';
 const sub = entry ? `${dayName(entry.date)} · entered in Pulse${entry.createdBy ? ` by ${entry.createdBy}` : ''}${entry.status === 'pending' ? ' · waiting for approval' : entry.status === 'rejected' ? ' · rejected' : ''}${entry.deleted ? ' · deleted' : ''}`
  : screen ? `Found in WhatsApp${screen.groupTitle ? ` · ${screen.groupTitle}` : ''}` : 'Money that moved, typed in Pulse. It counts in the Finance totals for its month, marked as entered by hand.';
 const foot = <div className={styles.modalFoot}>
  <p role="alert" className={styles.status}>{error}</p>
  {entry && options.canWrite && !entry.deleted ? <button type="button" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Delete</button> : null}
  {entry?.deleted && options.canWrite ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void act(`finance/entries/${entry.id}/restore`)}><RotateCcw size={15} />Restore</button> : null}
  {entry?.status === 'pending' && options.canApprove && !entry.deleted ? <>
   <button type="button" className={styles.btn} disabled={busy} onClick={() => void act(`finance/entries/${entry.id}/decide`, { decision: 'reject' })}><X size={15} />Reject</button>
   <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void act(`finance/entries/${entry.id}/decide`, { decision: 'approve' })}><Check size={15} />Approve</button></> : null}
  <button type="button" className={styles.btn} onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
  {readOnly ? null : <button type="submit" form="fin-entry-form" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !minor}>{busy ? 'Saving…' : entry ? 'Save changes' : over ? 'Send for approval' : 'Save entry'}</button>}
 </div>;
 return <Modal title={title} sub={sub} onClose={onClose} foot={foot} label="Finance entry">
  <form id="fin-entry-form" className={css.form} onSubmit={save}>
   {screen ? <ScreenPreview s={screen} /> : null}
   <fieldset className={css.kinds} disabled={readOnly}><legend className={css.srOnly}>What is it</legend>
    {KINDS.map((k) => <button key={k} type="button" className={css.kind} aria-pressed={d.kind === k} onClick={() => kind(k)}>{KIND_WORDS[k]}</button>)}
   </fieldset>
   {d.kind === 'refund' ? <fieldset className={css.kinds} disabled={readOnly}><legend className={css.srOnly}>Which way</legend>
    <button type="button" className={css.kind} aria-pressed={d.direction === 'in'} onClick={() => set('direction', 'in')}>We got money back</button>
    <button type="button" className={css.kind} aria-pressed={d.direction === 'out'} onClick={() => set('direction', 'out')}>We paid it back</button></fieldset> : null}
   <div className={css.grid}>
    <label className={`${styles.field} ${css.amount}`}>Amount (₹, with GST)<input inputMode="decimal" autoFocus={!entry} required value={d.amount} onChange={(e) => set('amount', e.target.value)} placeholder="5,000" disabled={readOnly} /></label>
    <label className={styles.field}>GST in it (₹)<span className={css.with}><input inputMode="decimal" value={d.gst} onChange={(e) => set('gst', e.target.value)} placeholder="0" disabled={readOnly} />
     {minor && !readOnly ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => set('gst', String(Math.round(minor * 18 / 118) / 100))} title="18% GST inside the amount">18%</button> : null}</span></label>
    <label className={styles.field}>Date<input type="date" required value={d.date} max={today()} onChange={(e) => set('date', e.target.value)} disabled={readOnly} /></label>
    <label className={styles.field}>Category<input list="fin-categories" value={d.category} onChange={(e) => set('category', e.target.value)} placeholder="Choose or type" disabled={readOnly} /></label>
    {showFrom ? <label className={styles.field}>Paid from<input list="fin-accounts" value={d.accountFrom} onChange={(e) => set('accountFrom', e.target.value)} placeholder="Account, card or cash" disabled={readOnly} /></label> : null}
    {showTo ? <label className={styles.field}>{d.kind === 'transfer' ? 'Into' : 'Paid into'}<input list="fin-accounts" value={d.accountTo} onChange={(e) => set('accountTo', e.target.value)} placeholder="Account" disabled={readOnly} /></label> : null}
    {d.kind !== 'transfer' ? <label className={styles.field}>{d.direction === 'in' ? 'From (payer)' : 'Vendor / paid to'}<input value={d.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder={d.direction === 'in' ? 'Who paid' : 'Facebook, landlord, Zoom…'} disabled={readOnly} /></label> : null}
    <label className={styles.field}>Client<input list="fin-clients" value={clientText} disabled={readOnly} placeholder="Optional"
     onChange={(e) => { const hit = options.clients.find((c) => c.name === e.target.value); setTyped(hit ? null : e.target.value); setD((x) => ({ ...x, clientId: hit?.id ?? '', projectId: hit ? x.projectId : '' })); }} /></label>
    <label className={styles.field}>Project<select value={d.projectId} onChange={(e) => set('projectId', e.target.value)} disabled={readOnly}><option value="">None</option>{projects.slice(0, 400).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {d.kind === 'bill' ? <>
     <label className={styles.field}>Bill status<select value={d.billStatus} onChange={(e) => set('billStatus', e.target.value)} disabled={readOnly}><option value="unpaid">Not paid yet</option><option value="paid">Paid</option></select></label>
     <label className={styles.field}>Due<input type="date" value={d.dueDate} onChange={(e) => set('dueDate', e.target.value)} disabled={readOnly} /></label></> : null}
    <label className={`${styles.field} ${css.wide}`}>Note<textarea value={d.note} onChange={(e) => set('note', e.target.value)} placeholder="What it was for" disabled={readOnly} /></label>
   </div>
   <datalist id="fin-categories">{options.settings.categories.map((c) => <option key={c} value={c} />)}</datalist>
   <datalist id="fin-accounts">{options.settings.accounts.map((c) => <option key={c} value={c} />)}</datalist>
   <datalist id="fin-clients">{options.clients.slice(0, 1500).map((c) => <option key={c.id} value={c.name} />)}</datalist>
   <div className={css.receipts}>
    <span className={css.label}>Receipt or screenshot</span>
    <div className={css.files}>
     {kept.map((f) => <span key={f.id} className={css.file}><a href={`/api/v0/finance/entries/files/${f.id}`} target="_blank" rel="noreferrer">{f.mime === 'application/pdf' ? <FileText size={14} /> : <Paperclip size={14} />}{f.name}</a>
      {readOnly ? null : <button type="button" className={styles.iconBtn} aria-label={`Remove ${f.name}`} onClick={() => setKept((x) => x.filter((k) => k.id !== f.id))}><X size={13} /></button>}</span>)}
     {files.map((f, i) => <span key={i} className={css.file}>{f.data.startsWith('data:image') ? <img src={f.data} alt="" className={css.thumbSmall} /> : <FileText size={14} />}{f.name}
      <button type="button" className={styles.iconBtn} aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><X size={13} /></button></span>)}
     {readOnly || files.length + kept.length >= 4 ? null : <>
      <button type="button" className={styles.btn} onClick={() => camera.current?.click()}><Camera size={15} />Take photo</button>
      <button type="button" className={styles.btn} onClick={() => picker.current?.click()}><Paperclip size={15} />Choose file</button></>}
     <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
     <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
    </div>
   </div>
   {over ? <p className={css.notice}>Above {rupees(options.settings.approvalMinor)}: leadership approves it before it counts in the totals.</p> : null}
   {entry?.deleted ? <p className={css.notice}>Deleted{entry.deleteReason ? `: ${entry.deleteReason}` : ''}. It no longer counts anywhere; restore it to bring it back.</p> : null}
   {confirmDelete ? <div className={css.confirm} role="group" aria-label="Delete this entry">
    <label className={styles.field}>Why is it deleted?<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A duplicate, a typo, not company money" /></label>
    <div className={css.row}><button type="button" className={styles.btn} onClick={() => setConfirmDelete(false)}>Keep it</button>
     <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!reason.trim() || busy} onClick={() => void act(`finance/entries/${entry!.id}/delete`, { reason })}>Delete entry</button></div>
   </div> : null}
   {entry ? <section className={css.history} aria-label="History"><h3><History size={14} />History</h3>
    {history === null ? <p className={css.muted}>Loading…</p> : history.map((h, i) => <p key={i}><b>{h.action.replace(/_/g, ' ')}</b> · {h.by ?? 'Pulse'} · {new Date(h.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
     {h.changes.length ? <span className={css.muted}> · {h.changes.map((c) => `${c.field}: ${show(c.from, c.field)} → ${show(c.to, c.field)}`).join('; ')}</span> : null}</p>)}
   </section> : null}
  </form>
 </Modal>;
}
const show = (v: unknown, field: string) => v === null || v === undefined || v === '' ? '—' : /Amount|GST/.test(field) && Number.isFinite(Number(v)) ? rupees(Number(v)) : String(v).slice(0, 40);

function ScreenPreview({ s }: { s: WaScreen }) {
 return <div className={css.screenPreview}>
  {s.hasImage ? <a href={`/api/v0/finance/entries/whatsapp/${s.sha256}/image`} target="_blank" rel="noreferrer"><img src={`/api/v0/finance/entries/whatsapp/${s.sha256}/image`} alt="Payment screenshot from WhatsApp" /></a>
   : <div className={css.noImage}><MessageCircle size={18} />No picture copied yet</div>}
  <div><p><b>{s.amount ? rupees(Math.round(s.amount * 100)) : 'Amount unclear'}</b>{s.payee ? ` · ${s.payee}` : ''}</p>
   <p className={css.muted}>{s.sender ?? 'Someone'}{s.sentAt ? ` · ${new Date(s.sentAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>
   {s.messageText ? <p className={css.muted}>“{s.messageText.slice(0, 140)}”</p> : null}
   {s.transactionIds.length ? <p className={css.muted}>Transaction {s.transactionIds.slice(0, 2).join(', ')}</p> : null}
   {s.driveFileId ? <a className={css.link} href={`https://drive.google.com/file/d/${s.driveFileId}/view`} target="_blank" rel="noreferrer">Open in Drive</a> : null}
   {s.maybeDuplicate ? <p className={css.warn}>An entry with the same amount on {dayName(s.maybeDuplicate.date)} already exists: check it is not the same payment.</p> : null}</div>
 </div>;
}

/** Loads what the form needs, then opens it (the Add entry button on every Finance page). */
function useOptions() {
 const [options, setOptions] = useState<EntryOptions | null>(null), [error, setError] = useState('');
 const load = async () => { if (options) return options; try { const o = await getJson<EntryOptions>('finance/entries/options'); setOptions(o); return o; } catch (e) { setError(e instanceof Error ? e.message : 'Could not load'); return null; } };
 return { options, load, error };
}
export function AddEntryButton({ options: given, label = 'Add entry', start }: { options?: EntryOptions; label?: string; /** READY: the cash book's Money in / Spent open the form with the type chosen. */ start?: Partial<Draft> }) {
 const { options, load, error } = useOptions(), [open, setOpen] = useState(false);
 const o = given ?? options;
 return <>
  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={async () => { if (given || await load()) setOpen(true); }} title={error || undefined}><Plus size={15} />{label}</button>
  {open && o ? <EntryDrawer options={o} draft={start ? { ...blank(), ...start } : undefined} onClose={() => setOpen(false)} /> : null}
 </>;
}

/** One line → the form: "₹5,000 Facebook ads 14 Apr from HDFC". What Pulse understood shows as you type. */
export function QuickAdd({ options }: { options: EntryOptions }) {
 const search = useSearchParams(), pathname = usePathname();
 const [text, setText] = useState(search.get('quick') ?? ''), [latest, setParsed] = useState<Quick | null>(null), [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState('');
 const opened = useRef(false), parsed = text.trim() ? latest : null;
 useEffect(() => {
  if (!text.trim()) return;
  const t = setTimeout(() => { void post<Quick>('finance/entries/parse', { text }).then(setParsed).catch(() => setParsed(null)); }, 250);
  return () => clearTimeout(t);
 }, [text]);
 // A link from Chats (/expense …) opens the form at once with the line filled in.
 useEffect(() => {
  if (opened.current || !search.get('quick') || !parsed) return;
  opened.current = true; setDraft(fromQuick(parsed, text));
  const q = new URLSearchParams(search.toString()); q.delete('quick'); history.replaceState(null, '', `${pathname}?${q}`);
 }, [parsed, search, pathname, text]);
 async function go(e: FormEvent) {
  e.preventDefault(); setError('');
  try { const q = parsed ?? await post<Quick>('finance/entries/parse', { text }); setDraft(fromQuick(q, text)); } catch (x) { setError(x instanceof Error ? x.message : 'Could not read that'); }
 }
 const all: [string, ReactNode][] = parsed ? [
  ['Type', KIND_WORDS[parsed.kind]], ['Amount', parsed.amountMinor ? rupees(parsed.amountMinor) : null], ['GST', parsed.gstMinor ? rupees(parsed.gstMinor) : null],
  ['Date', parsed.date ? dayName(parsed.date) : null], ['Category', parsed.category], ['From', parsed.accountFrom], ['Into', parsed.accountTo], [parsed.direction === 'in' ? 'Payer' : 'Paid to', parsed.vendor], ['Client', parsed.clientName],
 ] : [];
 const chips = all.filter((x) => !!x[1]);
 return <form className={css.quick} onSubmit={go} aria-label="Quick add">
  <Sparkles size={16} aria-hidden="true" className={css.quickIcon} />
  <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type it in one line: ₹5,000 Facebook ads 14 Apr from HDFC" aria-label="Quick add in one line" disabled={!options.canWrite} />
  <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!text.trim() || !options.canWrite}>Review</button>
  {chips.length ? <div className={css.chips} aria-live="polite">{chips.map(([k, v]) => <span key={k} className={css.chip}><small>{k}</small>{v}</span>)}{parsed?.missing.includes('amount') ? <span className={css.chipWarn}>No amount yet</span> : null}</div> : null}
  {error ? <p role="alert" className={css.warn}>{error}</p> : null}
  {draft ? <EntryDrawer options={options} draft={draft} onClose={() => setDraft(null)} onSaved={() => setText('')} /> : null}
 </form>;
}

/** The list: newest first, each row opens the entry (edit, receipts, history, delete). */
export function EntryList({ entries, options }: { entries: Entry[]; options: EntryOptions }) {
 const search = useSearchParams();
 const [picked, setOpen] = useState<Entry | null>(null), [askDone, setAskDone] = useState(false);
 const asked = search.get('entry'), open = picked ?? (!askDone && asked ? entries.find((x) => x.id === asked) ?? null : null);
 const groups = useMemo(() => { const g: { month: string; rows: Entry[] }[] = []; for (const e of entries) { const m = e.date.slice(0, 7); if (g.at(-1)?.month !== m) g.push({ month: m, rows: [] }); g.at(-1)!.rows.push(e); } return g; }, [entries]);
 return <div className={css.list}>
  {groups.map((g) => <section key={g.month} aria-label={g.month}>
   <h3 className={css.month}>{new Date(g.month + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
   {g.rows.map((e) => { const Icon = ICON[e.direction]; return <button type="button" key={e.id} className={css.entry} data-deleted={e.deleted || undefined} onClick={() => setOpen(e)}>
    <span className={css.icon} data-dir={e.direction}><Icon size={17} /></span>
    <span className={css.what}><b>{e.vendor || e.clientName || (e.kind === 'transfer' ? `${e.accountFrom} → ${e.accountTo}` : e.category) || KIND_WORDS[e.kind]}</b>
     <small>{dayName(e.date)} · {KIND_WORDS[e.kind]}{e.category && (e.vendor || e.clientName) ? ` · ${e.category}` : ''}{e.clientName && e.vendor ? ` · ${e.clientName}` : ''}{e.accountFrom && e.kind !== 'transfer' ? ` · from ${e.accountFrom}` : ''}{e.accountTo && e.kind !== 'transfer' ? ` · into ${e.accountTo}` : ''}</small></span>
    <span className={css.tags}>
     {e.status === 'pending' ? <Badge tone="warning">Waiting for approval</Badge> : e.status === 'rejected' ? <Badge tone="danger">Rejected</Badge> : null}
     {e.deleted ? <Badge tone="danger">Deleted</Badge> : null}
     {e.source === 'whatsapp' ? <Badge>From WhatsApp</Badge> : e.source === 'chat' ? <Badge>From Chats</Badge> : null}
     {e.kind === 'bill' ? <Badge tone={e.billStatus === 'paid' ? 'success' : 'warning'}>{e.billStatus === 'paid' ? 'Paid' : e.dueDate ? `Due ${dayName(e.dueDate)}` : 'Not paid'}</Badge> : null}
     {e.files.length ? <Paperclip size={14} aria-label={`${e.files.length} receipt`} /> : null}
    </span>
    <span className={css.money} data-dir={e.direction}>{e.direction === 'in' ? '+' : e.direction === 'out' ? '−' : ''}{rupees(e.amountMinor)}{e.gstMinor ? <small>GST {rupees(e.gstMinor)}</small> : null}</span>
   </button>; })}
  </section>)}
  {open ? <EntryDrawer key={open.id} options={options} entry={open} onClose={() => { setOpen(null); setAskDone(true); }} /> : null}
 </div>;
}

/** Found in WhatsApp: a payment screenshot each, to confirm as an entry or set aside. */
export function WhatsAppCards({ rows, options, show }: { rows: WaScreen[]; options: EntryOptions; show: string }) {
 const router = useRouter();
 const [open, setOpen] = useState<WaScreen | null>(null), [gone, setGone] = useState<Set<string>>(new Set()), [error, setError] = useState('');
 async function dismiss(s: WaScreen, undo = false) {
  setError('');
  try { await post(`finance/entries/whatsapp/${s.sha256}/${undo ? 'undo' : 'dismiss'}`); setGone((x) => new Set(x).add(s.sha256)); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); }
 }
 return <>
  {error ? <p role="alert" className={css.warn}>{error}</p> : null}
  <div className={css.cards}>{rows.filter((s) => !gone.has(s.sha256)).map((s) => <article key={s.sha256} className={css.card}>
   <a className={css.shot} href={s.hasImage ? `/api/v0/finance/entries/whatsapp/${s.sha256}/image` : s.driveFileId ? `https://drive.google.com/file/d/${s.driveFileId}/view` : undefined} target="_blank" rel="noreferrer" aria-label="Open the screenshot">
    {s.hasImage ? <img loading="lazy" src={`/api/v0/finance/entries/whatsapp/${s.sha256}/image`} alt="" /> : <span className={css.noImage}><MessageCircle size={18} />{s.driveFileId ? 'Open in Drive' : 'No picture'}</span>}</a>
   <div className={css.cardBody}>
    <p className={css.cardAmount}>{s.amount ? rupees(Math.round(s.amount * 100)) : '—'}<small>{KIND_WORDS[s.suggestion.kind]}{s.suggestion.category ? ` · ${s.suggestion.category}` : ''}</small></p>
    <p className={css.cardMeta}>{s.suggestion.clientName ?? s.suggestion.client ?? s.groupTitle ?? 'WhatsApp'}</p>
    <p className={css.muted}>{s.sender ?? 'Someone'}{s.sentAt ? ` · ${new Date(s.sentAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}{s.payee ? ` · ${s.payee.slice(0, 40)}` : ''}</p>
    {s.maybeDuplicate ? <p className={css.warn}>Same amount already entered on {dayName(s.maybeDuplicate.date)}</p> : null}
    {show === 'new' && options.canWrite ? <div className={css.row}>
     <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => setOpen(s)}><Check size={14} />Confirm as entry</button>
     <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void dismiss(s)}>Not company money</button></div>
     : show === 'dismissed' && options.canWrite ? <div className={css.row}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void dismiss(s, true)}><RotateCcw size={14} />Bring back</button></div>
     : s.entryId ? <a className={css.link} href={`/finance?tab=entries&entry=${s.entryId}`}>Open the entry</a> : null}
   </div>
  </article>)}</div>
  {open ? <EntryDrawer options={options} draft={fromScreen(open)} screen={open} onClose={() => setOpen(null)} onSaved={() => setGone((x) => new Set(x).add(open.sha256))} /> : null}
 </>;
}

/** Leadership: the approval limit, the categories and the accounts people pick from. */
export function EntrySettingsForm({ options }: { options: EntryOptions }) {
 const router = useRouter(), s = options.settings;
 const [limit, setLimit] = useState(String(s.approvalMinor / 100)), [cats, setCats] = useState(s.categories.join('\n')), [accounts, setAccounts] = useState(s.accounts.join('\n'));
 const [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
 async function save(e: FormEvent) {
  e.preventDefault(); setBusy(true); setMsg('');
  try { await post('finance/entries/settings', { approvalMinor: Math.round(Number(limit.replace(/[,₹\s]/g, '')) * 100), categories: cats, accounts }); setMsg('Saved'); router.refresh(); } catch (x) { setMsg(x instanceof Error ? x.message : 'Could not save'); } finally { setBusy(false); }
 }
 if (!options.canApprove) return <p className={css.muted}>Approvals above {rupees(s.approvalMinor)} go to leadership. Leadership sets the limit, the categories and the accounts.</p>;
 return <form className={css.settings} onSubmit={save}>
  <label className={styles.field}>Entries above this amount need leadership approval (₹)<input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
  <label className={styles.field}>Categories (one a line)<textarea rows={8} value={cats} onChange={(e) => setCats(e.target.value)} /></label>
  <label className={styles.field}>Accounts: banks, cards, cash (one a line)<textarea rows={5} value={accounts} onChange={(e) => setAccounts(e.target.value)} /></label>
  <div className={css.row}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button><span role="status" className={css.muted}>{msg}</span></div>
 </form>;
}
