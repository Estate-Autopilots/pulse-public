"use client";
// UX-POLISH-2 (owner, 6 Nov 2026: "while scrolling the page only one line is used"): a long list renders a batch and
// grows as you scroll. When this marker comes within a screen of view, the next batch is asked for (the same page with
// a larger `n`, kept in the address so a refresh or a shared link shows as much). The button does the same by hand and
// is what the keyboard and screen readers use; nothing jumps, because the address changes without scrolling.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import css from "./load-more.module.css";

export function LoadMore({ href, shown, total, unit, step }: { href: string; shown: number; total: number; unit: string; step: number }) {
  const router = useRouter();
  const mark = useRef<HTMLDivElement>(null);
  const [busy, start] = useTransition();
  const asked = useRef(false);
  useEffect(() => {
    asked.current = false;
    const el = mark.current; if (!el || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || asked.current) return;
      asked.current = true;
      start(() => router.replace(href, { scroll: false }));
    }, { rootMargin: "0px 0px 800px 0px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [href, router]);
  const next = Math.min(step, total - shown);
  return <div ref={mark} className={css.more} aria-busy={busy || undefined}>
    <span className={css.count}>{shown.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} {unit}</span>
    <Link href={href} scroll={false} replace className={css.button} onClick={() => { asked.current = true; }}>
      {busy ? <LoaderCircle size={14} className={css.spin} aria-hidden="true" /> : null}Show {next.toLocaleString("en-IN")} more
    </Link>
  </div>;
}
