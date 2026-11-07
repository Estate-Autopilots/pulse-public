/* UX-FINANCE (owner, 5 Nov 2026: "there is no UX/UI improvement in anything … many panels are ugly, confusing and
   stupid"): the shared screen kit in the language of Work → My day, so screens stop forking their own styles.
   PageHeader (eyebrow, title, one primary action), StatTiles / StatTile (each figure with where it comes from),
   ChipFilter (chips with counts), SectionHeader, StripeCard (a card with a left colour stripe), StartWith (numbered
   picks), EmptyState (says what to do next), Rail / RailCard (the quiet right column). Server components: no state. */
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { RecentVisit } from '@pulse/ui-shell';
import css from './kit.module.css';
import { Counted } from '../kit/count-up';

export { css as kitStyles };
type Tone = 'neutral' | 'warning' | 'success' | 'danger' | 'accent';

/** The page's own header: a short eyebrow (where and when), the title, one line saying what the page is for, and on
 *  the right the one primary action (mark it with `data-primary`). Below it, optional tiles or chips. */
export function PageHeader({ title, eyebrow, lede, actions, back, children, recent = true }: { title: string; eyebrow?: ReactNode[]; lede?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; children?: ReactNode; /** Remember the page in Recents (as the old header did). */ recent?: boolean }) {
  const bits = (eyebrow ?? []).filter(Boolean);
  return <header className={`${css.kit} ${css.header}`} data-page-header="">
    {recent ? <RecentVisit title={title} /> : null}
    <div className={css.headTop}>
      <div className={css.headText}>
        {back ? <Link href={back.href} className={`${css.back} ${css.focus}`}><ChevronLeft size={14} aria-hidden="true" />{back.label}</Link> : null}
        {bits.length ? <p className={css.eyebrow}>{bits.map((b, i) => <span key={i}>{b}</span>)}</p> : null}
        <h2 className={css.title} data-page-title="">{title}</h2>
        {lede ? <p className={css.lede}>{lede}</p> : null}
      </div>
      {actions ? <div className={css.headActions}>{actions}</div> : null}
    </div>
    {children}
  </header>;
}

/** A row of stat tiles. `label` names the region (tests and screen readers find "Key numbers"). */
export function StatTiles({ children, count, label = 'Key numbers', dense: _dense }: { children: ReactNode; count?: number; label?: string; dense?: boolean }) {
  // The wrapper is the size container: the columns follow the room the tiles have, not the window.
  return <div className={css.tilesWrap}><section className={`${css.kit} ${css.tiles}`} data-cols={count && count !== 4 ? Math.min(6, count) : undefined} aria-label={label}>{children}</section></div>;
}

/** One figure: its name, the value, a short note, and where it comes from. A tile with `href` opens its detail. */
export function StatTile({ label, value, note, source, tone, href, delta, spark, unit }: { label: string; value: ReactNode; note?: ReactNode; source?: ReactNode; tone?: Tone; href?: string; delta?: ReactNode; spark?: ReactNode; unit?: string }) {
  const word = typeof value === 'string' && !/^[−-]?₹|^[\d.,]+%?$|^\d/.test(value);
  return <div className={css.tile} data-tone={tone && tone !== 'neutral' && tone !== 'accent' ? tone : undefined}>
    {href ? <Link href={href} className={css.tileLink} aria-label={`${label}${typeof value === 'string' ? ` ${value}` : ''}: open the detail`} /> : null}
    <p className={css.tileLabel}>{label}</p>
    <p className={css.tileValue}><span className={word ? css.tileWord : undefined} data-figure={typeof value === 'number' || (typeof value === 'string' && !word) ? '' : undefined}>{word ? value : <Counted value={value} />}{unit ? <small> {unit}</small> : null}</span>{delta}</p>
    {spark ? <span className={css.tileSpark}>{spark}</span> : null}
    {note ? <div className={css.tileNote}>{note}</div> : null}
    {source ? <div className={css.tileSource}>{source}</div> : null}
  </div>;
}

export type Chip = { key: string; label: string; href: string; count?: number; tone?: 'warning' | 'danger'; countLabel?: string };
const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-');
/** Chips with counts (My day's company chips): one row that scrolls sideways on a phone and wraps on a computer.
 *  `trailing` (a More button) sits inside the row as its last chip, so it scrolls with the others. */
export function ChipFilter({ label, items, current, size, currentAs = 'page', trailing }: { label: string; items: Chip[]; current: string; size?: 'small'; currentAs?: 'page' | 'true'; trailing?: ReactNode }) {
  const base = `chips-${slug(label)}`;
  return <nav className={`${css.kit} ${css.chips}`} aria-label={label} data-size={size}>
    {/* The link is named by its label alone; the count's words ("10 overdue invoices") are its description, which
        screen readers read after the name. */}
    {items.map((c) => { const say = c.count ? c.countLabel ?? `${c.count} to look at` : null, id = `${base}-${slug(c.key)}`;
      return <Link key={c.key} href={c.href} scroll={false} className={css.chip} aria-current={c.key === current ? currentAs : undefined} title={say ?? undefined} aria-describedby={say ? id : undefined}>
        {c.label}{c.count ? <span className={css.chipCount} data-tone={c.tone} aria-hidden="true">{c.count}</span> : null}
      </Link>; })}
    {items.map((c) => c.count ? <span key={`d-${c.key}`} id={`${base}-${slug(c.key)}`} hidden>{c.countLabel ?? `${c.count} to look at`}</span> : null)}
    {trailing}
  </nav>;
}

