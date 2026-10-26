"use client";
import { useEffect } from "react";

/**
 * E2E-4P (Android Chrome): the on-screen keyboard covered the chat composer and bottom sheets. The viewport meta asks for
 * `interactive-widget=resizes-content` (layout.tsx), so the page itself shrinks above the keyboard; this marks
 * `<html data-keyboard="open">` while a text field has focus and the visible height has dropped, so the bottom tabs and
 * floating helpers (Pip) step aside instead of riding on top of the keyboard. Browsers that only shrink the visual
 * viewport are covered too: `--keyboard-h` is the part of the layout the keyboard hides (0 when resized for us).
 */
const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]):not([type=color]), textarea, select, [contenteditable="true"], [contenteditable=""]';

export function KeyboardWatch() {
  useEffect(() => {
    const root = document.documentElement, vv = window.visualViewport;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    let tallest = { w: 0, h: 0 };
    const check = () => {
      const w = window.innerWidth, h = vv?.height ?? window.innerHeight;
      // The tallest height seen at this width is the keyboard-free height (a rotation starts again).
      if (w !== tallest.w || h > tallest.h) tallest = { w, h: Math.max(h, window.innerHeight) };
      const active = document.activeElement;
      const typing = !!active && active instanceof HTMLElement && active.matches(TEXT);
      const open = typing && h < tallest.h * 0.8;
      if (open) root.dataset.keyboard = "open"; else delete root.dataset.keyboard;
      const hidden = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      root.style.setProperty("--keyboard-h", `${Math.round(hidden)}px`);
    };
    const later = () => requestAnimationFrame(check), left = () => setTimeout(check, 50);
    check();
    vv?.addEventListener("resize", check); window.addEventListener("resize", check);
    document.addEventListener("focusin", later); document.addEventListener("focusout", left);
    return () => {
      vv?.removeEventListener("resize", check); window.removeEventListener("resize", check);
      document.removeEventListener("focusin", later); document.removeEventListener("focusout", left); delete root.dataset.keyboard;
    };
  }, []);
  return null;
}
