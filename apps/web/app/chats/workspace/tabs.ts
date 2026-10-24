"use client";
// CHAT-SHELL (22 Oct 2026): the side panel's tabs. One small store the panel, the conversation (intent chips, task
// cards), the composer (/open) and any other page read and change. Tabs are kept per person in this browser, so the
// panel comes back as it was left. Anything can ask for a place with openInPanel(); outside the chat workspace (no
// panel on screen) it simply goes there.
import type { Coach } from "../../lib/chat-intent.mjs";
import { panelTarget, type PanelTarget } from "../../lib/panel-target.mjs";

export type PanelTab = PanelTarget & { id: string; at: number; coach?: Coach | null; reason?: string; auto?: boolean };
export type PanelState = { open: boolean; tabs: PanelTab[]; active: string | null; width: number; launcher: boolean };
/** Another lane or page asks for a place: `window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: { href } }))`. */
export const PANEL_EVENT = "pulse:panel";
export type PanelRequest = { href: string; title?: string; coach?: Coach | null; reason?: string; auto?: boolean; background?: boolean };

const MAX_TABS = 8;
export const MIN_W = 340, DEFAULT_W = 460;
const EMPTY: PanelState = { open: false, tabs: [], active: null, width: DEFAULT_W, launcher: false };
let state: PanelState = EMPTY;
let person: string | null = null;
let mounted = 0;
const listeners = new Set<() => void>();
const key = (who: string) => `pulse.panel.v1.${who}`;

function emit(next: PanelState, save = true) {
  state = next;
  if (save && person) {
    // Coach marks and automatic opens are for the moment they happen, not for the next visit.
    const keep = { ...next, launcher: false, tabs: next.tabs.map((t) => ({ ...t, coach: undefined, auto: undefined })) };
    try { window.localStorage.setItem(key(person), JSON.stringify(keep)); } catch { /* storage unavailable */ }
  }
  listeners.forEach((l) => l());
}

export function subscribePanel(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export const panelState = () => state;
export const serverPanelState = () => EMPTY;

/** Load this person's tabs (once per person) and note that a panel is on screen. Returns the unmount. */
export function bindPanel(viewer: string) {
  mounted++;
  if (person !== viewer) {
    person = viewer;
    let saved: Partial<PanelState> | null = null;
    try { saved = JSON.parse(window.localStorage.getItem(key(viewer)) ?? "null"); } catch { saved = null; }
    const origin = window.location.origin;
    // Re-derive each saved tab from its address, so a tab saved by an older Pulse still opens the right way.
    const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : []).flatMap((t) => {
      const fresh = panelTarget(t?.href, origin); return fresh ? [{ ...fresh, id: String(t.id ?? fresh.key), title: String(t.title || fresh.title), at: Number(t.at) || Date.now() }] : [];
    }).slice(0, MAX_TABS);
    const width = Math.max(MIN_W, Math.min(1200, Number(saved?.width) || DEFAULT_W));
    emit({ open: !!saved?.open && tabs.length > 0, tabs, active: tabs.some((t) => t.id === saved?.active) ? String(saved!.active) : tabs[0]?.id ?? null, width, launcher: false }, false);
  }
  return () => { mounted = Math.max(0, mounted - 1); };
}

/** Open a place in the panel (a Pulse path, a Google or Drive link, a web address, "file:<id>"). An open tab with the
 *  same address comes to the front instead of opening twice. Without a panel on screen, the place opens on its own. */
export function openInPanel(req: string | PanelRequest): boolean {
  const r: PanelRequest = typeof req === "string" ? { href: req } : req;
  const target = panelTarget(r.href, window.location.origin);
  if (!target) return false;
  if (!mounted) {
    if (target.kind === "page") window.location.assign(target.href); else window.open(target.href, "_blank", "noopener,noreferrer");
    return true;
  }
  const same = state.tabs.find((t) => t.key === target.key || (t.kind === "page" && target.kind === "page" && t.href.split("?")[0] === target.href.split("?")[0] && t.href.replace(/[?&]go=[^&]*/, "") === target.href.replace(/[?&]go=[^&]*/, "")));
  const tab: PanelTab = { ...target, id: same?.id ?? `${target.key}#${Date.now().toString(36)}`, title: r.title || same?.title || target.title, at: Date.now(), coach: r.coach ?? null, reason: r.reason, auto: r.auto };
  const others = state.tabs.filter((t) => t.id !== tab.id);
  const tabs = same ? state.tabs.map((t) => t.id === tab.id ? tab : t) : [...others, tab].slice(-MAX_TABS);
  emit({ ...state, open: r.background ? state.open : true, tabs, active: r.background && state.active ? state.active : tab.id, launcher: false });
  return true;
}

export function closeTab(id: string) {
  const at = state.tabs.findIndex((t) => t.id === id); if (at < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const active = state.active === id ? (tabs[at] ?? tabs[at - 1])?.id ?? null : state.active;
  emit({ ...state, tabs, active, open: tabs.length ? state.open : state.launcher && state.open });
}
export function activateTab(id: string) { if (state.tabs.some((t) => t.id === id)) emit({ ...state, active: id, launcher: false, open: true }); }
/** The page inside a tab moved on (a link clicked in it): remember where it is now and what it is called. */
export function updateTab(id: string, patch: Partial<Pick<PanelTab, "href" | "title" | "coach">>) {
  const t = state.tabs.find((x) => x.id === id); if (!t) return;
  if ((patch.href === undefined || patch.href === t.href) && (patch.title === undefined || patch.title === t.title) && patch.coach === undefined) return;
  emit({ ...state, tabs: state.tabs.map((x) => x.id === id ? { ...x, ...patch } : x) }, patch.coach === undefined);
}
export function moveTab(id: string, to: number) {
  const from = state.tabs.findIndex((t) => t.id === id); if (from < 0 || from === to) return;
  const tabs = [...state.tabs]; const [t] = tabs.splice(from, 1); tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, t);
  emit({ ...state, tabs });
}
export function setPanelOpen(open: boolean) { emit({ ...state, open, launcher: open && !state.tabs.length ? true : open ? state.launcher : false }); }
export function togglePanel() { setPanelOpen(!state.open); }
export function showLauncher(on = true) { emit({ ...state, open: true, launcher: on }); }
export function setPanelWidth(width: number, save = true) { emit({ ...state, width: Math.round(Math.max(MIN_W, Math.min(1200, width))) }, save); }
