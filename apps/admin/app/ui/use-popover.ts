"use client";

/**
 * One small popover: open and close, close on an outside press or Escape
 * (focus returns to the trigger). The person menu and the environment switch
 * share it, so both behave the same.
 */
import { useEffect, useId, useRef, useState } from "react";

export function usePopover<
  Box extends HTMLElement = HTMLDivElement,
  Trigger extends HTMLElement = HTMLButtonElement,
>() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<Box>(null);
  const trigger = useRef<Trigger>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return {
    open,
    setOpen,
    toggle: () => setOpen((value) => !value),
    close: () => setOpen(false),
    panelId,
    box,
    trigger,
  };
}
