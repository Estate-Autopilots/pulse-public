"use client";
// UX-5A (owner, 13 Oct 2026: Ctrl+K "so much more intelligent"). One box finds and does everything:
//   - places to go: the rail's pages and every tab, settings section and control in the destinations registry
//     (UX-5B, app/destinations), opened at the exact spot (`?go=<id>` → the spotlight);
//   - actions: check in (office, home, on duty) or out, a break, a new task or project, leave, a request to HR, work on a
//     day off, ask Pip;
//   - people, client projects, clients and contacts (read once when it first opens, as before), and from the server,
//     streamed in: tasks, work projects, chats, SOPs, policies, offices and places (GET /api/v0/search, row security).
// Matching is fuzzy (lib/search-rank.mjs: word starts, words run together, one typo), with synonyms from the registry
// and Pip's words; ranking adds what the person picked before and the page they are on; nothing they may not see is
// listed (the registry's access and switched-off modules; the server's row security). A question, or a weak match,
// gets Pip's reading ("where do I add the office internet?" → Office presence → Wi-Fi) on top.
// Local results answer on the keystroke; the server's arrive below them without moving anything above.
import { useRouter, usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  BadgeCheck, BookOpen, BookUser, Building2, CalendarCheck, CalendarPlus, CircleCheck, Coffee, Compass, FileText, FolderKanban, Hash, House, LifeBuoy, LogIn, LogOut, MapPin,
  MessageCircle, MousePointerClick, Play, Search, Settings, Sparkles, SquarePen, Sun, UserRound, Workflow,
} from "lucide-react";
import { pathSwitchedOff, shellNav, type ShellRename } from "@pulse/ui-shell";
import { type Destination } from "../destinations/registry.mjs";
import { paletteGoItems } from "../lib/palette-go.mjs";
import { prepare, rank, recentBoost, understand, norm } from "../lib/search-rank.mjs";
import { underBase } from "../lib/screens.mjs";
import { Keycap } from "../kit";
import { Avatar } from "../ui";
import css from "./palette.module.css";

/** A rail page as the shell knows it (renamed for the company, filtered for the role). */
export type ShellPage = { label: string; href: string; Icon?: React.ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>; access?: string };
type GroupKey = "pip" | "recent" | "go" | "actions" | "people" | "client-projects" | "clients" | "contacts" | "tasks" | "projects" | "chats" | "sops" | "policies" | "places";
const GROUPS: Record<GroupKey, { label: string; take: number; bias: number }> = {
  pip: { label: "Pip", take: 1, bias: 9 }, recent: { label: "Recent", take: 5, bias: 0 }, go: { label: "Go to", take: 4, bias: 0.45 }, actions: { label: "Actions", take: 3, bias: 0.3 },
  people: { label: "People", take: 4, bias: 0.1 }, tasks: { label: "Tasks", take: 4, bias: 0 }, projects: { label: "Projects", take: 3, bias: 0 }, places: { label: "Places", take: 3, bias: 0 },
  "client-projects": { label: "Client projects", take: 3, bias: 0 }, clients: { label: "Clients", take: 3, bias: 0 }, contacts: { label: "Contacts", take: 3, bias: 0 },
  chats: { label: "Chats", take: 3, bias: 0 }, sops: { label: "SOPs", take: 3, bias: 0 }, policies: { label: "Policies", take: 3, bias: 0 },
};
type Item = { key: string; group: GroupKey; label: string; sub?: string; path?: readonly string[]; synonyms?: readonly string[]; keywords?: string;
  href?: string; icon: ReactNode; run?: () => void; kind: string; coach?: string; score?: number };
type Prepared = ReturnType<typeof prepare<Item>>;

const ICON_BY_NAME: Record<string, ReactNode> = {
  House: <House size={16} />, CircleCheck: <CircleCheck size={16} />, MessageCircle: <MessageCircle size={16} />, Building2: <Building2 size={16} />, BookUser: <BookUser size={16} />,
  Map: <MapPin size={16} />, Workflow: <Workflow size={16} />, Users: <UserRound size={16} />, CalendarCheck: <CalendarCheck size={16} />, Settings: <Settings size={16} />,
};
const kindIcon = (d: Destination) => (d.icon && ICON_BY_NAME[d.icon]) ?? (d.kind === "page" ? <Compass size={16} /> : d.kind === "control" ? <MousePointerClick size={16} /> : d.kind === "section" ? <Settings size={16} /> : <Hash size={16} />);
const SERVER_ICON: Record<string, ReactNode> = { task: <CircleCheck size={16} />, project: <FolderKanban size={16} />, chat: <MessageCircle size={16} />, message: <MessageCircle size={16} />,
  sop: <Workflow size={16} />, policy: <BookOpen size={16} />, office: <MapPin size={16} />, place: <MapPin size={16} /> };
