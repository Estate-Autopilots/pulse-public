"use client";
import { useSyncExternalStore } from "react";
import css from "./get.module.css";

type Seen = "installed" | "safari" | "other-browser" | "not-iphone";
const noop = () => () => {};
function seen(): Seen {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!apple) return "not-iphone";
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  if (standalone) return "installed";
  return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? "other-browser" : "safari";
}

/** On an iPhone, says where the person is in Add to Home Screen; elsewhere it renders nothing. */
export function IphoneHint() {
  const state = useSyncExternalStore(noop, seen, () => "not-iphone" as Seen);
  if (state === "not-iphone") return null;
  const text = state === "installed" ? "You are using Vitals OS from your Home Screen. You’re all set."
    : state === "other-browser" ? "Open this page in Safari to add Vitals OS to your Home Screen: other browsers on iPhone can’t."
    : "You’re in Safari: tap Share below, then Add to Home Screen.";
  return <p className={css.hint} role="status" data-testid="iphone-hint">{text}</p>;
}
