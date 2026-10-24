'use client';
import Link from 'next/link';
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Download, Search } from 'lucide-react';
import { Badge } from '../ui';
import { Modal } from '../records';
import { sortRows, toCsv } from '../lib/finance-view.mjs';
import css from './table.module.css';
import { saveFile } from '../lib/save-file';

type Tone = 'neutral' | 'warning' | 'success' | 'danger' | 'accent';
/** A cell: a plain value, or `v` to sort and export by with `t` to show, a status chip, a link or a quiet second line. */
export type FinCell = string | number | null | undefined | { v: string | number | null; t?: string; tone?: Tone; chip?: boolean; href?: string; sub?: string };
/** `phone`: how the column reads as a card below 760 px — the card's title, its figure, a labelled line, or left out. */
export type FinCol = { key: string; label: string; align?: 'right'; phone?: 'title' | 'value' | 'line' | 'hide'; nosort?: boolean };
export type FinFact = { label: string; value: string; tone?: Tone; href?: string };
export type FinDrawer = { title: string; sub?: string; facts: FinFact[]; text?: string[]; links?: { href: string; label: string }[] };
/** `action`: the row's one primary action (a form button), drawn in its own column and at the foot of a phone card. */
export type FinRow = { id: string; cells: Record<string, FinCell>; tags?: string[]; drawer?: FinDrawer; action?: ReactNode };

/** A phone shows this many cards, then "Show all". */
const PHONE = 8;
const raw = (c: FinCell) => c !== null && typeof c === 'object' ? c.v : c ?? null;
const shown = (c: FinCell) => c !== null && typeof c === 'object' ? c.t ?? (c.v === null ? '' : String(c.v)) : c === null || c === undefined ? '' : String(c);

function Cell({ c }: { c: FinCell }) {
 if (c === null || c === undefined || c === '') return <span className={css.none}>—</span>;
 if (typeof c !== 'object') return <>{c}</>;
 const body = c.chip ? <Badge tone={c.tone}>{shown(c)}</Badge> : shown(c);
 return <>{c.href ? <Link href={c.href} className={css.cellLink}>{body}</Link> : body}{c.sub ? <small className={css.sub}>{c.sub}</small> : null}</>;
}

/** FINANCE-UI table. On a computer: sticky header, sortable columns, row drawer, CSV of what is shown. On a phone:
 *  one card per row (title and figure first, the rest as labelled lines). Exports keep plain numbers. */