const RECENT_KEY = "pulse.search.picks";
type Pick = { key: string; label: string; href?: string; group: GroupKey; at: number; n: number };
const readPicks = (): Pick[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x?.key === "string").slice(0, 30) : []; } catch { return []; } };
const savePick = (it: Item) => { try { const list = readPicks(); const old = list.find((x) => x.key === it.key); const next = [{ key: it.key, label: it.label, href: it.href, group: it.group, at: Date.now(), n: (old?.n ?? 0) + 1 }, ...list.filter((x) => x.key !== it.key)].slice(0, 30); localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ } };
const str = (v: unknown) => typeof v === "string" ? v : "";
const base = (href: string) => href.split(/[?#]/)[0];

/** People, client projects, clients and contacts: read once, the first time the palette opens. Lists the person may not
 *  read (403) are skipped. */
async function loadRecords(): Promise<Item[]> {
  const read = async (path: string, key: string) => { try { const r = await fetch(`/api/v0/${path}`); if (!r.ok) return []; const d = await r.json() as Record<string, unknown>; return Array.isArray(d[key]) ? d[key] as Record<string, unknown>[] : []; } catch { return []; } };
  const [projects, clients, contacts, people] = await Promise.all([read("projects", "projects"), read("clients", "clients"), read("contacts", "contacts"), read("people", "people")]);
  const sub = (...x: unknown[]) => x.map(str).filter(Boolean).join(" · ") || undefined;
  return [
    ...people.filter((p) => str(p.status) !== "inactive").map((p): Item => ({ key: `person:${str(p.id)}`, group: "people", kind: "person", label: str(p.name), sub: sub(p.role, p.pod), keywords: `${str(p.department)} ${str(p.username)} ${str(p.location)}`,
      href: `/people/${str(p.id)}`, icon: <Avatar name={str(p.name)} id={str(p.id)} photoAt={(p.photoAt as string | null) ?? null} size={22} /> })),
    ...projects.map((p): Item => ({ key: `cproject:${str(p.projectId)}`, group: "client-projects", kind: "client-project", label: str(p.title) || str(p.folderName), sub: sub(p.clientName, p.location), href: `/projects/${str(p.projectId)}`, icon: <FolderKanban size={16} /> })),
    ...clients.map((c): Item => ({ key: `client:${str(c.id)}`, group: "clients", kind: "client", label: str(c.name), sub: sub(c.companyName, c.city), href: `/clients/${str(c.id)}`, icon: <Building2 size={16} /> })),
    ...contacts.map((c): Item => ({ key: `contact:${str(c.id)}`, group: "contacts", kind: "contact", label: str(c.name), sub: sub(c.designation, str(c.clientName) || str(c.companyName)), href: `/contacts/${str(c.id)}`, icon: <BookUser size={16} /> })),
  ].filter((x) => x.label);
}

type Server = { q: string; groups: { key: string; label: string; items: { id: string; title: string; sub?: string | null; href: string; kind: string; score: number }[] }[] };

/** The palette, mounted once by the root layout; the shell's Ctrl+K and search field send `pulse:search` to open it.
 *  The role's rail pages and places come from the shell (`shellNav`), so the two never disagree. */
const NONE: readonly string[] = [];
export function CommandPalette({ role, modulesOff = NONE, rename, person, attendance = true, hidden = NONE }: {
  role?: string | null; modulesOff?: readonly string[]; rename?: ShellRename; person?: string | null; attendance?: boolean;
  /** EST-1420: page bases the organisation hides from this role; nothing under them is offered. */ hidden?: readonly string[] }) {
  const router = useRouter(), pathname = usePathname();
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const show = () => setOpen(true);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pulse:search", show); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pulse:search", show); window.removeEventListener("keydown", esc); };
  }, []);
  const { pages, places, financeOnly } = useMemo(() => shellNav(role ?? undefined, modulesOff, rename), [role, modulesOff, rename]);
  const [query, setQuery] = useState(""), [at, setAt] = useState(0);
  const [records, setRecords] = useState<Prepared[] | null>(null);
  const [server, setServer] = useState<Server | null>(null), [wasOpen, setWasOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), loading = useRef(false);
  const uid = useId();
  const [picks, setPicks] = useState<Pick[]>([]);

  // The places to go and the actions, prepared once per role.
  const local = useMemo<Prepared[]>(() => {
    const go: Item[] = paletteGoItems({ pages, places, financeOnly, role, modulesOff, hidden, isSwitchedOff: (href) => pathSwitchedOff(href, modulesOff) })
      .map(({ page, destination, ...item }) => ({ ...item, icon: destination ? kindIcon(destination) : page?.Icon ? <page.Icon size={16} aria-hidden="true" /> : <Compass size={16} /> }));
    const act = (key: string, label: string, icon: ReactNode, run: () => void, synonyms: string[], sub?: string): Item => ({ key: `action:${key}`, group: "actions", kind: "action", label, icon, run, synonyms, sub });
    const checkin = (id: string, mode?: string) => () => {
      const detail = { id, mode, handled: false };
      window.dispatchEvent(new CustomEvent("pulse:checkin-act", { detail }));
      if (!detail.handled) router.push(`/me?do=${id}${mode ? `&mode=${mode}` : ""}`);
    };
    const actions: Item[] = financeOnly || !person ? [] : [
      ...(attendance ? [
        act("checkin-office", "Check in (office)", <LogIn size={16} />, checkin("check-in", "office"), ["check in", "checkin", "punch in", "start work", "attendance", "office", "arrive"]),
        act("checkin-home", "Check in (from home)", <LogIn size={16} />, checkin("check-in", "wfh"), ["check in", "wfh", "work from home", "home", "remote", "attendance"]),
        act("checkin-field", "Check in (on duty)", <LogIn size={16} />, checkin("check-in", "field"), ["check in", "on duty", "field", "site visit", "outside", "attendance"]),
        act("checkout", "Check out", <LogOut size={16} />, checkin("check-out"), ["check out", "checkout", "punch out", "leave for the day", "done for today", "end work", "attendance"]),
        act("break", "Start a break", <Coffee size={16} />, checkin("break-start"), ["break", "lunch", "pause", "tea"]),
        act("back", "Back from a break", <Play size={16} />, checkin("break-end"), ["back", "resume", "end break"]),
        act("day-off", "Work on a day off…", <Sun size={16} />, () => router.push("/me?tab=attendance&do=day-off"), ["day off", "sunday", "holiday", "weekly off", "comp off", "extra day"]),
      ] : []),
      act("new-task", "New task", <SquarePen size={16} />, () => window.dispatchEvent(new CustomEvent("pulse:create", { detail: { kind: "task" } })), ["add task", "create task", "todo", "to do", "assign"]),
      act("new-project", "New project", <FolderKanban size={16} />, () => window.dispatchEvent(new CustomEvent("pulse:create", { detail: { kind: "project" } })), ["add project", "create project"]),
      act("leave", "Apply for leave", <CalendarPlus size={16} />, () => router.push("/me?tab=leave&do=apply-leave"), ["leave", "time off", "holiday", "vacation", "sick", "day off", "absence"]),
      act("request", "Raise a request with HR", <LifeBuoy size={16} />, () => router.push("/me?tab=requests&do=new-request"), ["request", "ticket", "ask hr", "hr", "complaint", "problem", "help"]),
      act("thank", "Thank a colleague", <BadgeCheck size={16} />, () => router.push("/me?do=thank"), ["thanks", "kudos", "recognise", "appreciate"]),
    ];
    return [...go, ...actions].map(prepare);
  }, [pages, places, role, modulesOff, person, attendance, financeOnly, router, hidden]);

  const q = query.trim(), qn = norm(q);
  const reading = useMemo(() => understand(q), [q]);

  // Local results on every keystroke: rank, group, and Pip's reading when the plain match is weak or it is a question.
  const view = useMemo(() => {
    // EST-1420 P2: records under a screen hidden from this role are never offered, nor are recent picks of them.
    const all = [...local, ...(records ?? [])].filter((it) => !it.href || !underBase(it.href, hidden));
    const boost = (it: Item) => recentBoost(it.key, picks) + (it.href && base(it.href) === pathname ? 0.08 : 0) + (reading.intent === "change" && (it.kind === "section" || it.kind === "control" || it.kind === "action") ? 0.12 : 0);
    if (!qn) {
      const recent = picks.slice(0, 5).map((p) => all.find((x) => x.key === p.key)).filter((x): x is Prepared => !!x).map((x) => ({ ...x, group: "recent" as GroupKey }));
      const go = local.filter((x) => x.key.startsWith("page:") && pages.some((p) => `page:${p.href}` === x.key));
      const actions = local.filter((x) => x.group === "actions").slice(0, attendance ? 2 : 0).concat(local.filter((x) => x.key === "action:new-task" || x.key === "action:leave"));
      return { groups: [["recent", recent], ["go", go], ["actions", actions]] as [GroupKey, Item[]][], pip: null as Item | null, weak: false };
    }
    const plain = rank(all, q, { boost, min: 0.3 });
    const best = plain[0]?.score ?? 0;
    const weak = reading.question || best < 0.8;
    let pip: Item | null = null;
    if (weak && reading.groups.length) {
      const loose = rank(local.filter((x) => x.group === "go" || x.group === "actions"), q, { groups: reading.groups, boost, min: 0.55 });
      const top = loose[0];
      if (top && (top.score > best || reading.question)) pip = { ...top.item, key: `pip:${top.item.key}`, group: "pip", sub: top.item.coach ?? (top.item.path?.length ? top.item.path.join(" › ") : top.item.sub) };
    }
    const by = new Map<GroupKey, { items: Item[]; top: number }>();
    for (const { item, score } of plain) { const g = by.get(item.group) ?? { items: [], top: score }; if (g.items.length < GROUPS[item.group].take) g.items.push({ ...item, score }); by.set(item.group, g); }
    const groups = [...by.entries()].sort((a, b) => (b[1].top + GROUPS[b[0]].bias) - (a[1].top + GROUPS[a[0]].bias)).map(([k, g]) => [k, g.items] as [GroupKey, Item[]]);
    return { groups, pip, weak };
  }, [local, records, qn, q, picks, pathname, reading, pages, attendance, hidden]);

  // The server's extras for this query (debounced; an answer for an older query is never shown for a newer one).
  useEffect(() => {
    if (!open || financeOnly || qn.length < 2) return;
    const abort = new AbortController();
    const terms = view.weak ? reading.groups.flatMap((g) => [g.word, ...g.alts]).slice(0, 8).join(",") : "";
    const t = setTimeout(() => {
      fetch(`/api/v0/search?q=${encodeURIComponent(q)}${terms ? `&terms=${encodeURIComponent(terms)}` : ""}`, { signal: abort.signal, cache: "no-store" })
        .then((r) => r.ok ? r.json() : { q, groups: [] }).then((d: Server) => { if (!abort.signal.aborted) setServer(d); }).catch(() => { if (!abort.signal.aborted) setServer({ q, groups: [] }); });
    }, 140);
    return () => { clearTimeout(t); abort.abort(); };
  }, [open, financeOnly, q, qn, view.weak, reading]);
  const asking = open && !financeOnly && qn.length >= 2 && (!server || norm(server.q) !== qn);

  const serverGroups = useMemo<[GroupKey, Item[]][]>(() => !server || norm(server.q) !== qn ? [] : server.groups.filter((g) => g.key in GROUPS).map((g) => [g.key as GroupKey,
    g.items.slice(0, GROUPS[g.key as GroupKey].take).map((h): Item => ({ key: `${h.kind}:${h.id}`, group: g.key as GroupKey, kind: h.kind, label: h.title, sub: h.sub ?? undefined, href: h.href, icon: SERVER_ICON[h.kind] ?? <FileText size={16} /> })).filter((it) => !it.href || !underBase(it.href, hidden))]), [server, qn, hidden]);

  const rows = useMemo(() => {
    const out: Item[] = [];
    if (view.pip) out.push(view.pip);
    const shown = new Set<string>();
    for (const [, items] of [...view.groups, ...serverGroups]) for (const it of items) if (!shown.has(it.key)) { shown.add(it.key); out.push(it); }
    if (qn.length >= 2 && person) out.push({ key: "ask-pip", group: "actions", kind: "ask", label: `Ask Pip: “${q.length > 48 ? `${q.slice(0, 46)}…` : q}”`, icon: <Sparkles size={16} />,
      run: () => window.dispatchEvent(new CustomEvent("pulse:ask-pip", { detail: { question: q } })) });
    return out;
  }, [view, serverGroups, qn, q, person]);

  // Each opening starts empty, with the latest picks (state set while rendering, not in an effect).
  if (open !== wasOpen) { setWasOpen(open); if (open) { setQuery(""); setAt(0); setPicks(readPicks()); } }
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 0); }, [open]);
  useEffect(() => {
    if (!open || records || loading.current || financeOnly) return;
    loading.current = true; void loadRecords().then((r) => setRecords(r.map(prepare))).finally(() => { loading.current = false; });
  }, [open, records, financeOnly]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  const choose = useCallback((it: Item | undefined) => {
    if (!it) return;
    savePick(it.group === "pip" ? { ...it, key: it.key.replace(/^pip:/, ""), group: "go" } : it);
    onClose();
    if (it.run) it.run(); else if (it.href) router.push(it.href);
  }, [onClose, router]);
  if (!open) return null;
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => rows.length ? (i + 1) % rows.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => rows.length ? (i - 1 + rows.length) % rows.length : 0); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setAt(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setAt(Math.max(0, rows.length - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[at]); }
  };
  const label = (g: GroupKey) => g === "pip" ? null : GROUPS[g].label;
  return (
    <div className={css.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={css.dialog} role="dialog" aria-modal="true" aria-label="Search Pulse">
        <div className={css.inputRow}>
          <Search size={18} aria-hidden="true" />
          <input ref={input} value={query} onChange={(e) => { setQuery(e.target.value); setAt(0); }} onKeyDown={onKey} placeholder={financeOnly ? "Search Finance pages…" : "Search or ask: pages, settings, tasks, people…"}
            aria-label={financeOnly ? "Search Finance pages" : "Search pages, settings, tasks, people and actions, or ask Pip"} role="combobox" aria-expanded="true" aria-controls={`${uid}-list`}
            aria-activedescendant={rows[at] ? `${uid}-${at}` : undefined} aria-autocomplete="list" autoComplete="off" spellCheck={false} enterKeyHint="go" />
          <span className={css.status} aria-live="polite">{asking ? "Searching…" : ""}</span>
          <Keycap keys="Escape" hideOnTouch />
        </div>
        <div ref={list} className={css.results} id={`${uid}-list`} role="listbox" aria-label="Results">
          {rows.map((it, i) => {
            const head = i === 0 || rows[i - 1].group !== it.group ? label(it.group) : null;
            const pip = it.group === "pip";
            // RELEASE-5: a place found by another word for it ("payslip" → History) says which word, so it explains itself.
            const why = it.group === "go" && qn && !norm(it.label).includes(qn) ? it.synonyms?.find((w) => { const n = norm(w); return n.includes(qn) || qn.includes(n); }) : undefined;
            const sub = why ? [it.sub, why].filter(Boolean).join(" · ") : it.sub;
            return <div key={it.key} role="presentation">
              {head ? <p className={css.groupLabel} role="presentation">{head}</p> : null}
              <div id={`${uid}-${i}`} data-row={i} role="option" aria-selected={i === at} aria-label={pip ? `Pip: ${it.label}` : it.label} aria-describedby={sub ? `${uid}-${i}-sub` : undefined}
                className={css.row} data-active={i === at ? "" : undefined} data-pip={pip ? "" : undefined} onMouseMove={() => { if (at !== i) setAt(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(it)}>
                <span className={css.icon} aria-hidden="true">{pip ? <Sparkles size={16} /> : it.icon}</span>
                <span className={css.main}>{pip ? <small className={css.pipWord}>Pip thinks you mean</small> : null}<span className={css.label}>{it.label}</span>{sub ? <small id={`${uid}-${i}-sub`} className={css.sub}>{sub}</small> : null}</span>
                <span className={css.end} aria-hidden="true">{it.group === "actions" && it.kind !== "ask" ? "Action" : null}{i === at ? <Keycap keys="Enter" /> : null}</span>
              </div>
            </div>;
          })}
          {!rows.length ? <p className={css.empty}>{qn && !records && !financeOnly ? "Searching…" : "Nothing matches."}</p> : null}
        </div>
        <p className={css.hints} aria-hidden="true"><span><Keycap keys={["ArrowUp", "ArrowDown"]} /> move</span><span><Keycap keys="Enter" /> open</span><span><Sparkles size={12} /> ask a question</span></p>
      </section>
    </div>
  );
}
