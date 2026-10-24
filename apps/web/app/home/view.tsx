"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { useTheme } from "@pulse/ui-shell";
import { ArrowUpRight, Banknote, Building2, CalendarCheck, FileText, Folder, Landmark, ListTodo, Plus, RefreshCw, Sparkles, Users, X } from "lucide-react";
import type { Brief, Glance, Icon, Move, Row, Tone } from "./brain";
import css from "./home.module.css";
import { ModeSwitch } from "./mode";
import type { MaxData } from "./deep";
import { MaxBody } from "./max";

type Sheet = "tasks" | "projects" | "create" | "ask" | string;
const SNOOZE_KEY = "pulse.home.snooze";
const ICONS: Record<Icon, typeof Banknote> = { money: Banknote, bank: Landmark, doc: FileText, people: Users, renew: RefreshCw, task: ListTodo, client: Building2, folder: Folder, leave: CalendarCheck };
const KEYS: { key: string; label: string; sheet: Sheet }[] = [{ key: "C", label: "Create", sheet: "create" }, { key: "T", label: "Tasks", sheet: "tasks" }, { key: "P", label: "Projects", sheet: "projects" }, { key: "/", label: "Ask", sheet: "ask" }];
const CREATE = [{ label: "Task", href: "/tasks" }, { label: "Client", href: "/clients" }, { label: "Invoice", href: "/finance?tab=revenue" }, { label: "Leave", href: "/me" }, { label: "Sprint", href: "/creative" }];
const ASK = [{ label: "Who owes us the most?", href: "/finance?tab=revenue" }, { label: "Which clients went quiet?", href: "/clients" }, { label: "Where does the money go?", href: "/finance?tab=costs" }];

