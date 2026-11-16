// UX-WORK (owner, 5 Nov 2026: "there is no UX/UI improvement in anything"): the pieces every Work screen is built from,
// in My day's language (apps/web/app/my-day): a calm in-page header with the day or the place above a large title, stat
// tiles beside it, one obvious primary action; chips with counts to narrow a list; numbered "Start with" picks; cards with
// a left colour stripe; section headings with a count; a quiet right rail; and empty states that say what to do next.
// Server and client components both use them (no hooks here). Phone first: one column at 390, the rail beside from 1024,
// every control at least 44px on touch, focus always shows, colours are the theme's tokens (light and dark).
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import css from "./work-kit.module.css";

export type KitTone = "bad" | "warn" | "good" | "info" | "quiet";
export { css as kit };

/** The page's own header: what and when above a large title, a line of plain context, the key numbers and one primary
 *  action (`primary`); other actions are quiet buttons (`actions`). */
export function WorkHeader({ eyebrow, title, context, stats, primary, actions, back }: {
  eyebrow?: ReactNode; title: string; context?: ReactNode; stats?: StatItem[]; primary?: ReactNode; actions?: ReactNode; back?: { href: string; label: string };
}) {
  return <header className={css.head} data-ux="header">
    <div className={css.headText}>
      {back ? <Link href={back.href} className={css.back}><ChevronLeft size={14} aria-hidden="true" />{back.label}</Link> : null}
      {eyebrow ? <p className={css.eyebrow}>{eyebrow}</p> : null}
      <h2 className={css.title}>{title}</h2>
      {context ? <p className={css.context}>{context}</p> : null}
    </div>
    {stats?.length ? <StatTiles items={stats} label={`${title} at a glance`} /> : null}
    {primary || actions ? <div className={css.headActions}>{actions}{primary}</div> : null}
  </header>;
}

export type StatItem = { label: string; value: ReactNode; tone?: KitTone; href?: string; note?: string };
/** Two to four key numbers, each a tile (a link when it opens the list it counts). */
export function StatTiles({ items, label }: { items: StatItem[]; label: string }) {
  return <dl className={css.stats} aria-label={label} data-count={items.length}>{items.map((s) => <StatTile key={s.label} {...s} />)}</dl>;
}
export function StatTile({ label, value, tone, href, note }: StatItem) {
  const body = <><dt>{label}</dt><dd>{value}</dd>{note ? <dd className={css.statNote}>{note}</dd> : null}</>;
  return href ? <div data-ux="stat" data-tone={tone}><Link href={href} className={css.statLink}>{body}</Link></div> : <div data-ux="stat" data-tone={tone}>{body}</div>;
}

/** The one thing to do on this screen: a solid button (a link, or a button inside a client component via `kit.primary`). */
export function PrimaryLink({ href, children, icon: Icon }: { href: string; children: ReactNode; icon?: LucideIcon }) {
  return <Link href={href} className={css.primary} data-primary="">{Icon ? <Icon size={16} aria-hidden="true" /> : null}{children}</Link>;
}
export function QuietLink({ href, children, icon: Icon }: { href: string; children: ReactNode; icon?: LucideIcon }) {
  return <Link href={href} className={css.quietBtn}>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{children}</Link>;
}

export type Chip = { key: string; label: ReactNode; count?: number; href: string; current?: boolean; tone?: KitTone; hue?: number };
/** Chips that narrow the list, each with its count; the chosen one is pressed. They scroll sideways on a phone. */
export function ChipFilter({ items, label }: { items: Chip[]; label: string }) {
  return <nav className={css.chips} aria-label={label} data-scroll-x="">{items.map((c) => <Link key={c.key} href={c.href} className={css.chip} aria-current={c.current ? "true" : undefined}
    data-tone={c.tone} style={c.hue !== undefined ? { "--kit-hue": c.hue } as CSSProperties : undefined} scroll={false}>
    {c.hue !== undefined || c.tone ? <i className={css.dot} aria-hidden="true" /> : null}{c.label}{c.count !== undefined ? <span className={css.chipCount}>{c.count}</span> : null}
  </Link>)}</nav>;
}

