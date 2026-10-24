"use client";
// CHAT-SHELL (22 Oct 2026): the panel on the chat's right, like the Codex and Claude desktop apps. Tabs open any Pulse
// page (the page itself, framed without the rail and the top bar), a Google Doc, Sheet or Slides deck, a Drive file or
// folder (Google's own preview where Google allows it), a chat file or any web address (framed when the site allows
// it, else a clean card that opens it in a new tab). Drag the left edge to resize (the keyboard's arrows on it too),
// Ctrl+. to show or hide it; on a phone it is a sheet from the bottom. A tab can be dragged into the message box to
// attach it. When a tab carries a coach (from intent detection), Pip points at the exact control inside the page.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ArrowLeft, CalendarCheck, CircleCheck, Copy, ExternalLink, File as FileIcon, FileText, Folder, FolderKanban, Globe, HardDrive, LayoutGrid, ListChecks, Maximize2, PanelRightClose, Plus, RotateCw, Search, Sparkles, User, Users, Wallet, Workflow, X } from "lucide-react";
import { openablePlaces } from "../../lib/chat-intent.mjs";
import { panelTarget, stripEmbed, type PanelKind } from "../../lib/panel-target.mjs";
import { DEFAULT_W, MIN_W, PANEL_EVENT, activateTab, bindPanel, closeTab, moveTab, openInPanel, panelState, serverPanelState, setPanelOpen, setPanelWidth, showLauncher, subscribePanel, togglePanel, updateTab, type PanelRequest, type PanelTab } from "./tabs";
import css from "./panel.module.css";
import { roomBeside, useChatAside } from "../aside";

const PHONE = "(max-width: 899.98px)";
const never = () => () => {};
const onPhoneChange = (done: () => void) => { const m = window.matchMedia(PHONE); m.addEventListener("change", done); return () => m.removeEventListener("change", done); };
const KEEP_ALIVE = 5;
const REF_TYPE = "application/x-pulse-ref";
const ICON: Record<PanelKind, typeof Globe> = { page: LayoutGrid, gdoc: FileText, "drive-file": HardDrive, "drive-folder": Folder, file: FileIcon, url: Globe };
const absolute = (href: string) => { try { return new URL(href, window.location.origin).href; } catch { return href; } };

