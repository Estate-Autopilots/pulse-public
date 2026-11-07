"use client";
// CHATS-2 premium email: your own Gmail, read-only, at Gmail's standard. Tabs (Primary, Promotions, Social, Updates),
// search, labels, unread; a thread reads as cards with the newest open, HTML in a sandboxed frame (no scripts, no
// forms, remote images only when you ask), tracking links shown as their domain, quoted text folded away, attachments
// as chips with previews. Pin and snooze live on this device. "Make a task" turns a mail into a task that links back.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlarmClock, ArrowLeft, ChevronDown, ExternalLink, File as FileIcon, Image as ImageIcon, Inbox, ListChecks, Lock, Mail, Paperclip, PenLine, Pin, PinOff, RefreshCw, Search, Star, Tag, X } from "lucide-react";
import { Compose } from "../company/actions";
import { openCreate } from "../create";
import { Avatar } from "../ui";
import { fileSize, linkDomain, listTime, segments, splitQuoted } from "../lib/chat-format.mjs";
import { get } from "./net";
import { useFitHeight } from "./parts";
import css from "./chats.module.css";

export type EmailRow = { id: string; threadId: string; from: string; fromName: string; fromEmail: string; to?: string; subject: string; date: string; at: string | null; snippet: string; unread: boolean;
  hasAttachment: boolean; category: string; labels: string[]; starred: boolean; important: boolean };
export type EmailMessage = EmailRow & { cc: string; body: string; html: string | null; remoteImages: number; attachments: { name: string; mime: string; size: number; url: string }[] };
export type EmailData = { rows: EmailRow[]; thread?: EmailMessage[]; nextCursor?: string | null; sendEnabled: boolean; account: string; labels?: string[]; query?: string;
  /** POLISH-1: when Pulse last read this page from Google; `stale` answers came from that read while a fresh one runs. */
  syncedAt?: string; stale?: boolean };

const TABS: [string, string][] = [["primary", "Primary"], ["promotions", "Promotions"], ["social", "Social"], ["updates", "Updates"]];
const never = () => () => {};
// Lists are kept in memory (and the latest page per view on this device) so going back is instant; bodies only in memory.
const lists = new Map<string, EmailData>(), threads = new Map<string, EmailMessage[]>();
const LIST_KEY = "pulse.mail.v1";
type Local = { viewer: string; pinned: string[]; snoozed: Record<string, string>; lists: Record<string, EmailData> };
function local(): Local {
  const viewer = document.body.dataset.viewer ?? "";
  try { const d = JSON.parse(localStorage.getItem(LIST_KEY) ?? "null") as Local | null; if (d?.viewer === viewer) return d; } catch { /* broken entry */ }
  return { viewer, pinned: [], snoozed: {}, lists: {} };
}
function saveLocal(change: (l: Local) => Local) { try { localStorage.setItem(LIST_KEY, JSON.stringify(change(local()))); } catch { /* full */ } }
/** POLISH-1: a phone that has never read mail reads the inbox's first page in the background while Chats is open, so
 *  the first tap on Email draws at once (Google's first read takes about two seconds). Once per phone. */
export function warmMail() {
  const key = "inbox|primary|0|";
  try { if (local().lists[key]) return; } catch { return; }
  void get<EmailData>("inbox?category=primary").then((d) => saveLocal((l) => ({ ...l, lists: { ...l.lists, [key]: d } }))).catch(() => {});
}

