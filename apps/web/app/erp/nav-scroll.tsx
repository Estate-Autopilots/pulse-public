"use client";
import { useEffect } from "react";

/** BILLING: on a phone the chosen section is brought into view in the sideways row. */
export function ScrollCurrent() {
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>("nav[data-billing-sections]"), on = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2;
  }, []);
  return null;
}
