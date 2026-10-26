"use client";
/* AC design system, tiers 1-2 (owner workbench, 21 Oct 2026): the components every AC app builds pages from.
   No framework inside: an app hands its own link component once (<DsProvider link={Link}>) and every href uses it. */
import { createContext, useContext, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import css from "./ds.module.css";

export type Hue = "indigo" | "green" | "sky" | "amber" | "pink" | "teal" | "orange" | "slate";
type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">>;
const Plain: LinkLike = ({ href, children, ...rest }) => <a href={href} {...rest}>{children}</a>;
const LinkContext = createContext<LinkLike>(Plain);

/** Once at the app's root: the app's own link (Next's Link, a router's link); plain <a> without it. */
export function DsProvider({ link, children }: { link: LinkLike; children: ReactNode }) {
  return <LinkContext.Provider value={link}>{children}</LinkContext.Provider>;
}
function Anchor(props: { href: string; className?: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const L = useContext(LinkContext);
  return <L {...props} />;
}
const hueVar = (hue?: Hue) => hue ? { ["--hue" as string]: `var(--ds-hue-${hue})` } : undefined;

type ButtonLook = { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; icon?: ReactNode; iconEnd?: ReactNode };
/** One button for every app: primary (one per view), secondary, ghost, danger. With `href` it is a link. */
export function Button({ variant = "secondary", size = "md", icon, iconEnd, href, children, className, ...rest }: ButtonLook & { href?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = `${css.btn}${className ? ` ${className}` : ""}`;
  const body = <>{icon}{children}{iconEnd}</>;
  return href ? <Anchor href={href} className={cls} data-variant={variant} data-size={size} aria-disabled={rest.disabled || undefined}>{body}</Anchor>
    : <button type="button" className={cls} data-variant={variant} data-size={size} {...rest}>{body}</button>;
}
/** A button that is only an icon: the label is its accessible name and tooltip. */
export function IconButton({ label, icon, variant = "ghost", size = "md", round, href, ...rest }: { label: string; icon: ReactNode; round?: boolean; href?: string } & Omit<ButtonLook, "icon" | "iconEnd"> & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return href ? <Anchor href={href} className={css.btn} data-variant={variant} data-size={size} data-icon-only="" data-round={round ? "" : undefined} aria-label={label} title={label}>{icon}</Anchor>
    : <button type="button" className={css.btn} data-variant={variant} data-size={size} data-icon-only="" data-round={round ? "" : undefined} aria-label={label} title={label} {...rest}>{icon}</button>;
}

/** A category's icon on its tinted squircle; the hue is fixed per category across apps. */
export function IconTile({ icon, hue, size = "md" }: { icon: ReactNode; hue?: Hue; size?: "sm" | "md" | "lg" }) {
  return <span className={css.tile} data-size={size} style={hueVar(hue)} aria-hidden="true">{icon}</span>;
}

/** The surface everything sits on. A title row (icon tile, title, sub, one action) is optional; `href` makes the
 *  whole card a link that lifts on hover. */
export function Card({ title, sub, icon, hue, action, href, tone, pad, children, className, label }: { title?: ReactNode; sub?: ReactNode; icon?: ReactNode; hue?: Hue; action?: ReactNode; href?: string;
  tone?: "plain" | "accent" | "sunken"; pad?: "md" | "lg" | "none"; children?: ReactNode; className?: string; label?: string }) {
  const head = title || action ? <div className={css.cardHead}>{icon ? <IconTile icon={icon} hue={hue} /> : null}
    <span style={{ minWidth: 0, flex: "1 1 auto" }}>{title ? <h3 className={css.cardTitle}>{title}</h3> : null}{sub ? <p className={css.cardSub}>{sub}</p> : null}</span>
    {action ? <span className={css.cardAction}>{action}</span> : null}</div> : null;
  const cls = `${css.card}${className ? ` ${className}` : ""}`;
  const aria = label ?? (typeof title === "string" ? title : undefined);
  return href ? <Anchor href={href} className={cls} data-interactive="" data-tone={tone} data-pad={pad} aria-label={aria}>{head}{children}</Anchor>
    : <section className={cls} data-tone={tone} data-pad={pad} aria-label={aria}>{head}{children}</section>;
}

/** A titled group (a heading, one action, then its cards). */
export function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return <section className={css.section}><div className={css.sectionHead}><h2 className={css.sectionTitle}>{title}</h2>{action}</div>{children}</section>;
}

export type TabItem = { key: string; label: ReactNode; icon?: ReactNode; count?: number; href?: string };
/** Five tabs at most, each with an icon; links when they have `href`, buttons otherwise. */
export function Tabs({ items, current, onSelect, label = "Sections" }: { items: TabItem[]; current: string; onSelect?: (key: string) => void; label?: string }) {
  // The app positions a gliding indicator on tab rows (fit.tsx: data-glide, --gx, --gw) as soon as it starts, which can
  // be before a streamed row hydrates; as for the app tab rows (ui.tsx), the root ignores those effect-owned attributes.
  return <nav suppressHydrationWarning className={css.tabs} aria-label={label}>{items.map((t) => {
    const on = t.key === current;
    const body = <>{t.icon}{t.label}{t.count ? <span className={css.count}>{t.count}</span> : null}</>;
    return t.href ? <Anchor key={t.key} href={t.href} className={css.tab} aria-current={on ? "page" : undefined}>{body}</Anchor>
      : <button key={t.key} type="button" className={css.tab} aria-selected={on} onClick={() => onSelect?.(t.key)}>{body}</button>;
  })}</nav>;
}

/** One figure: value (with a unit), label, and an optional change against a named baseline. */
export function Stat({ value, unit, label, delta }: { value: ReactNode; unit?: ReactNode; label: ReactNode; delta?: { text: string; dir: "up" | "down" | "flat" } }) {
  return <div className={css.stat}><p className={css.statValue}>{value}{unit ? <small>{unit}</small> : null}{delta ? <span className={css.statDelta} data-dir={delta.dir}>{delta.text}</span> : null}</p><p className={css.statLabel}>{label}</p></div>;
}
/** Figures side by side, divided by hairlines. */
export function StatStrip({ children }: { children: ReactNode }) { return <div className={css.strip}>{children}</div>; }

/** A small label; a hue for categories, nothing for neutral. */
export function Tag({ children, hue, icon }: { children: ReactNode; hue?: Hue; icon?: ReactNode }) {
  return <span className={css.tag} style={hueVar(hue)}>{icon}{children}</span>;
}

/** A row in a list: icon, title, sub line, meta on the right; a link, a button or plain. */
export function ListRow({ icon, title, sub, meta, href, onClick, chevron }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; meta?: ReactNode; href?: string; onClick?: () => void; chevron?: boolean }) {
  const body = <>{icon}<span className={css.rowText}><span className={css.rowTitle}>{title}</span>{sub ? <span className={css.rowSub}>{sub}</span> : null}</span>
    {meta ? <span className={css.rowMeta}>{meta}</span> : null}
    {chevron ? <svg className={css.rowChevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg> : null}</>;
  return <li>{href ? <Anchor href={href} className={css.row}>{body}</Anchor> : onClick ? <button type="button" className={css.row} onClick={onClick}>{body}</button> : <div className={css.row}>{body}</div>}</li>;
}
export function List({ children, label }: { children: ReactNode; label?: string }) { return <ul className={css.list} aria-label={label}>{children}</ul>; }

/** Nothing to show, said kindly: an icon tile, a title, one sentence, one action. */
export function EmptyState({ icon, hue = "green", title, children, action, center }: { icon?: ReactNode; hue?: Hue; title: ReactNode; children?: ReactNode; action?: ReactNode; center?: boolean }) {
  return <div className={css.empty} data-layout={center ? "center" : undefined}>{icon ? <IconTile icon={icon} hue={hue} size={center ? "lg" : "md"} /> : null}
    <div className={css.emptyText}><p className={css.emptyTitle}>{title}</p>{children ? <p className={css.emptyBody}>{children}</p> : null}{action ? <div className={css.emptyAction}>{action}</div> : null}</div></div>;
}