export function EmailApp({ initial, error: initialError }: { initial: EmailData | null; error?: string }) {
  const params = useSearchParams();
  const ready = useSyncExternalStore(never, () => true, () => false);
  const [tab, setTab] = useState(params.get("category") ?? "primary"), [unread, setUnread] = useState(false), [q, setQ] = useState(params.get("q") ?? ""), [search, setSearch] = useState(params.get("q") ?? "");
  const [view, setView] = useState<"inbox" | "starred" | "pinned" | "snoozed" | `label:${string}`>("inbox");
  const key = `${view}|${tab}|${unread ? 1 : 0}|${search}`;
  const [data, setData] = useState<EmailData | null>(initial), [error, setError] = useState(initialError ?? ""), [busy, setBusy] = useState(false), [more, setMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(params.get("thread")), [prefs, setPrefs] = useState<Pick<Local, "pinned" | "snoozed">>({ pinned: [], snoozed: {} });
  useEffect(() => { queueMicrotask(() => { const l = local(); setPrefs({ pinned: l.pinned, snoozed: l.snoozed }); if (!initial && l.lists[key]) setData(l.lists[key]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useCallback((cursor?: string) => {
    const p = new URLSearchParams();
    if (view === "starred") p.set("starred", "1"); else if (view.startsWith("label:")) p.set("label", view.slice(6)); else if (view === "inbox") p.set("category", tab);
    if (unread) p.set("unread", "1"); if (search) p.set("q", search); if (cursor) p.set("cursor", cursor);
    return p.toString();
  }, [view, tab, unread, search]);
  const load = useCallback(async (fresh = false) => {
    if (view === "pinned" || view === "snoozed") return;
    const hit = lists.get(key); if (hit && !fresh) { setData(hit); return; }
    setBusy(true); setError("");
    try {
      const keep = (d: EmailData) => { lists.set(key, d); setData(d); saveLocal((l) => ({ ...l, lists: { ...Object.fromEntries(Object.entries(l.lists).slice(-6)), [key]: d } })); };
      const d = await get<EmailData>(`inbox?${query()}${fresh ? "&fresh=1" : ""}`); keep(d);
      // POLISH-1: drawn from Pulse's last read; now the fresh one (it was already started behind that answer).
      if (d.stale && !fresh) keep(await get<EmailData>(`inbox?${query()}&fresh=1`));
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [key, query, view]);
  useEffect(() => { if (initial && key === "inbox|primary|0|" && !lists.has(key)) { lists.set(key, initial); return; } const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [key, load, initial]);
  async function next() {
    if (!data?.nextCursor || more) return; setMore(true);
    try { const d = await get<EmailData>(`inbox?${query(data.nextCursor)}`); const merged = { ...d, rows: [...data.rows, ...d.rows.filter((r) => !data.rows.some((x) => x.id === r.id))] }; lists.set(key, merged); setData(merged); }
    catch (e) { setError((e as Error).message); } finally { setMore(false); }
  }
  const [now] = useState(() => Date.now());
  // One row per conversation (the newest message), pinned first; snoozed ones wait until their time.
  const rows = useMemo(() => {
    const seen = new Set<string>(); const out: EmailRow[] = [];
    const source = view === "pinned" || view === "snoozed" ? [...lists.values()].flatMap((d) => d.rows) : data?.rows ?? [];
    for (const r of source) { if (seen.has(r.threadId)) continue; seen.add(r.threadId); out.push(r); }
    const snoozedNow = (r: EmailRow) => !!prefs.snoozed[r.threadId] && Date.parse(prefs.snoozed[r.threadId]) > now;
    const shown = view === "pinned" ? out.filter((r) => prefs.pinned.includes(r.threadId)) : view === "snoozed" ? out.filter(snoozedNow) : out.filter((r) => !snoozedNow(r));
    return shown.sort((a, b) => (prefs.pinned.includes(b.threadId) ? 1 : 0) - (prefs.pinned.includes(a.threadId) ? 1 : 0));
  }, [data, prefs, view, now]);
  const togglePin = (id: string) => { const pinned = prefs.pinned.includes(id) ? prefs.pinned.filter((x) => x !== id) : [id, ...prefs.pinned].slice(0, 50); setPrefs({ ...prefs, pinned }); saveLocal((l) => ({ ...l, pinned })); };
  const snooze = (id: string, until: string | null) => { const snoozed = { ...prefs.snoozed }; if (until) snoozed[id] = until; else delete snoozed[id]; setPrefs({ ...prefs, snoozed }); saveLocal((l) => ({ ...l, snoozed })); if (until && selected === id) setSelected(null); };
  const open = (r: EmailRow) => { setSelected(r.threadId); window.history.replaceState(null, "", `/chats?source=email&thread=${encodeURIComponent(r.threadId)}`); };
  // POLISH-1: Android back in an open mail returns to the mail list (the phone app asks the page first).
  useEffect(() => {
    const back = (e: Event) => { if (!selected) return; e.preventDefault(); setSelected(null); window.history.replaceState(null, "", "/chats?source=email"); };
    window.addEventListener("pulse:back", back);
    return () => window.removeEventListener("pulse:back", back);
  }, [selected]);
  const row = rows.find((r) => r.threadId === selected) ?? null;
  const box = useRef<HTMLDivElement>(null); useFitHeight(box);
  return <div ref={box} className={css.app} data-grow="" data-view={selected ? "chat" : "list"} data-mail="">
    <aside className={css.side} aria-label="Email">
      <header className={css.sideHead}>
        <Link href="/chats" className={css.iconBtn} aria-label="Back to chats" scroll={false}><ArrowLeft size={20} aria-hidden="true" /></Link>
        <h2>Email</h2>
        <button type="button" className={css.iconBtn} onClick={() => void load(true)} aria-label="Refresh" title="Refresh" disabled={busy}><RefreshCw size={17} aria-hidden="true" data-spin={busy || undefined} /></button>
        <ComposeControl enabled={!!data?.sendEnabled} />
      </header>
      <form className={css.search} role="search" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setView("inbox"); }}>
        <Search size={16} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all your mail" aria-label="Search mail" enterKeyHint="search" />
        {search ? <button type="button" className={css.clear} onClick={() => { setQ(""); setSearch(""); }} aria-label="Clear search"><X size={15} aria-hidden="true" /></button> : null}
      </form>
      {!search ? <div className={css.filters} role="tablist" aria-label="Inbox tabs">{TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === "inbox" && tab === k} onClick={() => { setView("inbox"); setTab(k); }}>{l}</button>)}</div> : <p className={css.searchNote}>Results from all your mail for “{search}”</p>}
      <div className={css.mailViews} role="group" aria-label="More views">
        <button type="button" aria-pressed={unread} onClick={() => setUnread(!unread)}><Mail size={14} aria-hidden="true" />Unread</button>
        <button type="button" aria-pressed={view === "starred"} onClick={() => setView(view === "starred" ? "inbox" : "starred")}><Star size={14} aria-hidden="true" />Starred</button>
        <button type="button" aria-pressed={view === "pinned"} onClick={() => setView(view === "pinned" ? "inbox" : "pinned")}><Pin size={14} aria-hidden="true" />Pinned</button>
        <button type="button" aria-pressed={view === "snoozed"} onClick={() => setView(view === "snoozed" ? "inbox" : "snoozed")}><AlarmClock size={14} aria-hidden="true" />Snoozed</button>
        {data?.labels?.length ? <LabelMenu labels={data.labels} active={view.startsWith("label:") ? view.slice(6) : null} onPick={(l) => setView(l ? `label:${l}` : "inbox")} /> : null}
      </div>
      {error ? <p className={css.sideError} role="alert">{error}<button type="button" onClick={() => void load(true)}>Retry</button></p> : null}
      <nav className={css.rows} aria-label="Conversations" aria-busy={busy || undefined} onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void next(); }}>
        {!ready && !data ? null : rows.map((r) => <button key={r.threadId} type="button" data-chat-row="" className={css.mailRow} data-unread={r.unread || undefined} aria-current={r.threadId === selected ? "true" : undefined} onClick={() => open(r)}>
          <Avatar name={r.fromName} size={40} />
          <span className={css.rowMain}>
            <span className={css.rowTop}><b>{r.fromName}</b>{prefs.pinned.includes(r.threadId) ? <Pin size={12} aria-label="Pinned" className={css.pinned} /> : null}<time dateTime={r.at ?? undefined}>{r.at ? listTime(r.at) : ""}</time></span>
            <span className={css.mailSubject}>{r.subject}</span>
            <span className={css.rowBottom}><span className={css.preview}>{r.snippet}</span>{r.hasAttachment ? <Paperclip size={13} aria-label="Has attachments" /> : null}{r.starred ? <Star size={13} aria-label="Starred" className={css.star} /> : null}</span>
            {r.labels.length || (view !== "inbox" && r.category !== "primary") ? <span className={css.labels}>{r.category !== "primary" && view !== "inbox" ? <em>{r.category}</em> : null}{r.labels.slice(0, 3).map((l) => <em key={l}>{l}</em>)}</span> : null}
          </span>
        </button>)}
        {ready && !busy && !rows.length ? <p className={css.empty}>{view === "pinned" ? "Pin a conversation to keep it on top." : view === "snoozed" ? "Nothing snoozed." : search ? "No mail matches." : unread ? "No unread mail here." : "Nothing in this tab."}</p> : null}
        {busy && !rows.length ? Array.from({ length: 6 }, (_, i) => <div key={i} className={css.skRow}><span className={css.skAvatar} /><span><span className={css.skLine} style={{ width: "40%" }} /><span className={css.skLine} style={{ width: "80%" }} /></span></div>) : null}
        {data?.nextCursor && view !== "pinned" && view !== "snoozed" ? <button type="button" className={css.searchAll} onClick={() => void next()} disabled={more}>{more ? "Loading…" : "More conversations"}</button> : null}
      </nav>
      <footer className={css.sideFoot}><Lock size={12} aria-hidden="true" /><span>{data?.account ?? "Your mailbox"} · read-only · only you see it</span></footer>
    </aside>
    <section className={css.pane} aria-label="Email conversation">
      {selected ? <Reader key={selected} threadId={selected} row={row} pinned={prefs.pinned.includes(selected)} snoozedUntil={prefs.snoozed[selected] ?? null} onBack={() => { setSelected(null); window.history.replaceState(null, "", "/chats?source=email"); }}
        onPin={() => togglePin(selected)} onSnooze={(u) => snooze(selected, u)} account={data?.account ?? ""} />
        : <div className={css.welcome}><span className={css.welcomeIcon} aria-hidden="true"><Inbox size={34} /></span><h2>Your email</h2><p>Pick a conversation to read it. Reading here doesn’t change Gmail: unread stays unread there.</p><small><Lock size={12} aria-hidden="true" />Images from senders load only when you ask.</small></div>}
    </section>
  </div>;
}

function LabelMenu({ labels, active, onPick }: { labels: string[]; active: string | null; onPick: (l: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return <span className={css.menuWrap}><button type="button" aria-pressed={!!active} aria-expanded={open} onClick={() => setOpen(!open)}><Tag size={14} aria-hidden="true" />{active ?? "Labels"}<ChevronDown size={13} aria-hidden="true" /></button>
    {open ? <span className={css.menu} role="menu" onClick={() => setOpen(false)}>{active ? <button type="button" role="menuitem" onClick={() => onPick(null)}><X size={14} aria-hidden="true" />All mail</button> : null}{labels.map((l) => <button key={l} type="button" role="menuitem" onClick={() => onPick(l)}><Tag size={14} aria-hidden="true" />{l}</button>)}</span> : null}</span>;
}

/** Sending waits for the owner to grant Pulse the Gmail send permission; until then the control says so and points to Gmail. */
function ComposeControl({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  if (enabled) return <Compose enabled />;
  return <span className={css.menuWrap}><button type="button" className={css.composeBtn} onClick={() => setOpen(!open)} aria-expanded={open}><PenLine size={15} aria-hidden="true" />Compose<small>send scope pending</small></button>
    {open ? <span className={css.popover} role="dialog" aria-label="Sending from Pulse">
      <b>Sending from Pulse isn’t switched on yet</b>
      <span>Pulse can read your mail but not send it: the owner hasn’t yet given Pulse Google’s “send email” permission (the gmail.send scope) for company mailboxes. Until then, write and reply in Gmail; the conversation shows up here as usual.</span>
      <a href="https://mail.google.com/mail/u/0/#inbox?compose=new" target="_blank" rel="noreferrer" className={css.primary}><ExternalLink size={14} aria-hidden="true" />Write in Gmail</a>
    </span> : null}</span>;
}

const SNOOZE: [string, () => string][] = [
  ["Later today (6 pm)", () => istAt(0, 18)], ["Tomorrow (9 am)", () => istAt(1, 9)], ["Next week (Mon 9 am)", () => istAt(((8 - new Date(Date.now() + 330 * 60000).getUTCDay()) % 7) || 7, 9)],
];
function istAt(days: number, hour: number) { const d = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); return new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000 + hour * 3600000 - 330 * 60000).toISOString(); }

function Reader({ threadId, row, pinned, snoozedUntil, onBack, onPin, onSnooze, account }: { threadId: string; row: EmailRow | null; pinned: boolean; snoozedUntil: string | null; onBack: () => void; onPin: () => void; onSnooze: (until: string | null) => void; account: string }) {
  const [now] = useState(() => Date.now());
  const [messages, setMessages] = useState<EmailMessage[] | null>(threads.get(threadId) ?? null), [error, setError] = useState(""), [openIds, setOpenIds] = useState<Set<string>>(new Set()), [snoozeMenu, setSnoozeMenu] = useState(false);
  useEffect(() => {
    if (threads.has(threadId)) return;
    let live = true;
    void get<EmailData>(`inbox?thread=${encodeURIComponent(threadId)}`).then((d) => { const t = d.thread ?? []; threads.set(threadId, t); if (live) setMessages(t); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [threadId]);
  const last = messages?.at(-1);
  const subject = messages?.[0]?.subject ?? row?.subject ?? "";
  const labels = [...new Set((messages ?? []).flatMap((m) => m.labels))];
  function task() {
    const from = last ?? row; if (!from) return;
    openCreate({ kind: "task", title: subject.slice(0, 120), notes: `E-mail from ${from.fromName} <${from.fromEmail}>: “${subject}”\nOpen in Pulse: /chats?source=email&thread=${encodeURIComponent(threadId)}\nOpen in Gmail: https://mail.google.com/mail/u/0/#all/${threadId}`,
      source: { label: `From an e-mail by ${from.fromName}`, quote: subject } });
  }
  return <div className={css.chat}>
    <header className={css.head}>
      <button type="button" className={`${css.iconBtn} ${css.back}`} onClick={onBack} aria-label="Back to email"><ArrowLeft size={20} aria-hidden="true" /></button>
      <span className={css.mailTitle}><b>{subject || "(no subject)"}</b>{labels.length || row?.category ? <span className={css.labels}>{row?.category ? <em>{row.category}</em> : null}{labels.slice(0, 4).map((l) => <em key={l}>{l}</em>)}</span> : null}</span>
      <button type="button" className={css.chipBtn} onClick={task} aria-label="Make a task"><ListChecks size={15} aria-hidden="true" /><span>Make a task</span></button>
      <button type="button" className={css.iconBtn} onClick={onPin} aria-label={pinned ? "Unpin" : "Pin to the top"} title={pinned ? "Unpin" : "Pin to the top"} aria-pressed={pinned}>{pinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}</button>
      <span className={css.menuWrap}><button type="button" className={css.iconBtn} onClick={() => setSnoozeMenu(!snoozeMenu)} aria-label="Snooze" title="Snooze" aria-expanded={snoozeMenu}><AlarmClock size={17} aria-hidden="true" /></button>
        {snoozeMenu ? <span className={css.menu} role="menu" onClick={() => setSnoozeMenu(false)}>{snoozedUntil ? <button type="button" role="menuitem" onClick={() => onSnooze(null)}><X size={14} aria-hidden="true" />Unsnooze</button> : null}
          {SNOOZE.map(([l, at]) => <button key={l} type="button" role="menuitem" onClick={() => onSnooze(at())}><AlarmClock size={14} aria-hidden="true" />{l}</button>)}</span> : null}</span>
      <a className={css.iconBtn} href={`https://mail.google.com/mail/u/0/#all/${threadId}`} target="_blank" rel="noreferrer" aria-label="Open in Gmail" title="Open in Gmail"><ExternalLink size={17} aria-hidden="true" /></a>
    </header>
    {error ? <p className={css.chatError} role="alert">{error}</p> : null}
    <div className={css.mailBody}>
      {!messages && !error ? <div className={css.chatEmpty}><span className={css.spinner} aria-label="Opening the conversation" /></div> : null}
      {snoozedUntil && Date.parse(snoozedUntil) > now ? <p className={css.snoozed}><AlarmClock size={14} aria-hidden="true" />Snoozed until {new Date(snoozedUntil).toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} on this device</p> : null}
      {messages?.map((m, i) => { const expanded = i === messages.length - 1 || openIds.has(m.id) || messages.length <= 2;
        return <article key={m.id} className={css.mailCard} data-open={expanded || undefined}>
          <button type="button" className={css.mailHead} onClick={() => setOpenIds((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} aria-expanded={expanded}>
            <Avatar name={m.fromName} size={36} />
            <span className={css.rowMain}><span className={css.rowTop}><b>{m.fromName}</b><small>{m.fromEmail}</small><time dateTime={m.at ?? undefined}>{m.at ? new Date(m.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : m.date}</time></span>
              <span className={css.preview}>{expanded ? `to ${(m.to ?? "").replace(account, "me") || "me"}${m.cc ? `, cc ${m.cc}` : ""}` : m.snippet}</span></span>
          </button>
          {expanded ? <>{m.html ? <HtmlBody html={m.html} remote={m.remoteImages} /> : <TextBody text={m.body} />}
            {m.attachments.length ? <div className={css.mailFiles}>{m.attachments.map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className={css.mailFile}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a preview of the attachment from the viewer's own mailbox */}
              {/^image\/(png|jpeg|gif|webp)$/.test(a.mime) ? <img src={a.url} alt="" loading="lazy" /> : <span className={css.fileGlyph}>{a.mime.startsWith("image/") ? <ImageIcon size={18} /> : <FileIcon size={18} />}</span>}
              <span><b>{a.name}</b><small>{fileSize(a.size)}</small></span></a>)}</div> : null}</> : null}
        </article>; })}
    </div>
  </div>;
}

/** The mail's HTML in a frame that cannot run scripts or submit forms; remote images wait for "Show images". */
function HtmlBody({ html, remote }: { html: string; remote: number }) {
  const [images, setImages] = useState(false), frame = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: ${images ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff;color:#1f1f1f;font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}body{padding:4px 2px 12px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#4a35c0}
    details.pulse-quote>summary{display:inline-block;cursor:pointer;list-style:none;margin:8px 0;padding:0 8px;border-radius:8px;background:#ececf3;color:#555;font-weight:700;letter-spacing:1px;line-height:18px}details.pulse-quote>summary::-webkit-details-marker{display:none}
    blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #d5d5e0;color:#555}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`, [html, images]);
  useEffect(() => {
    const el = frame.current; if (!el) return;
    let ro: ResizeObserver | null = null;
    const fit = () => { const d = el.contentDocument; if (!d?.documentElement) return; el.style.height = `${Math.max(60, d.documentElement.scrollHeight)}px`; };
    const onLoad = () => { fit(); const d = el.contentDocument; if (d?.body) { ro = new ResizeObserver(fit); ro.observe(d.body); d.addEventListener("toggle", fit, true); } };
    el.addEventListener("load", onLoad); return () => { el.removeEventListener("load", onLoad); ro?.disconnect(); };
  }, [doc]);
  return <div className={css.htmlMail}>
    {remote && !images ? <p className={css.imagesBar}><ImageIcon size={14} aria-hidden="true" />{remote} image{remote === 1 ? "" : "s"} from the sender {remote === 1 ? "is" : "are"} hidden (they can tell the sender you opened this).<button type="button" onClick={() => setImages(true)}>Show images</button></p> : null}
    <iframe ref={frame} title="E-mail message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} referrerPolicy="no-referrer" />
  </div>;
}

/** A plain-text mail: links as their domain, the quoted earlier message folded away. */
function TextBody({ text }: { text: string }) {
  const { main, quoted } = splitQuoted(text);
  const render = (s: string) => segments(s).map((x, i) => x.type === "link" ? <span key={i}><a href={x.value} target="_blank" rel="noreferrer" title={x.value} className={css.linkChip}>{linkDomain(x.value)}<ExternalLink size={11} aria-hidden="true" /></a>{x.rest}</span> : <span key={i}>{x.value}</span>);
  return <div className={css.textMail}><p>{render(main)}</p>{quoted ? <details className={css.quoted}><summary title="Show the quoted message">•••</summary><p>{render(quoted)}</p></details> : null}</div>;
}
