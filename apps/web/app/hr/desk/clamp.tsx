"use client";

import { useEffect, useRef, useState } from "react";
import css from "../desk.module.css";

/** Text held to two lines; "more" appears only when it is longer and opens it in place, "less" folds it again. */
export function Clamp({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false); const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check(); const sizes = new ResizeObserver(check); sizes.observe(el);
    return () => sizes.disconnect();
  }, [open]);
  // A new element on each turn, so a pager around it measures the row again.
  return (
    <div key={open ? "open" : "shut"} className={`${css.clamp}${className ? ` ${className}` : ""}`} data-open={open ? "" : undefined}>
      <p ref={ref}>{text}</p>
      {long || open ? <button type="button" className={css.clampMore} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "less" : "more"}</button> : null}
    </div>
  );
}
