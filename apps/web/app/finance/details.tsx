'use client';
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Modal } from '../records';
import css from './fin.module.css';

/** A quiet "Details" link: the paragraph behind a figure opens in the side drawer, never on the page itself. */
export function Details({ label = 'Details', name, title, sub, children }: { label?: string; /** A name that says which figure, where several share one label. */ name?: string; title: string; sub?: string; children: ReactNode }) {
 const [open, setOpen] = useState(false);
 return <>
  <button type="button" className={css.detailsLink} aria-haspopup="dialog" aria-label={name} onClick={() => setOpen(true)}>{label}<ChevronRight size={13} aria-hidden="true" /></button>
  {open ? <Modal title={title} sub={sub} scroll onClose={() => setOpen(false)}><div className={css.drawerBody}>{children}</div></Modal> : null}
 </>;
}
