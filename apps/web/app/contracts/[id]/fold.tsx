"use client";
// CONTRACTS-3: a section that folds to its one-line summary on a phone (tap to open) and stays open on a wide screen,
// so the agreement's page stays short where scrolling is costly. The summary says what is inside ("2 of 2 signed").
import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import css from "../contracts.module.css";
import d3 from "./drafts.module.css";

export function Fold({ title, summary, label, children, wide = true }: { title: string; summary?: ReactNode; label?: string; children: ReactNode;
  /** Open on a wide screen (a signed agreement keeps its long words and history folded there too). */ wide?: boolean }) {
  const box = useRef<HTMLDetailsElement>(null);
  // Folded as the page is drawn, so a phone never changes height after it loads (a phone that folded after loading left
  // the page's old height behind); a wide screen opens it once in the browser. The person's taps decide after that.
  useEffect(() => { if (wide && box.current && typeof matchMedia === "function" && !matchMedia("(max-width: 699px)").matches) box.current.open = true; }, [wide]);
  return <details ref={box} className={d3.fold} aria-label={label ?? title}>
    <summary><h2>{title}</h2>{summary ? <span>{summary}</span> : null}<ChevronDown size={18} aria-hidden="true" /></summary>
    <div className={css.section}>{children}</div>
  </details>;
}