/** The moves put off for later and until when; ones whose time has passed are left out (read outside render). */
function readSnooze(): Record<string, number> {
  try {
    const now = Date.now();
    return Object.fromEntries(Object.entries(JSON.parse(window.localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>).filter(([, until]) => until > now));
  } catch { return {}; }
}

/** OWNER-HOME: the calm home. It only draws what the brain ranked: one sentence, four cards, one decision at a time. */
/** It lives inside Pulse's own shell (rail and sidebar) as the dashboard's Focus mode; Max is the full dashboard. */
export function CalmHome({ brief, hello, today, max }: { brief: Brief; hello: string; today: string; max?: MaxData }) {
  const router = useRouter();
  const { resolved, setPreference } = useTheme();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [snooze, setSnooze] = useState<Record<string, number>>({});
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  // Read once after hydration: the server cannot see this browser's snoozes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSnooze(readSnooze()); }, []);
  // Focus mode quiets the shell's top bar (ui-shell styles.css reads this flag) while this view is on screen.
  useEffect(() => { document.documentElement.dataset.pulseFocus = ""; return () => { delete document.documentElement.dataset.pulseFocus; }; }, []);
  const queue = brief.next.filter((m) => !snooze[m.id]);
  const current = queue[0];

  const later = useCallback((m: Move | undefined, hours = 4) => {
    if (!m || leaving) return;
    setLeaving(true);
    window.setTimeout(() => {
      const next = { ...readSnooze(), [m.id]: Date.now() + hours * 3_600_000 };
      try { window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)); } catch {}
      setSnooze(next); setLeaving(false); setDrag(0);
    }, 280);
  }, [leaving]);
  const act = useCallback((m: Move | undefined) => { if (!m) return; later(m, 1); router.push(m.href); }, [later, router]);
  const toggleTheme = useCallback(() => setPreference(resolved === "dark" ? "light" : "dark"), [resolved, setPreference]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      // The native modal owns focus and every key while a Focus sheet is open.
      if (sheet) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) { if (e.key === "Escape") setSheet(null); return; }
      // EST-2093: another dialog (the bell's panel, New task, search) keeps its own keys.
      if (!sheet && document.querySelector('[aria-modal="true"], dialog[open]')) return;
      const control = el?.closest("a, button, input, textarea, select, summary, [contenteditable], [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=combobox], [role=listbox], [role=slider], [role=spinbutton], [role=textbox], [role=searchbox], [role=switch], [role=checkbox], [role=radio]");
      const k = e.key.toLowerCase();
      const go = (s: Sheet) => { e.preventDefault(); e.stopPropagation(); setSheet(s); };
      if (k === "escape") return setSheet(null);
      if (k === "c") return go("create");
      if (k === "t") return go("tasks");
      if (k === "p") return go("projects");
      if (k === "/") return go("ask");
      if (k === "d") { e.preventDefault(); toggleTheme(); return; }
      if (k === "f") { e.preventDefault(); const to = max ? "focus" : "max"; document.cookie = `pulse.home.mode=${to}; path=/; max-age=31536000; samesite=lax`; router.push(`/dashboard?mode=${to}`); return; }
      if (max && !control && /^[1-9]$/.test(k) && brief.queue[Number(k) - 1]) { e.preventDefault(); act(brief.queue[Number(k) - 1]); return; }
      // EST-2093: Enter on a focused control (Pip, a card, a menu item) is that control's; only Enter on the page itself
      // takes the next move.
      if (k === "enter" && !sheet && current && !control) { e.preventDefault(); act(current); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sheet, current, act, toggleTheme, router, max, brief.queue]);

  const onDown = (e: ReactPointerEvent) => {
    // Capturing a button's pointer on the article retargets its mouse click to the article.
    if (!e.isPrimary || e.button !== 0 || (e.target as Element).closest("a, button, input, textarea, select, [role=button], [role=link]")) return;
    start.current = e.clientX; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => { if (start.current !== null) setDrag(Math.min(40, e.clientX - start.current)); };
  const onUp = () => { if (start.current === null) return; start.current = null; if (drag < -90) later(current); else setDrag(0); };

  const glance = brief.allGlance.find((g) => g.id === sheet);
  return (
    <div className={css.root}>
      <div className={css.field} aria-hidden="true"><span /><span /><span /></div>


      <div className={css.main}>
        <div className={css.column} data-max={max ? "" : undefined}>
          <header className={css.hello}>
            <div className={css.helloTop}>
              <span className={css.today}><i className={css.live} />{today}</span>
              <div className={css.helloEnd}>
                <nav className={css.keys} aria-label="Shortcuts">{KEYS.map((k) => <button key={k.key} type="button" className={css.hint} onClick={() => setSheet(k.sheet)}><kbd className={css.kbd}>{k.key}</kbd>{k.label}</button>)}</nav>
                <ModeSwitch mode={max ? "max" : "focus"} />
              </div>
            </div>
            {/* EST-2093: one sentence whose dimmed parts wrap across lines; the layout audit samples a wrapped span by its
                whole bounding box and reads the other part as covering it, though no text overlaps. */}
            <h1 className={css.title} data-layout-ok="" data-max={max ? "" : undefined}>
              <span className={css.word} style={{ "--i": 0 } as CSSProperties}>{hello} </span>
              <span className={css.word} style={{ "--i": 1 } as CSSProperties}><span className={css.dim}>{brief.greeting.lead}</span>{brief.greeting.figure}<span className={css.dim}>{brief.greeting.tail}</span></span>
            </h1>
          </header>

          {max ? <MaxBody data={max} brief={brief} onOpen={(id) => setSheet(id)} act={act} /> : <>
          <section className={css.cards} aria-label="At a glance">
            {brief.glance.map((g, i) => <GlanceCard key={g.id} g={g} i={i} onOpen={() => setSheet(g.id)} />)}
          </section>

          <section className={css.lower} aria-label="Next up">
            <div className={css.stack}>
              {current ? <>
                <span className={css.ghost2} aria-hidden="true" /><span className={css.ghost1} aria-hidden="true" />
                <article key={current.id} className={css.next} data-leaving={leaving ? "" : undefined} style={{ "--dx": `${drag}px` } as CSSProperties}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                  <div className={css.nextHead}>
                    <span className={css.label}>Next up</span>
                    <span className={css.dots} aria-label={`${brief.next.length - queue.length + 1} of ${brief.next.length}`}>{brief.next.map((m) => <i key={m.id} data-state={m.id === current.id ? "on" : snooze[m.id] ? "done" : undefined} />)}</span>
                  </div>
                  <div className={css.nextBody}>
                    <MoveIcon m={current} />
                    <span className={css.nextTitle}>{current.title}</span>
                  </div>
                  <div className={css.nextActions}>
                    <button type="button" className={css.primary} onClick={() => act(current)}>{current.cta}<kbd className={css.kbdDark}>↵</kbd></button>
                    <button type="button" className={css.secondary} onClick={() => later(current)}>Later</button>
                  </div>
                </article>
              </> : <article className={css.next} data-clear="">
                <span className={css.nextTitle}>You’re clear.</span>
                <button type="button" className={css.secondary} onClick={() => { try { window.localStorage.removeItem(SNOOZE_KEY); } catch {} setSnooze({}); }}>Show everything again</button>
              </article>}
            </div>
            {brief.noticed ? <Link href={brief.noticed.href} className={css.noticed}>
              <span className={css.noticedHead}><Sparkles size={15} />Pulse noticed</span>
              <span className={css.noticedText}>{brief.noticed.text}</span>
              <span className={css.noticedGo}>Why <ArrowUpRight size={14} /></span>
            </Link> : null}
          </section>
          </>}
        </div>
      </div>

      {sheet ? <FocusSheet title={sheetTitle(sheet, glance)} onClose={() => setSheet(null)}>
          {glance ? <>
            <span className={css.big} data-tone={glance.tone}>{glance.sheet.big}</span>
            <span className={css.bigSub}>{glance.sheet.bigSub}</span>
            <Viz g={glance} tall />
            <Rows rows={glance.sheet.rows} />
            {glance.sheet.cta ? <Link href={glance.sheet.cta.href} className={css.sheetCta}>{glance.sheet.cta.label}</Link> : null}
          </> : sheet === "tasks" ? <>
            <Rows rows={brief.tasks} empty="No open tasks. Nice." />
            <Link href="/tasks" className={css.sheetCta}>All tasks</Link>
          </> : sheet === "projects" ? <>
            <Rows rows={brief.projects} empty="No project activity this week." />
            <Link href="/projects" className={css.sheetCta}>All projects</Link>
          </> : <Composer kind={sheet === "ask" ? "ask" : "create"} onGo={(href) => { setSheet(null); router.push(href); }} />}
      </FocusSheet> : null}
    </div>
  );
}

