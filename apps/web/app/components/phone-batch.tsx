"use client";
// UI-SWEEP (owner, 10 Nov 2026: "Some pages are too long"): on a phone, a long list shows its first rows and "Show N
// more" instead of every row at once (Clients was 23 screens of cards on a phone, Contacts → identity 26). Opt-in per
// list, and phones only: a computer keeps every row in its scrolling region, as the owner asked on 6 Nov (no paging
// behind arrows). It never pages and never removes a row: hidden rows come back a batch at a time, in place.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "../ui.module.css";
import css from "./phone-batch.module.css";

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
const PHONE = "(max-width: 760px)";

/** Wrap a list (its first `[data-items]`, `tbody`, `ul` or `ol` holds the rows). `step`: rows per batch on a phone.
 *  `after`: what follows the list (a "load more" that fetches as it comes into view): on a phone it waits until every
 *  row already here is shown, so it never fetches while rows are still folded. */
export function PhoneBatch({ children, step = 24, unit = "more", after }: { children: ReactNode; step?: number; unit?: string; after?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(false), [limit, setLimit] = useState(step), [total, setTotal] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia(PHONE), on = () => setPhone(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useIso(() => {
    const rows = box.current?.querySelector(":scope [data-items], :scope tbody, :scope ul, :scope ol")?.children; if (!rows) return;
    setTotal(rows.length);
    Array.from(rows).forEach((el, i) => { (el as HTMLElement).style.display = phone && i >= limit ? "none" : ""; });
  });
  const left = total - limit;
  return <>
    <div ref={box} className={css.box}>{children}</div>
    {phone && left > 0 ? <button type="button" className={`${styles.btn} ${css.more}`} onClick={() => setLimit((n) => n + step)}>
      Show {Math.min(step, left)} {unit} <span className={css.left}>({left} left)</span></button> : null}
    {!phone || left <= 0 ? after : null}
  </>;
}
