'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import css from './fin.module.css';

/** A page's own views (at most four, short names) as one segmented row that wraps instead of scrolling. The choice
 *  lives in the URL, so a refresh or a shared link opens the same view. */
export function Switch({ param, items, label, follow }: { param: string; items: { label: string; content: ReactNode }[]; label: string; /** A link that names a view inside item `index` (its own `param`) opens that item. */ follow?: { param: string; index: number } }) {
 const search = useSearchParams(), pathname = usePathname();
 const asked = items.findIndex((x) => x.label === search.get(param));
 const at = asked >= 0 ? asked : follow && search.get(follow.param) ? follow.index : 0;
 const choose = (i: number) => { const q = new URLSearchParams(search.toString()); q.set(param, items[i].label); history.replaceState(null, '', `${pathname}?${q}`); };
 return <div className={css.switch} data-grow="">
  {items.length > 1 ? <div className={css.subtabs} role="tablist" aria-label={label} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const i = (at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length; choose(i); (e.currentTarget.children[i] as HTMLElement | undefined)?.focus(); } }}>
   {items.map((x, i) => <button key={x.label} type="button" role="tab" className={css.subtab} aria-selected={i === at} aria-current={i === at ? 'true' : undefined} tabIndex={i === at ? 0 : -1} onClick={() => choose(i)}>{x.label}</button>)}
  </div> : null}
  {items.map((x, i) => <div key={x.label} role={items.length > 1 ? 'tabpanel' : undefined} aria-label={x.label} hidden={i !== at} className={css.pane}>{x.content}</div>)}
 </div>;
}
