"use client";

import { BookUser, Building2, Clapperboard, FileText, FolderKanban, User } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

export type RecentKind = "page" | "project" | "person" | "editor" | "client" | "contact";
export type Recent = Readonly<{ href: string; title: string; kind: RecentKind; at: number }>;

const STORAGE_KEY = "pulse.recents";
const CHANGED = "pulse:recents";
const LIMIT = 8;
const empty: readonly Recent[] = [];
let cache: { raw: string | null; list: readonly Recent[] } = { raw: null, list: empty };

function read(): readonly Recent[] {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(STORAGE_KEY); } catch {}
  if (raw === cache.raw) return cache.list;
  let list: readonly Recent[] = empty;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((r): r is Recent => typeof r?.href === "string" && r.href.startsWith("/") && typeof r?.title === "string" && typeof r?.at === "number").slice(0, LIMIT);
  } catch {}
  cache = { raw, list };
  return list;
}

function write(list: readonly Recent[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(CHANGED));
  } catch {}
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useRecents() {
  return useSyncExternalStore(subscribe, read, () => empty);
}

export function clearRecents() {
  write([]);
}

export function recentIcon(kind: RecentKind) {
  return kind === "project" ? FolderKanban : kind === "person" ? User : kind === "editor" ? Clapperboard : kind === "client" ? Building2 : kind === "contact" ? BookUser : FileText;
}

export function recentAge(at: number) {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Rendered by a page to add itself to the sidebar's Recents. */
export function RecentVisit({ title, kind = "page" }: { title: string; kind?: RecentKind }) {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || pathname === "/") return;
    const rest = read().filter((recent) => recent.href !== pathname);
    write([{ href: pathname, title, kind, at: Date.now() }, ...rest].slice(0, LIMIT));
  }, [pathname, title, kind]);
  return null;
}
