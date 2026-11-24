"use client";
// UX-DELIGHT (6 Nov 2026): the error pattern for every form that shows its error in words (Drawer footers, the Save
// bar): when an error appears, the first invalid field (else the error line itself) shakes once and glows red. The
// words stay the form's own; with reduced motion it only glows (lib/motion.ts).
import { useEffect, useRef } from "react";
import { shake } from "../lib/motion";

export function useShakeOnError<T extends HTMLElement>(error: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!error || !ref.current) return;
    const scope = ref.current.closest("form, [role=dialog], section") ?? ref.current.parentElement;
    const bad = scope?.querySelector<HTMLElement>("[aria-invalid=\"true\"], input:invalid, select:invalid, textarea:invalid");
    shake(bad ?? ref.current);
  }, [error]);
  return ref;
}
