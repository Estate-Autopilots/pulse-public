"use client";
// The notification panel (UX-NOTIFY): the bell opens it as a floating panel on a computer and a full-screen sheet on a
// phone. Needs your action (with the card's own buttons: Accept, Decline, Approve, Reject, Join, Reply), Mentions and
// Updates; mark read, mark all read, filters, and Inbox for the history. Arrow keys move between cards, Enter opens one,
// Escape closes and returns to the bell.
import { BriefcaseBusiness, Check, CheckCheck, ChevronDown, CircleCheck, Compass, FileText, FolderKanban, Inbox, Layers, MessageCircle, Settings2, Bell, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { pipSvg } from "@pulse/companion";
import { ago } from "../lib/format";
import { Avatar } from "../ui";
import { Rating, Toggle } from "../tasks/kit";
import { markAllRead, markRead, priorityOf, refreshNotices, runAction, useNoticeList, useNoticesFailed, usePingStatus, type Notice, type NoticeAction, type NoticeStack } from "./store";
import css from "./panel.module.css";

type Filter = "all" | "unread" | "work" | "chats" | "hr";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "unread", label: "Unread" }, { id: "work", label: "Work" }, { id: "chats", label: "Chats" }, { id: "hr", label: "HR" }];
// ATT: one order everywhere: urgent, then what needs you (pinned on top), then for your information.
const GROUPS = [["urgent", "Urgent"], ["needs_you", "Needs your action"], ["fyi", "For your information"]] as const;
const isWork = (n: Notice) => /^(task|project|ask|domain|pool)\./.test(n.eventType ?? "") || ["task", "project", "domain"].includes(n.subject?.type ?? "");
const isChat = (n: Notice) => n.subject?.type === "chat" || !!n.channelId;
const isHr = (n: Notice) => n.subject?.type === "hr_flow" || /^(leave|request|approval|attendance|payroll|profile|policy|holiday)\./.test(n.eventType ?? "");
const matches = (n: Notice, f: Filter) => f === "all" || (f === "unread" ? !n.readAt : f === "work" ? isWork(n) : f === "chats" ? isChat(n) : isHr(n));
const STATE: Record<string, string> = { accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn", done: "Done", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", expired: "Expired" };

function TypeIcon({ n }: { n: Notice }) {
  const Icon = isChat(n) ? MessageCircle : n.subject?.type === "project" || /^project\./.test(n.eventType ?? "") ? FolderKanban : /^domain\./.test(n.eventType ?? "") ? Compass : /^pool\./.test(n.eventType ?? "") ? Inbox : isWork(n) ? CircleCheck
    : n.subject?.type === "hr_flow" ? BriefcaseBusiness : n.kind === "policy" ? FileText : Bell;
  return <span className={css.typeIcon} aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>;
}

function Actions({ n }: { n: Notice }) {
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  if (done) return <p className={css.done}><Check size={14} aria-hidden="true" />{done}</p>;
  if (n.state !== "open" || !n.actions.length) return STATE[n.state] && n.state !== "open" ? <p className={css.stateLabel}>{STATE[n.state]}</p> : null;
  const text = (a: NoticeAction) => a.fields?.find((f) => f.type === "text");
  async function run(a: NoticeAction) {
    const field = text(a);
    // A reason, a reply or a note is typed first; "Decline" may go without one.
    if (field && open !== a.key && a.key !== "decline") { setOpen(a.key); setError(""); return; }
    if (field && a.key !== "decline" && !String(values[field.key] ?? "").trim()) { setError(`${field.label.replace(/ \(.*\)$/, "")} first.`); return; }
    setBusy(a.key); setError("");
    try { setDone(await runAction(n, a, values)); } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(null); }
  }
  const typing = n.actions.find((a) => a.key === open);
  const field = typing ? text(typing) : undefined;
  return (
    <div className={css.actionArea}>
      {field && typing ? (
        <form className={css.reply} onSubmit={(e) => { e.preventDefault(); void run(typing); }}>
          <input autoFocus aria-label={field.label} placeholder={field.label} value={String(values[field.key] ?? "")} maxLength={2000}
            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } }} />
          <button type="submit" className={css.primary} disabled={!!busy}>{busy ? "Sending…" : typing.key === "reply" ? "Send" : typing.label}</button>
          <button type="button" className={css.ghost} onClick={() => setOpen(null)}>Cancel</button>
        </form>
      ) : (
        <div className={css.buttons}>
          {n.actions.map((a) => (
            <Fragment key={a.key}>
              {/* TASKS-4B: a review is one quality rating (and "above and beyond"), not two dropdowns (the old 1–5
                  "rating" fields for effort and impact are gone from the contract, PROMOTE-4B). */}
              {(a.fields ?? []).filter((f) => f.type === "choice").map((f) => <span key={f.key} className={css.choice}>
                <Rating label={f.label} options={f.options ?? []} value={String(values[f.key] ?? f.default ?? "")} onChange={(v) => setValues({ ...values, [f.key]: v })} size="sm" hideLabel /></span>)}
              {(a.fields ?? []).filter((f) => f.type === "flag").map((f) => <span key={f.key} className={css.choice}>
                <Toggle label={f.label} checked={!!Number(values[f.key] ?? f.default ?? 0)} onChange={(on) => setValues({ ...values, [f.key]: on ? 1 : 0 })} /></span>)}
              <button type="button" className={a.tone === "primary" ? css.primary : css.secondary} disabled={!!busy} onClick={() => void run(a)}>{busy === a.key ? "…" : a.label}</button>
            </Fragment>
          ))}
        </div>
      )}
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div>
  );
}