/** Native dialog supplies the modal focus lifecycle while retaining the owner's sheet presentation. */
function FocusSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = box.current;
    if (!dialog) return;
    const before = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled)")?.focus({ preventScroll: true });
    return () => { dialog.close(); if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={box} className={`${css.sheet} ${css.glassThick}`} role="dialog" aria-modal="true" aria-label={title}
    onCancel={(e) => { e.preventDefault(); onClose(); }}
    onKeyDown={(e) => {
      if (e.key !== "Tab") return;
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length);
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
    }}
    onClick={(e) => {
      if (e.target !== e.currentTarget) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
    }}>
    <span className={css.grabber} aria-hidden="true" />
    <div className={css.sheetHead}>
      <span className={css.sheetTitle}>{title}</span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={16} /></button>
    </div>
    {children}
  </dialog>;
}

function sheetTitle(sheet: Sheet, glance?: Glance) {
  return glance ? glance.sheet.title : sheet === "tasks" ? "Tasks" : sheet === "projects" ? "Projects" : sheet === "ask" ? "Ask Pulse" : "Create";
}

function GlanceCard({ g, i, onOpen }: { g: Glance; i: number; onOpen: () => void }) {
  return (
    <button type="button" className={css.card} onClick={onOpen} style={{ "--i": i } as CSSProperties} aria-label={`${g.label}: ${g.value}. ${g.sub}`}>
      <ArrowUpRight className={css.arrow} size={18} aria-hidden="true" />
      <span className={css.label}>{g.label}</span>
      <span className={css.value} data-tone={g.tone}>{g.value}</span>
      <Viz g={g} />
      <span className={css.sub}>{g.sub}</span>
    </button>
  );
}

function Viz({ g, tall }: { g: Glance; tall?: boolean }) {
  return <span className={css.viz} data-tall={tall ? "" : undefined} aria-hidden="true">{g.viz.filter((v) => v.weight > 0).map((v, i) => <i key={i} data-tone={v.tone} style={{ flexGrow: v.weight, "--j": i } as CSSProperties} />)}</span>;
}

function MoveIcon({ m }: { m: Move }) {
  const I = ICONS[m.icon];
  return <span className={css.moveIcon} data-tone={m.tone}><I size={22} aria-hidden="true" /></span>;
}

function Rows({ rows, empty }: { rows: Row[]; empty?: string }) {
  if (!rows.length) return <p className={css.empty}>{empty ?? "Nothing here yet."}</p>;
  return <div className={css.rows}>{rows.map((r, i) => {
    const body = <><i className={css.dot} data-tone={r.tone} /><span className={css.rowText}><span className={css.rowTitle}>{r.title}</span><span className={css.rowSub}>{r.sub}</span></span><span className={css.rowValue} data-tone={r.tone as Tone}>{r.value}</span></>;
    return r.href ? <Link key={i} href={r.href} className={css.row} style={{ "--i": i } as CSSProperties}>{body}</Link> : <div key={i} className={css.row} style={{ "--i": i } as CSSProperties}>{body}</div>;
  })}</div>;
}

function Composer({ kind, onGo }: { kind: "ask" | "create"; onGo: (href: string) => void }) {
  const items = kind === "ask" ? ASK : CREATE;
  return <>
    <form className={css.input} onSubmit={(e) => { e.preventDefault(); onGo(items[0].href); }}>
      {kind === "ask" ? <Sparkles size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
      <input aria-label={kind === "ask" ? "Ask anything about the company" : "What do you want to create?"} placeholder={kind === "ask" ? "Ask anything about the company" : "What do you want to create?"} />
    </form>
    <div className={css.chips}>{items.map((c, i) => <Link key={c.label} href={c.href} className={css.chip} style={{ "--i": i } as CSSProperties}>{c.label}</Link>)}</div>
  </>;
}
