"use client";
// UX-SIMPLE (28 Oct 2026): what a chat command will do, shown above the message box before anything changes (Confirm
// or Cancel), and the chat's command palette (every command, grouped and searchable; Ctrl+/ in the box).
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Command, ExternalLink, Search, Share2, X } from "lucide-react";
import { openInPanel } from "./workspace/tabs";
import type { ChatCommand, CommandCard } from "./commands";
import css from "./command-card.module.css";

/** Shows a command card above the open conversation's box from anywhere (a message's menu, for example). */
export const CARD_EVENT = "pulse:command-card";
export const showCommandCard = (card: CommandCard) => window.dispatchEvent(new CustomEvent<CommandCard>(CARD_EVENT, { detail: card }));

export function CommandCardView({ card, onClose, onShare }: { card: CommandCard; onClose: () => void; onShare: (text: string) => void }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState(""), [error, setError] = useState(card.error ?? "");
  const confirmRef = useRef<HTMLButtonElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { (confirmRef.current ?? closeRef.current)?.focus({ preventScroll: true }); }, [card]);
  useEffect(() => { if (!done) return; const t = setTimeout(onClose, 1800); return () => clearTimeout(t); }, [done, onClose]);
  async function confirm() {
    if (!card.confirm || busy) return;
    setBusy(true); setError("");
    try { setDone((await card.confirm.run()) || "Done"); } catch (e) { setError((e as Error).message || "That did not go through. Try again."); } finally { setBusy(false); }
  }
  async function runItem(run: () => Promise<string | void>) {
    if (busy) return; setBusy(true); setError("");
    try { setDone((await run()) || "Done"); } catch (e) { setError((e as Error).message || "That did not go through. Try again."); } finally { setBusy(false); }
  }
  const Icon = card.icon;
  return <section className={css.card} role="dialog" aria-label={card.title} data-command-card="" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
    <header className={css.head}>
      {Icon ? <span className={css.icon} aria-hidden="true"><Icon size={16} /></span> : null}
      <h3>{card.title}</h3>
      <button ref={closeRef} type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={15} aria-hidden="true" /></button>
    </header>
    {card.lines?.length ? <dl className={css.lines}>{card.lines.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}</dl> : null}
    {card.items?.length ? <ul className={css.items}>{card.items.map((it, i) => <li key={`${it.title}-${i}`}>
      {it.run ? <button type="button" disabled={busy} data-card-pick="" onClick={() => void runItem(it.run!)}><b>{it.title}</b>{it.sub ? <small>{it.sub}</small> : null}</button>
        : it.href ? <button type="button" onClick={() => { openInPanel({ href: it.href!, title: it.title }); }}><b>{it.title}</b>{it.sub ? <small>{it.sub}</small> : null}</button>
        : <span><b>{it.title}</b>{it.sub ? <small>{it.sub}</small> : null}</span>}</li>)}</ul> : null}
    {card.note && !done ? <p className={css.note}>{card.note}</p> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {done ? <p className={css.done} role="status"><Check size={15} aria-hidden="true" />{done}</p> : <footer className={css.actions}>
      {card.confirm ? <button ref={confirmRef} type="button" className={css.primary} data-danger={card.confirm.danger ? "" : undefined} onClick={() => void confirm()} disabled={busy} data-command-confirm="">
        {busy ? "Working…" : card.confirm.label}</button> : null}
      {card.open ? <button type="button" className={css.secondary} onClick={() => { openInPanel({ href: card.open!.href, title: card.open!.title ?? card.title }); if (!card.confirm) onClose(); }}>
        <ExternalLink size={14} aria-hidden="true" />{card.open.label}</button> : null}
      {card.share ? <button type="button" className={css.secondary} onClick={() => { onShare(card.share!); onClose(); }}><Share2 size={14} aria-hidden="true" />Share in chat</button> : null}
      {card.more ? <button type="button" className={css.quiet} onClick={() => { card.more!.run(); onClose(); }}>{card.more.label}</button> : null}
      {card.confirm ? <button type="button" className={css.quiet} onClick={onClose}>Cancel</button> : null}
    </footer>}
  </section>;
}

/** Every command this chat offers, grouped, with a search box: picking one puts it in the box (or runs it). */
export function CommandPalette({ commands, groupOf, onPick, onClose }: { commands: ChatCommand[]; groupOf: (name: string) => string; onPick: (c: ChatCommand) => void; onClose: () => void }) {
  const [q, setQ] = useState(""), [at, setAt] = useState(0);
  const list = useMemo(() => { const w = q.trim().toLowerCase().replace(/^\//, ""); return commands.filter((c) => !w || c.name.includes(w) || c.hint.toLowerCase().includes(w)); }, [commands, q]);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const choose = (c: ChatCommand | undefined) => { if (c) onPick(c); };
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={css.palette} role="dialog" aria-modal="true" aria-label="Chat commands" data-command-palette="">
      <label className={css.search}><Search size={16} aria-hidden="true" />
        <input ref={box} value={q} placeholder="What do you want to do?" aria-label="Search commands" onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = list.length || 1; setAt((a) => (a + (e.key === "ArrowUp" ? n - 1 : 1)) % n); }
            else if (e.key === "Enter") { e.preventDefault(); choose(list[at]); }
          }} /></label>
      <div className={css.paletteList} role="listbox" aria-label="Commands">
        {list.map((c, i) => <div key={c.name} role="presentation">
          {i === 0 || groupOf(list[i - 1].name) !== groupOf(c.name) ? <p className={css.group}>{groupOf(c.name)}</p> : null}
          <button type="button" role="option" aria-selected={i === at} className={css.option} data-command={c.name} onMouseEnter={() => setAt(i)} onClick={() => choose(c)}>
            <span className={css.icon} aria-hidden="true"><c.icon size={16} /></span><span><b>/{c.name}</b><small>{c.hint}</small></span></button></div>)}
        {!list.length ? <p className={css.empty}>No command does that yet. Try other words.</p> : null}
      </div>
      <p className={css.foot}><Command size={13} aria-hidden="true" /><span><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>↵</kbd> pick · <kbd>Esc</kbd> close · <kbd>Ctrl</kbd><kbd>/</kbd> opens this</span></p>
    </div>
  </div>;
}
