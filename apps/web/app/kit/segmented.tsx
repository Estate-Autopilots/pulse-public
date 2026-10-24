"use client";
// TASKS-4A kit: the segmented control. One choice out of a few, drawn as a track with a sliding thumb. As buttons it is
// a radio group (arrow keys move and choose, Home/End jump, one tab stop); as links (`SegmentedNav`) it is a nav whose
// current item carries aria-current, for choices that live in the URL. Icon-only items get their label as a tooltip.
import Link from "next/link";
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip } from "./popover";
import css from "./kit.module.css";

export type SegmentOption<T extends string> = { value: T; label: string; icon?: LucideIcon; count?: number | string; hint?: string; disabled?: boolean };
type Size = "sm" | "md" | "lg";

/** Slides the thumb under the chosen item (the scroll position follows on narrow screens). */
function useThumb(root: React.RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const el = root.current; if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>('[aria-checked="true"],[aria-current="page"],[aria-current="true"]'), thumb = el.querySelector<HTMLElement>("[data-thumb]");
      if (!thumb) return;
      if (!on) { el.removeAttribute("data-ready"); return; }
      thumb.style.width = `${on.offsetWidth}px`; thumb.style.transform = `translateX(${on.offsetLeft}px)`;
      if (!el.hasAttribute("data-ready")) requestAnimationFrame(() => el.setAttribute("data-ready", ""));
      if (on.offsetLeft < el.scrollLeft || on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollTo({ left: on.offsetLeft - 24, behavior: "smooth" });
    };
    place();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null; ro?.observe(el);
    document.fonts?.ready.then(place).catch(() => undefined);
    return () => ro?.disconnect();
  }, [root, key]);
}

function Item({ icon: Icon, label, count, iconOnly }: { icon?: LucideIcon; label: string; count?: number | string; iconOnly?: boolean }) {
  return <>{Icon ? <Icon size={15} aria-hidden="true" /> : null}{iconOnly ? <span className={css.srOnly}>{label}</span> : label}{count !== undefined && !iconOnly ? <span className={css.segCount}>{count}</span> : null}</>;
}

export function Segmented<T extends string>({ value, onChange, options, label, size = "md", iconOnly, fill, className }: {
  value: T; onChange: (v: T) => void; options: SegmentOption<T>[]; label: string; size?: Size; iconOnly?: boolean; fill?: boolean; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useThumb(root, `${value}:${options.map((o) => o.value).join()}`);
  const enabled = options.filter((o) => !o.disabled);
  const move = (e: KeyboardEvent, from: T) => {
    const i = enabled.findIndex((o) => o.value === from);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? enabled[(i + 1) % enabled.length] : e.key === "ArrowLeft" || e.key === "ArrowUp" ? enabled[(i - 1 + enabled.length) % enabled.length]
      : e.key === "Home" ? enabled[0] : e.key === "End" ? enabled.at(-1) : null;
    if (!next) return;
    e.preventDefault(); onChange(next.value);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus());
  };
  return <div ref={root} role="radiogroup" aria-label={label} className={`${css.seg}${className ? ` ${className}` : ""}`} data-size={size} data-icons={iconOnly ? "" : undefined} data-fill={fill ? "" : undefined}>
    <span className={css.segThumb} data-thumb="" aria-hidden="true" />
    {options.map((o) => {
      const on = o.value === value;
      const button = <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on || (!options.some((x) => x.value === value) && o === enabled[0]) ? 0 : -1} data-value={o.value}
        className={css.segItem} disabled={o.disabled} onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, o.value)}><Item icon={o.icon} label={o.label} count={o.count} iconOnly={iconOnly} /></button>;
      return iconOnly || o.hint ? <Tooltip key={o.value} content={o.hint ?? o.label} side="bottom">{button}</Tooltip> : button;
    })}
  </div>;
}

/** `icon` is an element (`<ListChecks size={15} />`), so server pages can pass it. */
export type SegmentLink = { key: string; href: string; label: string; icon?: ReactNode; count?: number | string; current?: boolean; hint?: string };
/** The same control for choices kept in the URL: links, the current one marked aria-current. */
export function SegmentedNav({ items, label, size = "md", iconOnly, className, scroll = false, extra }: { items: SegmentLink[]; label: string; size?: Size; iconOnly?: boolean; className?: string; scroll?: boolean; extra?: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useThumb(root, items.map((i) => `${i.key}${i.current ? "*" : ""}`).join());
  return <nav ref={root} aria-label={label} className={`${css.seg}${className ? ` ${className}` : ""}`} data-size={size} data-icons={iconOnly ? "" : undefined}>
    <span className={css.segThumb} data-thumb="" aria-hidden="true" />
    {items.map((i) => {
      const link = <Link key={i.key} href={i.href} scroll={scroll} className={css.segItem} aria-current={i.current ? "page" : undefined}>{i.icon ?? null}<Item label={i.label} count={i.count} iconOnly={iconOnly} /></Link>;
      return iconOnly || i.hint ? <Tooltip key={i.key} content={i.hint ?? i.label} side="bottom">{link}</Tooltip> : link;
    })}
    {extra}
  </nav>;
}