export const chipClass = `${css.chip} ${css.chipMore}`;

/** A section's heading: an icon, the title, an optional count, and a quiet link or note on the right. */
export function SectionHeader({ icon: Icon, title, count, aside, level = 3, id }: { icon?: LucideIcon; title: string; count?: ReactNode; aside?: ReactNode; level?: 2 | 3; id?: string }) {
  const H = level === 2 ? 'h2' : 'h3';
  return <div className={css.sectionHead}>
    {Icon ? <Icon size={15} aria-hidden="true" /> : null}
    <H id={id} className={css.sectionTitle}>{title}</H>
    {count !== undefined && count !== null ? <small>{count}</small> : null}
    {aside ? <span className={css.sectionAside}>{aside}</span> : null}
  </div>;
}

export type Stripe = 'in' | 'out' | 'good' | 'warn' | 'bad' | 'neutral' | 'none';
/** A card with a left colour stripe: money in (iris), money out (orange), or a state. Same props as the old Panel. */
export function StripeCard({ title, sub, icon, count, action, tools, stripe = 'neutral', children, className, foot, label, style }: { title?: string; sub?: ReactNode; icon?: LucideIcon; count?: ReactNode; action?: { href: string; label: string }; tools?: ReactNode; stripe?: Stripe; children: ReactNode; className?: string; foot?: ReactNode; label?: string; style?: CSSProperties }) {
  return <section className={`${css.kit} ${css.card}${className ? ` ${className}` : ''}`} data-stripe={stripe} aria-label={label ?? title} style={style}>
    {title ? <SectionHeader icon={icon} title={title} count={count} aside={<>{tools}{action ? <Link href={action.href} className={`${css.cardAction} ${css.focus}`}>{action.label}<ChevronRight size={13} aria-hidden="true" /></Link> : null}</>} /> : null}
    {sub !== undefined && sub !== null && sub !== '' ? <p className={css.cardSub}>{sub}</p> : null}
    <div className={css.cardBody}>{children}</div>
    {foot ? <div className={css.cardFoot}>{foot}</div> : null}
  </section>;
}

export type Pick = { key: string; title: string; sub?: string; href: string; tone?: 'bad' | 'warn' | 'good' };
/** "Start with": what to do first, numbered, most important on top. Nothing to do: nothing shows. */
export function StartWith({ items, title = 'Start with', icon }: { items: Pick[]; title?: string; icon?: LucideIcon }) {
  if (!items.length) return null;
  return <StripeCard title={title} icon={icon} stripe="none" label={title}>
    <ol className={css.picks}>{items.map((p, n) => <li key={p.key} data-tone={p.tone}>
      <span className={css.pickNo} aria-hidden="true">{n + 1}</span>
      <Link href={p.href} className={`${css.pickOpen} ${css.focus}`}><b>{p.title}</b>{p.sub ? <small>{p.sub}</small> : null}</Link>
    </li>)}</ol>
  </StripeCard>;
}

/** Nothing here yet: what this place will hold, and the one thing to do about it. */
export function EmptyState({ icon: Icon, title, text, action, secondary, compact, children }: { icon?: LucideIcon; title: string; text?: ReactNode; action?: { href: string; label: string }; secondary?: { href: string; label: string }; compact?: boolean; children?: ReactNode }) {
  return <div className={`${css.kit} ${css.empty}`} data-compact={compact ? '' : undefined}>
    {Icon ? <Icon size={compact ? 18 : 22} aria-hidden="true" /> : null}
    <b>{title}</b>
    {text ? <p>{text}</p> : null}
    {action || secondary || children ? <div className={css.emptyActions}>
      {action ? <Link href={action.href} className={css.emptyAction} data-primary="">{action.label}</Link> : null}
      {secondary ? <Link href={secondary.href} className={css.emptyAction}>{secondary.label}</Link> : null}
      {children}
    </div> : null}
  </div>;
}

/** The main column and a quiet rail on the right from 1100px (below it on a phone). */
export function WithRail({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  return <div className={css.layout} data-rail={rail ? '' : undefined}><div className={css.main}>{children}</div>{rail ? <aside className={css.rail} aria-label="About these figures">{rail}</aside> : null}</div>;
}

export function RailCard({ title, icon, children }: { title: string; icon?: LucideIcon; children: ReactNode }) {
  return <section className={css.railCard} aria-label={title}><SectionHeader icon={icon} title={title} />{children}</section>;
}

/** Where each figure comes from, as a short list for the rail: one line each, the rest behind "How it is worked out". */
export function SourceList({ items }: { items: { what: string; from: string; note?: string }[] }) {
  return <ul className={css.railList}>{items.map((s) => {
    const all = `${s.from}${s.note ? ` ${s.note}` : ''}`.trim(), cut = all.search(/\.\s/), first = cut > 0 ? all.slice(0, cut + 1) : all, rest = cut > 0 ? all.slice(cut + 1).trim() : '';
    return <li key={s.what}><b>{s.what}</b><span>{first}</span>
      {rest ? <details><summary aria-label={`How it is worked out: ${s.what}`}>How it is worked out</summary><p>{rest}</p></details> : null}</li>;
  })}</ul>;
}

export function RailLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className={css.railLink}>{children}<ChevronRight size={13} aria-hidden="true" /></Link>;
}
