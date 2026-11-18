"use client";
// SPEED-TELEMETRY (14 Nov 2026): a link in a long list (people, tasks, clients). Next prefetches every link that scrolls
// into view. Production telemetry for one company showed ~4,000 prefetch renders a day for ~400 page views, and API calls
// on /people waited 1.0 s (p50) against 0.4 s elsewhere while they ran (slow phone networks share one connection). A row
// prefetches its page when the pointer rests on it, it gets keyboard focus, or a finger touches it, just before the
// click, instead of every row on screen at once.
// SPEED-2 (15 Nov 2026): that prefetch is the whole page with its data ("full"), so the click shows the page at once
// instead of its loading frame; next.config keeps it 60 s.
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";

/** Next's "full" prefetch kind (its PrefetchKind enum is not exported from a public entry point). */
const FULL = { kind: "full" } as unknown as Parameters<ReturnType<typeof useRouter>["prefetch"]>[1];

export function RowLink({ href, onPointerEnter, onFocus, onTouchStart, ...rest }: ComponentProps<typeof Link>) {
  const router = useRouter();
  const target = typeof href === "string" ? href : null;
  const warm = () => { if (target) { try { router.prefetch(target, FULL); } catch { /* a prefetch never breaks the page */ } } };
  return <Link {...rest} href={href} prefetch={false}
    onPointerEnter={(e) => { warm(); onPointerEnter?.(e); }}
    onFocus={(e) => { warm(); onFocus?.(e); }}
    onTouchStart={(e) => { warm(); onTouchStart?.(e); }} />;
}