/** What a person drags out of the panel: a link the message box attaches. */
export function dragRef(e: DragEvent, name: string, href: string) {
  const url = absolute(href);
  e.dataTransfer.setData(REF_TYPE, JSON.stringify({ name, url }));
  e.dataTransfer.setData("text/uri-list", url);
  e.dataTransfer.setData("text/plain", url);
  e.dataTransfer.effectAllowed = "copyLink";
}
/** The link a drop carries (a tab from the panel, a link dragged from a page or from Drive's folder view), if any. */
export function droppedRef(dt: DataTransfer): { name: string; url: string } | null {
  try { const ref = JSON.parse(dt.getData(REF_TYPE) || "null"); if (ref?.url) return { name: String(ref.name || ref.url).slice(0, 200), url: String(ref.url) }; } catch { /* not ours */ }
  const uri = dt.getData("text/uri-list").split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
  if (uri && /^https?:\/\//i.test(uri)) { const t = panelTarget(uri, window.location.origin); return { name: t?.kind === "page" ? t.title : (t?.title && t.kind !== "url" ? t.title : uri.replace(/^https?:\/\/(www\.)?/, "").slice(0, 120)), url: uri }; }
  return null;
}

export function usePanel() { return useSyncExternalStore(subscribePanel, panelState, serverPanelState); }

/** The panel. `viewer` keys the saved tabs; `role` and `modulesOff` decide which places the launcher offers. */
export function ContextPanel({ viewer, role, modulesOff }: { viewer: string; role?: string; modulesOff?: readonly string[] }) {
  const s = usePanel();
  const phone = useSyncExternalStore(onPhoneChange, () => window.matchMedia(PHONE).matches, () => false);
  const [resizing, setResizing] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => bindPanel(viewer), [viewer]);
  // Anyone can ask for a place (CHAT-WORK's task cards, a page's own button): window "pulse:panel" with { href }.
  useEffect(() => {
    const ask = (e: Event) => { const d = (e as CustomEvent<PanelRequest>).detail; if (d?.href && openInPanel(d)) e.preventDefault(); };
    const keys = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === ".") { e.preventDefault(); togglePanel(); } else if (e.key === "Escape" && panelState().open && window.matchMedia(PHONE).matches) setPanelOpen(false); };
    window.addEventListener(PANEL_EVENT, ask); window.addEventListener("keydown", keys);
    return () => { window.removeEventListener(PANEL_EVENT, ask); window.removeEventListener("keydown", keys); };
  }, []);
  // The workspace's layout reads whether the panel is open and how wide (the chat list narrows beside it).
  useEffect(() => {
    const root = document.documentElement;
    if (s.open) { root.dataset.panel = phone ? "sheet" : "open"; root.style.setProperty("--chat-panel-w", `${s.width}px`); } else { delete root.dataset.panel; root.style.removeProperty("--chat-panel-w"); }
    return () => { delete root.dataset.panel; root.style.removeProperty("--chat-panel-w"); };
  }, [s.open, s.width, phone]);
  // A tab's page stays loaded after it was shown (switching back is instant), the most recent few only.
  const alive = useMemo(() => {
    const ids = new Set([...seen, ...(s.active ? [s.active] : [])]);
    return s.tabs.filter((t) => ids.has(t.id)).sort((a, b) => (b.id === s.active ? 1 : 0) - (a.id === s.active ? 1 : 0) || b.at - a.at).slice(0, KEEP_ALIVE).map((t) => t.id);
  }, [seen, s.active, s.tabs]);
  useEffect(() => { if (s.active && !seen.includes(s.active)) queueMicrotask(() => setSeen((x) => [...x.filter((id) => s.tabs.some((t) => t.id === id)), s.active!])); }, [s.active, s.tabs, seen]);

  const start = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: s.width }; setResizing(true); };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => { const st = start.current; if (!st) return; setPanelWidth(Math.min(window.innerWidth * 0.66, st.w + st.x - e.clientX), false); };
  const onUp = () => { if (!start.current) return; start.current = null; setResizing(false); setPanelWidth(panelState().width); };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setPanelWidth(Math.min(window.innerWidth * 0.66, s.width + (e.key === "ArrowLeft" ? 32 : -32))); }
    else if (e.key === "Home" || e.key === "Enter") { e.preventDefault(); setPanelWidth(DEFAULT_W); }
  };
  const sheetDrag = useRef<{ y: number } | null>(null), [drop, setDrop] = useState(0);
  // CHAT-V4: on a computer the panel is the chat's right-hand column (full height, the top bar ends at its edge); in a
  // window too narrow to keep the conversation readable beside it (a small laptop or tablet) it lays over the chat.
  const box = useRef<HTMLElement>(null);
  useChatAside(box, { on: s.open && !phone, dock: roomBeside });
  if (!s.open) return null;
  const active = s.tabs.find((t) => t.id === s.active) ?? null;
  const launcher = s.launcher || !active;
  return <>
    {phone ? <div className={css.backdrop} onClick={() => setPanelOpen(false)} aria-hidden="true" /> : null}
    <aside ref={box} className={css.panel} data-phone={phone || undefined} data-resizing={resizing || undefined} aria-label="Side panel"
      style={{ "--panel-w": `${s.width}px`, transform: drop ? `translateY(${drop}px)` : undefined } as CSSProperties}>
      {phone ? <div className={css.grabber} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); sheetDrag.current = { y: e.clientY }; }}
        onPointerMove={(e) => { if (sheetDrag.current) setDrop(Math.max(0, e.clientY - sheetDrag.current.y)); }}
        onPointerUp={() => { const d = drop; sheetDrag.current = null; setDrop(0); if (d > 120) setPanelOpen(false); }} aria-hidden="true"><span /></div>
        : <div className={css.resize} role="separator" aria-orientation="vertical" aria-label="Resize the side panel" aria-valuemin={MIN_W} aria-valuemax={1200} aria-valuenow={s.width} tabIndex={0}
          title="Drag to resize · double-click for the usual width" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => setPanelWidth(DEFAULT_W)} onKeyDown={onKey} />}
      <header className={css.strip}>
        <div className={css.tabs} role="tablist" aria-label="Open in the side panel">
          {s.tabs.map((t, i) => { const Icon = ICON[t.kind]; const on = t.id === s.active && !s.launcher; return (
            <div key={t.id} className={css.tab} data-on={on || undefined} draggable onDragStart={(e) => dragRef(e, t.title, t.href)}
              onDragOver={(e) => { if (e.dataTransfer.types.includes(REF_TYPE)) e.preventDefault(); }}
              onDrop={(e) => { const from = s.tabs.find((x) => absolute(x.href) === droppedRef(e.dataTransfer)?.url); if (from && from.id !== t.id) { e.preventDefault(); moveTab(from.id, i); } }}>
              <button type="button" role="tab" aria-selected={on} title={`${t.title}${t.reason ? ` · opened because the message ${t.reason}` : ""}`} onClick={() => activateTab(t.id)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}>
                <Icon size={14} aria-hidden="true" /><span>{t.title}</span>{t.auto ? <Sparkles size={11} className={css.autoMark} aria-label="Opened by Pip" /> : null}
              </button>
              <button type="button" className={css.tabClose} onClick={() => closeTab(t.id)} aria-label={`Close ${t.title}`}><X size={13} aria-hidden="true" /></button>
            </div>); })}
          <button type="button" className={css.newTab} data-on={launcher || undefined} onClick={() => showLauncher(!s.launcher || !active)} aria-label="Open something in the side panel" title="Open a page, a Doc or a link"><Plus size={16} aria-hidden="true" /></button>
        </div>
        {active && !launcher ? <span className={css.tools}>
          {active.kind === "page" ? <button type="button" className={css.iconBtn} onClick={() => frameTools.get(active.id)?.back()} aria-label="Back" title="Back"><ArrowLeft size={15} aria-hidden="true" /></button> : null}
          <button type="button" className={css.iconBtn} onClick={() => frameTools.get(active.id)?.reload()} aria-label="Reload" title="Reload"><RotateCw size={14} aria-hidden="true" /></button>
          {active.kind === "page" ? <a className={css.iconBtn} href={active.href} aria-label="Open the full page" title="Open the full page"><Maximize2 size={14} aria-hidden="true" /></a>
            : <a className={css.iconBtn} href={active.href} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title={active.kind === "url" ? "Open in a new tab" : "Open in Google"}><ExternalLink size={14} aria-hidden="true" /></a>}
        </span> : null}
        <button type="button" className={css.iconBtn} onClick={() => setPanelOpen(false)} aria-label="Hide the side panel" title="Hide the side panel · Ctrl+."><PanelRightClose size={17} aria-hidden="true" /></button>
      </header>
      <div className={css.body}>
        {launcher ? <Launcher viewer={viewer} role={role} modulesOff={modulesOff} /> : null}
        {s.tabs.filter((t) => alive.includes(t.id)).map((t) => <TabView key={t.id} tab={t} shown={!launcher && t.id === s.active} resizing={resizing} />)}
      </div>
    </aside>
  </>;
}