function Card({ n, onNavigate, onKey }: { n: Notice; onNavigate: (href: string, n: Notice) => void; onKey: (e: KeyboardEvent<HTMLElement>) => void }) {
  const unread = !n.readAt;
  // A comment's notification title already quotes it; the body then adds nothing.
  const body = n.body && !n.title.includes(n.body.slice(0, 24)) ? n.body : null;
  const meta = [ago(n.at), n.subject?.title && n.subject.type !== "chat" ? n.subject.title : null, n.unread && n.unread > 1 ? `${n.unread} new` : null].filter(Boolean).join(" · ");
  return (
    <li className={css.card} data-card="" data-id={n.id} data-unread={unread ? "" : undefined} tabIndex={-1} onKeyDown={onKey}
      aria-label={`${unread ? "Unread. " : ""}${n.title}${body ? `. ${body}` : ""}. ${meta}`}>
      <span className={css.lead}>{n.from ? <Avatar name={n.from.name} id={n.from.id} photoAt={n.from.photoAt} size={34} /> : <TypeIcon n={n} />}</span>
      <div className={css.main}>
        <a className={css.title} href={n.open.href} onClick={(e) => { e.preventDefault(); onNavigate(n.open.href, n); }}>{n.title}</a>
        {body ? <p className={css.body}>{body}</p> : null}
        <p className={css.meta}>{meta}</p>
        <Actions n={n} />
      </div>
      <div className={css.side}>
        {unread ? <><i className={css.dot} aria-hidden="true" /><button type="button" className={css.read} aria-label={`Mark read: ${n.title}`} title="Mark read" onClick={() => void markRead(n)}><Check size={15} aria-hidden="true" /></button></> : null}
      </div>
    </li>
  );
}