export function FinTable({ columns, rows, label, title, sub, csv, sort, filters, search, empty, toolbar, scrollLabel, fill, openLabel, nowrap }: {
 columns: FinCol[]; rows: FinRow[]; label: string; /** A heading drawn inside the card. */ title?: string; sub?: string; /** File name stem of the CSV export. */ csv?: string; sort?: { key: string; dir: 'asc' | 'desc' };
 /** Quick filters over `row.tags`; the first is "everything". */ filters?: { key: string; label: string }[]; search?: boolean; empty?: ReactNode; toolbar?: ReactNode; scrollLabel?: string; /** Take the rest of the page's height on a computer. */ fill?: boolean; /** Queues: the drawer opens from a labelled button (the row's one action) instead of a chevron. */ openLabel?: string; /** Wide registers: cells stay on one line and the table scrolls across. */ nowrap?: boolean;
}) {
 const [all, setAll] = useState(false), [by, setBy] = useState(sort ?? null), [filter, setFilter] = useState(filters?.[0]?.key ?? ''), [query, setQuery] = useState(''), [open, setOpen] = useState<FinRow | null>(null);
 const visible = useMemo(() => {
  const words = query.trim().toLowerCase();
  const kept = rows.filter((r) => (!filter || filter === filters?.[0]?.key || r.tags?.includes(filter)) && (!words || columns.some((c) => shown(r.cells[c.key]).toLowerCase().includes(words))));
  if (!by) return kept;
  const keyed = kept.map((r) => ({ r, k: raw(r.cells[by.key]) }));
  return sortRows(keyed as unknown as Record<string, unknown>[], 'k', by.dir).map((x) => (x as unknown as { r: FinRow }).r);
 }, [rows, columns, by, filter, filters, query]);
 const flip = (key: string) => setBy((b) => b?.key === key ? { key, dir: b.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: columns.find((c) => c.key === key)?.align === 'right' ? 'desc' : 'asc' });
 const exportCsv = () => {
  const text = toCsv(columns.map((c) => ({ key: c.key, label: c.label })), visible.map((r) => Object.fromEntries(columns.map((c) => [c.key, raw(r.cells[c.key])]))));
  void saveFile(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }), `pulse-${csv}-${new Date().toISOString().slice(0, 10)}.csv`);
 };
 const choose = (r: FinRow, e: MouseEvent | KeyboardEvent) => { if (!r.drawer || (e.target as HTMLElement).closest('a,button,input')) return; setOpen(r); };
 const titleKey = columns.find((c) => c.phone === 'title')?.key ?? columns[0]?.key, actions = rows.some((r) => r.action);
 return <div className={css.box} data-fill={fill ? '' : undefined} data-all={all ? '' : undefined}>
  {title || filters || search || csv || toolbar ? <div className={css.tools}>
   {title ? <h3 className={css.title}>{title}{sub ? <small>{sub}</small> : null}</h3> : null}
   {filters ? <div className={css.filters} role="group" aria-label={`Filter ${label}`}>{filters.map((f) => { const n = f.key === filters[0].key ? rows.length : rows.filter((r) => r.tags?.includes(f.key)).length; return <button key={f.key} type="button" className={css.filter} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}<span>{n}</span></button>; })}</div> : null}
   {search ? <label className={css.search}><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${label}`} /></label> : null}
   {toolbar}
   {csv ? <button type="button" className={css.export} data-push={search ? undefined : ''} onClick={exportCsv} disabled={!visible.length}><Download size={14} aria-hidden="true" />CSV</button> : null}
  </div> : null}
  {visible.length ? <div className={css.scroll} tabIndex={0} aria-label={scrollLabel ?? label}>
   <table className={css.table} data-nowrap={nowrap ? '' : undefined}>
    <caption className={css.srOnly}>{label}</caption>
    <thead><tr>{columns.map((c) => <th key={c.key} scope="col" data-align={c.align} aria-sort={by?.key === c.key ? (by.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
     {c.nosort ? c.label : <button type="button" className={css.sort} onClick={() => flip(c.key)}>{c.label}{by?.key === c.key ? (by.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />) : null}</button>}</th>)}
     {actions ? <th scope="col" className={css.actionCol}>Action</th> : null}
     {rows.some((r) => r.drawer) ? <th scope="col" className={openLabel ? css.actionCol : css.openCol}>{openLabel ? 'Action' : <span className={css.srOnly}>Details</span>}</th> : null}</tr></thead>
    <tbody>{visible.map((r, n) => <tr key={r.id} data-open={r.drawer ? '' : undefined} data-more={n >= PHONE ? '' : undefined} onClick={(e) => choose(r, e)}>
     {columns.map((c) => <td key={c.key} data-align={c.align} data-phone={c.phone ?? 'line'}><span className={css.label} aria-hidden="true">{c.label}</span><span className={css.val}><Cell c={r.cells[c.key]} /></span></td>)}
     {actions ? <td className={css.actionCol} data-phone="action">{r.action}</td> : null}
     {r.drawer ? (openLabel ? <td className={css.actionCol} data-phone="action"><button type="button" className={css.primary} aria-label={`${openLabel}: ${shown(r.cells[titleKey])}`} onClick={() => setOpen(r)}>{openLabel}</button></td>
      : <td className={css.openCol} data-phone="open"><button type="button" className={css.open} aria-label={`Details: ${shown(r.cells[titleKey])}`} onClick={() => setOpen(r)}><ChevronRight size={15} aria-hidden="true" /></button></td>) : rows.some((x) => x.drawer) ? <td className={css.openCol} data-phone="open" /> : null}
    </tr>)}</tbody>
   </table>
  </div> : <div className={css.empty}>{rows.length ? 'Nothing matches this filter.' : empty ?? 'Nothing recorded yet.'}</div>}
  {visible.length > PHONE && !all ? <button type="button" className={css.more} onClick={() => setAll(true)}>Show all {visible.length.toLocaleString('en-IN')}</button> : null}
  <p className={css.count}>{visible.length === rows.length ? `${rows.length.toLocaleString('en-IN')} ${rows.length === 1 ? 'row' : 'rows'}` : `${visible.length.toLocaleString('en-IN')} of ${rows.length.toLocaleString('en-IN')} rows`}{rows.some((r) => r.drawer) ? ' · select a row for details' : ''}</p>
  {open?.drawer ? <Modal title={open.drawer.title} sub={open.drawer.sub} scroll onClose={() => setOpen(null)}><div className={css.drawer}>
   <dl className={css.facts}>{open.drawer.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.tone ? <Badge tone={f.tone}>{f.value}</Badge> : f.href ? <Link href={f.href}>{f.value}</Link> : f.value}</dd></div>)}</dl>
   {open.drawer.text?.map((t, i) => <p key={i}>{t}</p>)}
   {open.drawer.links?.length ? <div className={css.links}>{open.drawer.links.map((l) => <Link key={l.href} href={l.href}>{l.label} →</Link>)}</div> : null}
  </div></Modal> : null}
 </div>;
}