/** Each open tab's back and reload, for the title row's buttons. */
const frameTools = new Map<string, { back: () => void; reload: () => void }>();
const SLOW_MS = 12000;

type Check = { embeddable: boolean; title?: string; description?: string; site?: string };
const checks = new Map<string, Promise<Check>>();
function checkFrame(url: string) {
  let p = checks.get(url);
  if (!p) { p = fetch(`/api/frame-check?url=${encodeURIComponent(url)}`).then((r) => r.ok ? r.json() as Promise<Check> : { embeddable: false }).catch(() => ({ embeddable: false })); checks.set(url, p); }
  return p;
}

/** One tab's content: the framed page (with an address row for Pulse pages) or the card for a site that cannot be framed. */
function TabView({ tab, shown, resizing }: { tab: PanelTab; shown: boolean; resizing: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true), [loads, setLoads] = useState(0), [check, setCheck] = useState<Check | null>(tab.kind === "url" && tab.embed ? null : { embeddable: tab.embed });
  const [src] = useState(tab.src);
  const [slow, setSlow] = useState(false);
  // A frame that has not loaded after a while says so, with the way out (never a blank box).
  useEffect(() => { if (!loading) { queueMicrotask(() => setSlow(false)); return; } const t = window.setTimeout(() => setSlow(true), SLOW_MS); return () => window.clearTimeout(t); }, [loading]);
  useEffect(() => {
    frameTools.set(tab.id, {
      back: () => { try { frame.current?.contentWindow?.history.back(); } catch { /* none */ } },
      reload: () => { setLoading(true); try { frame.current?.contentWindow?.location.reload(); } catch { if (frame.current) frame.current.src = frame.current.src; } },
    });
    return () => { frameTools.delete(tab.id); };
  }, [tab.id]);
  useEffect(() => { if (tab.kind !== "url" || !tab.embed) return; let live = true; void checkFrame(tab.src).then((c) => { if (live) setCheck(c); }); return () => { live = false; }; }, [tab.kind, tab.embed, tab.src]);
  // A Pulse page inside the tab: follow where it goes (a link clicked in it) and take its own title.
  const follow = useCallback(() => {
    if (tab.kind !== "page") return;
    try {
      const w = frame.current?.contentWindow; const doc = frame.current?.contentDocument; if (!w || !doc) return;
      // Owner workbench UI: a page already drawn counts as open, though its last images or scripts still load (the
      // "Still opening" card stood over a page that was plainly there).
      if ((doc.querySelector("main")?.textContent?.trim().length ?? 0) > 20) setLoading(false);
      const href = stripEmbed(`${w.location.pathname}${w.location.search}${w.location.hash}`);
      const heading = doc.querySelector("[data-page-header] h2, main h1, main h2")?.textContent?.trim();
      updateTab(tab.id, { href, title: heading && /[\p{L}\p{N}]/u.test(heading) ? heading.slice(0, 60) : undefined }); // a loading skeleton heading names nothing
    } catch { /* not readable yet */ }
  }, [tab.id, tab.kind]);
  useEffect(() => { if (!shown || tab.kind !== "page") return; const t = window.setInterval(follow, 1200); return () => window.clearInterval(t); }, [shown, tab.kind, follow]);
  // A new address for the same tab (intent detection asked for a more exact place): send the framed page there.
  useEffect(() => {
    if (tab.kind !== "page") return;
    try { const w = frame.current?.contentWindow; if (!w || w.location.href === "about:blank") return; const now = stripEmbed(`${w.location.pathname}${w.location.search}`); if (now !== tab.href.split("#")[0]) w.location.replace(panelTarget(tab.href)!.src); } catch { /* not loaded yet */ }
  }, [tab.href, tab.kind, tab.at]);
  const sandbox = tab.kind === "page" || tab.kind === "file" ? undefined : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
  return <section className={css.view} hidden={!shown} aria-label={tab.title}>
    {loading && check?.embeddable ? <span className={css.progress} aria-hidden="true" /> : null}
    {check === null ? <div className={css.card}><span className={css.spinner} aria-label="Checking the site" /></div>
      : !check.embeddable ? <LinkCard tab={tab} check={check} />
      : <iframe ref={frame} className={css.frame} src={src} title={tab.title} sandbox={sandbox} referrerPolicy={tab.kind === "page" ? undefined : "no-referrer"} allow="clipboard-write; fullscreen"
        style={resizing ? { pointerEvents: "none" } : undefined} onLoad={() => { setLoading(false); setLoads((n) => n + 1); follow(); }} />}
    {slow && loading && check?.embeddable ? <div className={css.slow} role="status"><span>Still opening {tab.title}…</span>
      <a className={css.secondary} href={tab.href} target={tab.kind === "page" ? undefined : "_blank"} rel="noreferrer">{tab.kind === "page" ? "Open the full page" : "Open in a new tab"}</a></div> : null}
    {shown && tab.coach && tab.kind === "page" && loads > 0 ? <Coach tab={tab} frame={frame} loads={loads} /> : null}
  </section>;
}