/** Several notifications of one kind on one day, folded into one line ("3 tasks for you"); open it to act on each. */
function StackCard({ stack, cards, onNavigate, onKey, focus }: { stack: NoticeStack; cards: Notice[]; onNavigate: (href: string, n: Notice) => void; onKey: (e: KeyboardEvent<HTMLElement>) => void; focus?: string | null }) {
  // The panel opened for one card (an island arrival's "Review") that is folded here: the stack opens on it.
  const holds = !!focus && cards.some((n) => n.id === focus);
  const [open, setOpen] = useState(holds);
  // Adjusted while rendering (not in an effect): when the focused card moves into this stack, the stack opens on it.
  const [held, setHeld] = useState(holds);
  if (held !== holds) { setHeld(holds); if (holds) setOpen(true); }
  const unread = cards.filter((n) => !n.readAt).length;
  const all: Notice = { ...cards[0], ids: cards.flatMap((n) => n.ids), readAt: unread ? null : cards[0].readAt, unread };
  return (
    <li className={css.stack} data-stack={stack.family} data-unread={unread ? "" : undefined}>
      <div className={css.card} data-card="" tabIndex={-1} onKeyDown={onKey} aria-label={`${unread ? `${unread} unread. ` : ""}${stack.title}. ${ago(stack.at)}`}>
        <span className={css.lead}><span className={css.typeIcon} aria-hidden="true"><Layers size={16} strokeWidth={1.9} /></span></span>
        <div className={css.main}>
          <button type="button" className={css.stackToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <span className={css.title}>{stack.title}</span><ChevronDown size={14} aria-hidden="true" data-open={open ? "" : undefined} />
          </button>
          {!open ? <p className={css.body}>{stack.body}</p> : null}
          <p className={css.meta}>{ago(stack.at)}{unread ? ` · ${unread} new` : ""}</p>
        </div>
        <div className={css.side}>
          {unread ? <><i className={css.dot} aria-hidden="true" /><button type="button" className={css.read} aria-label={`Mark read: ${stack.title}`} title="Mark all of these read" onClick={() => void markRead(all)}><Check size={15} aria-hidden="true" /></button></> : null}
        </div>
      </div>
      {open ? <ul className={css.stackItems}>{cards.map((n) => <Card key={n.id} n={n} onNavigate={onNavigate} onKey={onKey} />)}</ul> : null}
    </li>
  );
}

export function NotificationPanel({ open, onClose, anchor, id, focus }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLButtonElement | null>; id: string; focus?: string | null }) {
  const router = useRouter();
  const data = useNoticeList();
  const failed = useNoticesFailed();
  const ping = usePingStatus();
  const [filter, setFilter] = useState<Filter>("all");
  const [phone, setPhone] = useState(false);
  const [right, setRight] = useState(16);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) void refreshNotices(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia("(max-width: 899.98px)");
    const place = () => { setPhone(media.matches); const r = anchor.current?.getBoundingClientRect(); if (r) setRight(Math.max(12, Math.round(window.innerWidth - r.right - 4))); };
    place(); window.addEventListener("resize", place); media.addEventListener("change", place);
    // New arrivals while it is open: read again (the poll says the count changed).
    const changed = () => void refreshNotices(true);
    window.addEventListener("pulse:notices-changed", changed);
    // Focus moves in (unless an island arrival asked for one card, which the next effect focuses).
    const first = focus ? 0 : window.setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 30);
    return () => { window.removeEventListener("resize", place); media.removeEventListener("change", place); window.removeEventListener("pulse:notices-changed", changed); window.clearTimeout(first); };
  }, [open, anchor, focus]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    // Escape closes it from anywhere, not only with focus inside (the panel's own keys handle Escape within it).
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !panel.current?.contains(e.target as Node)) { onClose(); anchor.current?.focus(); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    const html = document.documentElement, before = html.style.overflow;
    if (phone) html.style.overflow = "hidden";
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); if (phone) html.style.overflow = before; };
  }, [open, phone, onClose, anchor]);

  // Opened for one card (an island arrival's "Review" or "Reply"): bring it into view and focus it.
  // A card folded in a stack renders once its stack has opened on it (StackCard), so it is looked for once more after that.
  useEffect(() => {
    if (!open || !focus || !data) return;
    const find = (last: boolean) => {
      const card = panel.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focus)}"]`);
      if (card) { card.scrollIntoView({ block: "nearest" }); card.focus(); card.querySelector<HTMLButtonElement>("button")?.focus(); return true; }
      if (last) panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      return false;
    };
    if (find(false)) return;
    const later = window.setTimeout(() => find(true), 60);
    return () => window.clearTimeout(later);
  }, [open, focus, data, filter]);
  const rows = useMemo(() => (data?.rows ?? []).filter((n) => matches(n, filter)), [data, filter]);
  const stacks = useMemo(() => new Map((data?.stacks ?? []).map((x) => [x.id, x])), [data]);
  // Each priority's cards in the server's order; a stack takes the place of its newest card and holds the others.
  const groups = GROUPS.map(([g, title]) => {
    const items: ({ n: Notice } | { stack: NoticeStack; cards: Notice[] })[] = [], placed = new Set<string>();
    for (const n of rows.filter((x) => priorityOf(x) === g)) {
      const stack = n.stack ? stacks.get(n.stack) : undefined;
      if (!stack) { items.push({ n }); continue; }
      if (placed.has(stack.id)) continue;
      placed.add(stack.id);
      const cards = rows.filter((x) => x.stack === stack.id);
      items.push(cards.length > 1 ? { stack, cards } : { n });
    }
    return { g, title, items, count: items.reduce((k, x) => k + ("stack" in x ? x.cards.length : 1), 0) };
  }).filter((x) => x.items.length);
  const unread = data?.counts.unread ?? 0;
  if (!open || typeof document === "undefined") return null;

  const close = () => { onClose(); anchor.current?.focus(); };
  const navigate = (href: string, n: Notice) => { void markRead(n); onClose(); router.push(href); };
  const cards = () => [...(body.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])];
  const moveFrom = (current: HTMLElement, step: number | "first" | "last") => {
    const all = cards(); if (!all.length) return;
    const i = all.indexOf(current);
    const next = step === "first" ? all[0] : step === "last" ? all[all.length - 1] : all[Math.min(all.length - 1, Math.max(0, i + step))];
    next?.focus();
  };
  const onCardKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveFrom(e.currentTarget, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveFrom(e.currentTarget, -1); }
    else if (e.key === "Home") { e.preventDefault(); moveFrom(e.currentTarget, "first"); }
    else if (e.key === "End") { e.preventDefault(); moveFrom(e.currentTarget, "last"); }
    else if (e.key === "Enter") { e.preventDefault(); e.currentTarget.querySelector<HTMLAnchorElement>("a")?.click(); }
  };
  const onPanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown" && !(e.target as HTMLElement).closest("[data-card], input, select")) { e.preventDefault(); cards()[0]?.focus(); return; }
    if (e.key !== "Tab") return;
    // Focus stays inside while it is open; Escape is the way out.
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, [tabindex='0']") ?? [])];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div className={css.layer} data-phone={phone ? "" : undefined}>
      <section ref={panel} id={id} className={css.panel} data-float-sheet="" role="dialog" aria-modal={phone} aria-labelledby={`${id}-title`} style={phone ? undefined : { right }} onKeyDown={onPanelKey}>
        <header className={css.head}>
          <h2 id={`${id}-title`}>Notifications</h2>
          {/* QA-1024 (R014): the bell's number is what needs you; the panel names it beside every unread (bell 2 vs panel 53). */}
          <span className={css.count} aria-live="polite">{data ? unread ? `${data.counts.important ? `${data.counts.important} ${data.counts.important === 1 ? "needs" : "need"} you · ` : ""}${unread} unread` : "All read" : ""}</span>
          <button type="button" className={css.headBtn} aria-label="Mark all read" onClick={() => void markAllRead()} disabled={!unread} data-autofocus={phone ? undefined : ""}><CheckCheck size={15} aria-hidden="true" /><span>Mark all read</span></button>
          <button type="button" className={css.close} aria-label="Close notifications" onClick={close} data-autofocus={phone ? "" : undefined}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className={css.filters} role="toolbar" aria-label="Show">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}{f.id === "unread" && unread ? <b>{unread}</b> : null}</button>)}
        </div>
        <div ref={body} className={css.scroll}>
          {!data && failed ? <div className={css.empty} role="alert"><p><b>Notifications did not load</b>Pulse could not be reached. Your notifications are safe.</p>
              <button type="button" className={css.secondary} onClick={() => void refreshNotices(true)}>Try again</button></div>
            : !data ? <div className={css.skeleton} aria-label="Loading notifications" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>
            : groups.length ? groups.map(({ g, title, items, count }) => (
              <section key={g} className={css.group} data-priority={g} aria-labelledby={`${id}-${g}`}>
                <h3 id={`${id}-${g}`}>{title}<span>{count}</span></h3>
                <ul>{items.map((x) => "stack" in x ? <StackCard key={x.stack.id} stack={x.stack} cards={x.cards} onNavigate={navigate} onKey={onCardKey} focus={focus} />
                  : <Card key={x.n.id} n={x.n} onNavigate={navigate} onKey={onCardKey} />)}</ul>
              </section>
            ))
            : <div className={css.empty}>
                <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: "happy", size: 72, uid: "notices-empty" }) }} />
                <p><b>{filter === "all" ? "You’re all caught up" : "Nothing here"}</b>{filter === "all" ? "New requests, mentions and updates land here, and Pip shows them as they arrive." : "Try another filter."}</p>
              </div>}
        </div>
        {ping ? <p className={css.ping}>{ping}{/^Enable/.test(ping) ? <button type="button" onClick={() => window.dispatchEvent(new Event("pulse:enable-browser-pings"))}>Turn on</button> : null}</p> : null}
        <footer className={css.foot}>
          <Link href="/notifications" className={css.inbox} onClick={onClose}><Inbox size={15} aria-hidden="true" />All notifications</Link>
          <Link href="/notifications#ping-settings" className={css.settings} onClick={onClose} aria-label="Notification settings"><Settings2 size={15} aria-hidden="true" /><span>Settings</span></Link>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