/** A section's heading: an icon, the name, how many, and a quiet link on the right. */
export function SectionHeader({ icon: Icon, title, count, action, tone, as: Tag = "h3" }: { icon?: LucideIcon; title: ReactNode; count?: ReactNode; action?: { href: string; label: string }; tone?: KitTone; as?: "h2" | "h3" }) {
  return <div className={css.sectionHead} data-tone={tone}>
    <Tag className={css.sectionTitle}>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{title}</Tag>
    {count !== undefined && count !== null ? <small className={css.sectionCount}>{count}</small> : null}
    {action ? <Link href={action.href} className={css.sectionAction}>{action.label}</Link> : null}
  </div>;
}

/** A card with a left colour stripe: its tone (late, waiting, done) or a company's hue. */
export function StripeCard({ tone, hue, children, className, as: Tag = "div", label }: { tone?: KitTone; hue?: number; children: ReactNode; className?: string; as?: "div" | "li" | "section" | "article"; label?: string }) {
  return <Tag className={`${css.stripe}${className ? ` ${className}` : ""}`} data-ux="stripe" data-tone={tone} aria-label={label}
    style={hue !== undefined ? { "--kit-hue": hue } as CSSProperties : undefined}>{children}</Tag>;
}

/** A panel of the page: rounded, calm, with a heading. */
export function Card({ children, className, label, area }: { children: ReactNode; className?: string; label?: string; area?: string }) {
  return <section className={`${css.card}${className ? ` ${className}` : ""}`} aria-label={label} data-area={area}>{children}</section>;
}

/** Numbered picks: what to do first, in order. */
export function StartWith({ items, title = "Start with", icon: Icon }: { items: { key: string; title: string; sub?: ReactNode; href: string; tone?: KitTone }[]; title?: string; icon?: LucideIcon }) {
  if (!items.length) return null;
  return <section className={css.card} aria-label={title}>
    <SectionHeader icon={Icon} title={title} />
    <ol className={css.picks}>{items.map((i, n) => <li key={i.key} data-tone={i.tone}>
      <span className={css.pickNo} aria-hidden="true">{n + 1}</span>
      <Link href={i.href} className={css.pickOpen}><b>{i.title}</b>{i.sub ? <small>{i.sub}</small> : null}</Link>
    </li>)}</ol>
  </section>;
}

/** What an empty list says: what goes here and the one thing to do about it. */
export function EmptyState({ icon: Icon, title, text, action, secondary, children }: { icon: LucideIcon; title: string; text?: ReactNode; action?: { href: string; label: string }; secondary?: { href: string; label: string }; children?: ReactNode }) {
  return <div className={css.empty} data-ux="empty">
    <span className={css.emptyIcon}><Icon size={20} aria-hidden="true" /></span>
    <b>{title}</b>
    {text ? <span className={css.emptyText}>{text}</span> : null}
    {action || secondary || children ? <span className={css.emptyActions}>
      {action ? <Link href={action.href} className={css.quietBtn}>{action.label}</Link> : null}
      {secondary ? <Link href={secondary.href} className={css.textLink}>{secondary.label}</Link> : null}{children}
    </span> : null}
  </div>;
}

/** The page body: the work on the left, a quiet rail on the right (under it on a phone). */
export function WorkGrid({ children, rail, railLabel = "More about this" }: { children: ReactNode; rail?: ReactNode; railLabel?: string }) {
  return <div className={css.grid} data-rail={rail ? "" : undefined}>
    <div className={css.main}>{children}</div>
    {rail ? <aside className={css.rail} aria-label={railLabel}>{rail}</aside> : null}
  </div>;
}

/** The page column, as wide as My day's. */
export function WorkPage({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={css.wrap} data-wide={wide ? "" : undefined}>{children}</div>;
}

/** Small facts under a row's title, separated by space; a late one is red. */
export function Facts({ children }: { children: ReactNode }) { return <span className={css.facts}>{children}</span>; }
export function Fact({ children, tone, icon: Icon }: { children: ReactNode; tone?: KitTone; icon?: LucideIcon }) {
  return <span className={css.fact} data-tone={tone}>{Icon ? <Icon size={12} aria-hidden="true" /> : null}{children}</span>;
}