/** A site that does not allow framing: what it is, and the ways to use it. */
function LinkCard({ tab, check }: { tab: PanelTab; check: Check }) {
  const [copied, setCopied] = useState(false);
  return <div className={css.card}>
    <div className={css.linkCard} draggable onDragStart={(e) => dragRef(e, check.title || tab.title, tab.href)}>
      <span className={css.linkIcon} aria-hidden="true"><Globe size={22} /></span>
      <b>{check.title || tab.title}</b>
      <small>{check.site || tab.title}</small>
      {check.description ? <p>{check.description}</p> : null}
      <div className={css.linkActions}>
        <a className={css.primary} href={tab.href} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />Open in a new tab</a>
        <button type="button" className={css.secondary} onClick={() => { void navigator.clipboard?.writeText(tab.href).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }); }}><Copy size={15} aria-hidden="true" />{copied ? "Copied" : "Copy link"}</button>
      </div>
      <small className={css.note}>This site doesn’t allow being shown inside other apps. Drag this card into the message box to attach the link.</small>
    </div>
  </div>;
}

/** Pip points at the exact control inside the framed page: the page's own spotlight glow on it and Pip's note beside it. */
function Coach({ tab, frame, loads }: { tab: PanelTab; frame: RefObject<HTMLIFrameElement | null>; loads: number }) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number; below: boolean } | null>(null);
  const el = useRef<HTMLElement | null>(null);
  const done = useCallback(() => { el.current?.removeAttribute("data-spotlight"); el.current = null; setBox(null); updateTab(tab.id, { coach: null }); }, [tab.id]);
  useEffect(() => {
    const coach = tab.coach; if (!coach) return;
    const host = frame.current;
    let stopped = false, timer = 0; const started = Date.now();
    const place = () => {
      const f = frame.current, target = el.current; if (!f || !target) return;
      const r = target.getBoundingClientRect(), fr = f.getBoundingClientRect(), host = f.parentElement!.getBoundingClientRect();
      const top = r.top + fr.top - host.top, left = r.left + fr.left - host.left;
      setBox({ top, left, width: r.width, height: r.height, below: top < 140 });
    };
    const find = () => {
      if (stopped) return;
      let doc: Document | null = null; try { doc = frame.current?.contentDocument ?? null; } catch { doc = null; }
      const found = doc ? (coach.selector ? doc.querySelector<HTMLElement>(coach.selector) : null)
        ?? (coach.button ? [...doc.querySelectorAll<HTMLElement>("main button, main a")].find((b) => b.textContent?.trim().toLowerCase().startsWith(coach.button!.toLowerCase())) ?? null : null) : null;
      if (!found) { if (Date.now() - started < 15000) timer = window.setTimeout(find, 200); return; }
      el.current = found; found.scrollIntoView({ block: "center", behavior: "smooth" }); found.setAttribute("data-spotlight", "on");
      window.setTimeout(place, 450);
      const w = frame.current?.contentWindow; w?.addEventListener("scroll", place, true); w?.addEventListener("resize", place);
      w?.addEventListener("pointerdown", (e) => { if (found.contains(e.target as Node)) window.setTimeout(done, 300); }, { once: true });
    };
    timer = window.setTimeout(find, 150);
    const bye = window.setTimeout(done, 24000);
    return () => { stopped = true; window.clearTimeout(timer); window.clearTimeout(bye); try { const w = host?.contentWindow; w?.removeEventListener("scroll", place, true); w?.removeEventListener("resize", place); } catch { /* gone */ } };
    // Each time the framed page loads (a redirect, a slow first compile) the search starts again.
  }, [tab.coach, frame, done, loads]);
  if (!box || !tab.coach) return null;
  return <>
    <div className={css.coach} data-below={box.below || undefined} role="note" aria-live="polite" style={{ top: box.below ? box.top + box.height + 14 : box.top - 14, left: Math.max(10, box.left - 4) }}>
      <span className={css.pip} aria-hidden="true"><Sparkles size={13} /></span>
      <span><b>Pip</b>{tab.coach.text}</span>
      <button type="button" onClick={done} aria-label="Got it" title="Got it"><X size={13} aria-hidden="true" /></button>
    </div>
  </>;
}

