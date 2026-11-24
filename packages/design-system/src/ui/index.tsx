"use client";
/* AC design system, tiers 1-2 (owner workbench, 21 Oct 2026): the components every AC app builds pages from.
   No framework inside: an app hands its own link component once (<DsProvider link={Link}>) and every href uses it. */
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import css from "./ds.module.css";

export type Hue = "indigo" | "green" | "sky" | "amber" | "pink" | "teal" | "orange" | "slate";
/** VITALS-DESIGN (19 Nov 2026): the five meanings a state of work can have (tokens.css --tone-*), and the icon sizes
 *  (scale.css --ds-icon-*): xs only inside 12-13px text, sm beside a label, md alone in a control, lg tiles, xl a hero. */
export type Tone = "done" | "info" | "action" | "waiting" | "problem";
export const ICON = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 } as const;
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

export type TabItem = { key: string; label: ReactNode; icon?: ReactNode; count?: number; href?: string;
  /** NEW-DOTS-2: the tab's stable id for "what's new" dots (data-new-anchor; apps/web/app/lib/new-anchors.json). */ anchor?: string;
  /** HR-PEOPLE: what the count means, said on hover ("2 leave requests wait for you"); `badge` names it for the page it
   *  opens, which lights the waiting items on arrival (apps/web/app/lib/badges.mjs). */ title?: string; badge?: string };
/** USER-INSIGHT (22 Nov 2026): what a press on a link tab does. A tab in the URL is a server page, so the old screen
 *  stays until the new one arrives (1-4 s on My desk and Work), and every further press on the same tab restarted that
 *  page, so the screen never changed (production, 18 Nov: 11 presses in 4 s, all dead or angry clicks). Now the pressed
 *  tab is the current one at once, a second press on it does nothing, and a press on another tab goes there. A
 *  modified click (new tab or window) and a press on the open tab keep the browser's and Next's own behaviour. */
export function tabPress(p: { key: string; current: string; chosen: string | null; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }): { follow: boolean; chosen: string | null } {
  if (p.metaKey || p.ctrlKey || p.shiftKey || p.altKey || p.button !== 0) return { follow: true, chosen: p.chosen };
  if (p.key === p.current) return { follow: true, chosen: null };
  if (p.key === p.chosen) return { follow: false, chosen: p.chosen };
  return { follow: true, chosen: p.key };
}
/** A pressed tab whose page never arrives (a redirect, an error page) is not left loading for good. */
const TAB_PENDING_MS = 12_000;

/** Five tabs at most, each with an icon; links when they have `href`, buttons otherwise. */
export function Tabs({ items, current, onSelect, label = "Sections" }: { items: TabItem[]; current: string; onSelect?: (key: string) => void; label?: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [seen, setSeen] = useState(current);
  // The page arrived (or the address changed some other way): the URL's tab is the truth again.
  if (seen !== current) { setSeen(current); setChosen(null); }
  useEffect(() => {
    if (chosen === null) return;
    const t = setTimeout(() => setChosen(null), TAB_PENDING_MS);
    return () => clearTimeout(t);
  }, [chosen]);
  const shown = chosen ?? current;
  // The app positions a gliding indicator on tab rows (fit.tsx: data-glide, --gx, --gw) as soon as it starts, which can
  // be before a streamed row hydrates; as for the app tab rows (ui.tsx), the root ignores those effect-owned attributes.
  return <nav suppressHydrationWarning className={css.tabs} aria-label={label} aria-busy={chosen !== null ? true : undefined}>{items.map((t) => {
    const body = <>{t.icon}{t.label}{t.count ? <span className={css.count}>{t.count}</span> : null}</>;
    const title = t.count ? t.title : undefined, badge = t.count ? t.badge : undefined;
    return t.href ? <Anchor key={t.key} href={t.href} className={css.tab} aria-current={t.key === shown ? "page" : undefined} data-pending={t.key === chosen ? "" : undefined}
        data-new-anchor={t.anchor} title={title} data-badge={badge}
        onClick={(e) => {
          const r = tabPress({ key: t.key, current, chosen, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, button: e.button });
          if (!r.follow) e.preventDefault();
          if (r.chosen !== chosen) setChosen(r.chosen);
        }}>{body}</Anchor>
      : <button key={t.key} type="button" className={css.tab} aria-selected={t.key === current} onClick={() => onSelect?.(t.key)} data-new-anchor={t.anchor} title={title} data-badge={badge}>{body}</button>;
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
