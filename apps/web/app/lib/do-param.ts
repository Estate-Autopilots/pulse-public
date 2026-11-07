"use client";
// UX-5A: `?do=<name>` opens a form or asks a question once the page is there (Ctrl+K's actions: apply for leave, raise a
// request, work on a day off, check in, thank someone). It runs after mount (a dialog opened while rendering from the
// address breaks hydration) and the parameter leaves the address, so a reload or Back does not do it again.
import { useEffect, useRef } from "react";

export function useDoParam(name: string | undefined, run: (params: URLSearchParams) => void) {
  const fn = useRef(run);
  useEffect(() => { fn.current = run; });
  useEffect(() => {
    if (!name) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("do") !== name) return;
    const params = new URLSearchParams(url.searchParams);
    url.searchParams.delete("do"); url.searchParams.delete("mode");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    queueMicrotask(() => fn.current(params));
  }, [name]);
}