const TILES: { label: string; href: (viewer: string) => string; Icon: typeof Globe; hint: string }[] = [
  { label: "My tasks", href: () => "/tasks?scope=me", Icon: CircleCheck, hint: "What is yours to do" },
  { label: "My steps", href: () => "/me/steps", Icon: ListChecks, hint: "Process steps waiting for you" },
  { label: "My profile", href: (v) => `/people/${encodeURIComponent(v)}?tab=info`, Icon: User, hint: "What colleagues see" },
  { label: "My desk", href: () => "/me", Icon: CalendarCheck, hint: "Attendance, leave, today" },
  { label: "Projects", href: () => "/tasks?view=projects", Icon: FolderKanban, hint: "Work projects" },
  { label: "Processes", href: () => "/processes", Icon: Workflow, hint: "How the company works" },
  { label: "Team", href: () => "/people", Icon: Users, hint: "People and pods" },
  { label: "Finance", href: () => "/finance", Icon: Wallet, hint: "Money in and out" },
];

/** "Open beside the chat": a few places one tap away, and a box that takes a page name, a Doc or Drive link or any address. */
function Launcher({ viewer, role, modulesOff }: { viewer: string; role?: string; modulesOff?: readonly string[] }) {
  const places = useMemo(() => openablePlaces(role, modulesOff), [role, modulesOff]);
  const allowed = useMemo(() => new Set(places.map((p) => p.href.split("?")[0])), [places]);
  const [q, setQ] = useState(""), [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const tiles = TILES.filter((t) => { const p = t.href(viewer).split("?")[0]; return p.startsWith("/people/") || allowed.has(p); });
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase(); if (!s) return [];
    const link = panelTarget(q.trim(), typeof window === "undefined" ? "" : window.location.origin);
    const named = places.filter((p) => `${p.label} ${p.words}`.toLowerCase().includes(s)).slice(0, 6).map((p) => ({ label: p.label, href: p.href, sub: "Pulse" }));
    return link && link.kind !== "page" ? [{ label: link.kind === "url" ? q.trim() : link.title, href: q.trim(), sub: link.kind === "url" ? "Web address" : "Google" }, ...named] : link ? [{ label: link.title, href: link.href, sub: link.href }, ...named] : named;
  }, [q, places]);
  const open = (href: string) => { if (openInPanel(href)) setQ(""); };
  return <div className={css.launcher}>
    <h3>Open beside the chat</h3>
    <p>A Pulse page, a Google Doc or Drive folder, or any link. Drag a tab into the message box to attach it.</p>
    <form className={css.find} onSubmit={(e) => { e.preventDefault(); const h = hits[at]; if (h) open(h.href); }}>
      <Search size={16} aria-hidden="true" />
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} placeholder="Type a page, or paste a link" aria-label="Page name or link"
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setAt((a) => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(1, hits.length)); } }} enterKeyHint="go" />
    </form>
    {hits.length ? <div className={css.hits} role="listbox" aria-label="Places">{hits.map((h, i) => <button key={`${h.href}:${i}`} type="button" role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onClick={() => open(h.href)}>
      <span>{h.label}</span><small>{h.sub}</small></button>)}</div>
      : <div className={css.tiles}>{tiles.map((t) => { const href = t.href(viewer); return <button key={t.label} type="button" className={css.tileBtn} onClick={() => open(href)} draggable onDragStart={(e) => dragRef(e, t.label, href)}>
        <t.Icon size={18} aria-hidden="true" /><b>{t.label}</b><small>{t.hint}</small></button>; })}</div>}
  </div>;
}

/** The control that shows or hides the panel, for a header. */
export function PanelToggle({ className }: { className?: string }) {
  const s = usePanel();
  const n = s.tabs.length;
  return <button type="button" className={className} onClick={() => togglePanel()} aria-pressed={s.open} aria-label={s.open ? "Hide the side panel" : "Show the side panel"} title={`${s.open ? "Hide" : "Show"} the side panel · Ctrl+.`} data-panel-toggle="">
    <PanelRightIcon open={s.open} />{n && !s.open ? <i className={css.toggleCount} aria-hidden="true">{n}</i> : null}
  </button>;
}
function PanelRightIcon({ open }: { open: boolean }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" />{open ? <path d="M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3z" fill="currentColor" opacity=".22" /> : null}</svg>;
}
