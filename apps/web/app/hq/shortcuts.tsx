"use client";
// PULSE-HQ: keyboard shortcuts across Pulse HQ. "/" focuses the page's search, "n" starts something new on the page
// (a feature, an offer, an idea), "g" then c / l / o / i / b / h goes to the catalogue, licences, offers, ideas, brand or
// the HQ front page, and "?" lists them. Typing in a field never triggers one.
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { useDialog } from "./client";
import css from "./hq.module.css";

const GO: Record<string, [string, string]> = { h: ["/hq", "Pulse HQ"], c: ["/hq/features", "Feature catalogue"], l: ["/hq/licences", "Licences"],
  o: ["/hq/offers", "Offer Studio"], i: ["/hq/ideas", "Ideas"], b: ["/hq/brand", "Brand"], s: ["/stack", "Stack Intelligence"] };

export function Shortcuts({ licences }: { licences: boolean }) {
  const router = useRouter();
  const path = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDialog(open, close);
  const pending = useRef<number>(0);
  const inHq = path.startsWith("/hq") || path.startsWith("/stack");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("dialog[open]") && e.key !== "?") return;
      if (pending.current && Date.now() - pending.current < 1200) {
        pending.current = 0;
        const to = GO[e.key.toLowerCase()];
        if (to && inHq && (licences || to[0] !== "/hq/licences")) { e.preventDefault(); router.push(to[0]); }
        return;
      }
      if (e.key === "/") { const s = document.querySelector<HTMLInputElement>('main input[type="search"]'); if (s) { e.preventDefault(); s.focus(); } }
      // On a page with its own "new" (a sheet's + New, an offer, an idea), n starts that instead of the app-wide new task.
      else if (e.key === "n") { const b = document.querySelector<HTMLElement>("[data-hq-new]"); if (b) { e.preventDefault(); e.stopImmediatePropagation(); b.click(); } }
      else if (e.key === "g" && inHq) pending.current = Date.now();
      else if (e.key === "?") { e.preventDefault(); setOpen(true); }
    };
    // Capture, so the page's own n is decided before the app-wide shortcuts (create.tsx listens on the document).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router, inHq, licences]);
  return <dialog ref={ref} className={`${css.keys} ${css.glassThick}`} aria-label="Keyboard shortcuts">
    {open ? <>
      <div className={css.sheetHead}><Keyboard size={20} aria-hidden="true" /><div><h2>Keyboard shortcuts</h2></div><button type="button" className={css.iconBtn} onClick={close} aria-label="Close"><X size={17} /></button></div>
      <dl className={css.keyList}>
        <div><dt><kbd>/</kbd></dt><dd>Search on this page</dd></div>
        <div><dt><kbd>n</kbd></dt><dd>New row, feature, offer or idea (on its page); paste a list to add many</dd></div>
        <div><dt><kbd>Enter</kbd> <kbd>Tab</kbd></dt><dd>In a sheet: edit a cell, save it, move to the next one</dd></div>
        <div><dt><kbd>Space</kbd> <kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select a row, or every row; then change stage, area or owner at once</dd></div>
        <div><dt><kbd>Alt</kbd> <kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move a row (a board card: <kbd>Alt</kbd> <kbd>←</kbd> <kbd>→</kbd>)</dd></div>
        <div><dt><kbd>Shift</kbd> <kbd>Enter</kbd></dt><dd>Open the row</dd></div>
        <div><dt><kbd>/</kbd> in a long text</dt><dd>Insert a block: heading, bullet, checklist, date, outline</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd></dt><dd>Move through the catalogue table and open a feature</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Close a sheet or cancel an edit</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Save an edit on the brand</dd></div>
        {inHq ? Object.entries(GO).filter(([, [href]]) => licences || href !== "/hq/licences").map(([k, [, label]]) => <div key={k}><dt><kbd>g</kbd> <kbd>{k}</kbd></dt><dd>Go to {label}</dd></div>) : null}
        <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
      </dl>
    </> : null}
  </dialog>;
}
