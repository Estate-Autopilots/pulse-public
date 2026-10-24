"use client";
// CHAT-SHELL (22 Oct 2026): the chat-first home. With no conversation open, the big column greets the person and holds
// one box that does everything: "@ravi …" starts a message to Ravi, "/" lists the commands, and anything else is read
// for a place in Pulse ("my steps", "the Riverside project", a Drive link), which opens beside the chat. Below it the
// conversations waiting for them, and a few places one tap away.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, AtSign, CircleCheck, FolderKanban, LayoutDashboard, ListChecks, MessageCircle, SquarePen, User, Users } from "lucide-react";
import { Avatar } from "../../ui";
import { decide, detectIntent, type Intent } from "../../lib/chat-intent.mjs";
import { panelTarget } from "../../lib/panel-target.mjs";
import { listTime, preview, sortChats } from "../../lib/chat-format.mjs";
import { GroupAvatar } from "../parts";
import { homeCommands, runHomeCommand } from "./commands";
import { openInPanel, showLauncher } from "./tabs";
import { PanelToggle } from "./panel";
import { NeedsYou } from "./needs";
import { useIntentContext } from "./intent";
import type { ChatData, Member } from "../types";
import css from "./workspace.module.css";

export const HOME_COOKIE = "pulse.home.start";
const still = () => () => {};
const greet = () => { const h = new Date().getHours(); return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

type Row = { key: string; label: string; sub: string; run: () => void; icon: "person" | "place" | "command" | "link"; person?: Member };

export function Start({ bar, data, role, modulesOff, onChoose, onDirect, onNew, onGroup }: { /** The header row's chat slot (a computer). */ bar?: HTMLElement | null; data: ChatData; role?: string; modulesOff?: readonly string[];
  onChoose: (id: string) => void; onDirect: (p: Member, draft: string) => void; onNew: () => void; onGroup: () => void }) {
  const me = data.people.find((p) => p.id === data.viewer);
  const [text, setText] = useState(""), [at, setAt] = useState(0), [said, setSaid] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // The greeting follows the viewer's clock, which the server does not know: the server snapshot is a neutral word and
  // the browser's is its own hour (a UTC server's "Good evening" against an IST phone's "Working late" was React #418).
  const hello = useSyncExternalStore(still, greet, () => null);
  useEffect(() => { if (window.matchMedia("(pointer: fine)").matches) input.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }, [text]);
  const shared = useIntentContext();
  const ctx = useMemo(() => shared ?? { viewer: data.viewer, people: data.people.map((p) => ({ id: p.id, name: p.name })), role, modulesOff }, [shared, data, role, modulesOff]);

  // What the box would do, as rows under it (↑ ↓ to choose, Enter to do it).
  const rows = ((): Row[] => {
    const t = text.trim(); if (!t) return [];
    const mention = t.match(/^@([\w.-]*)\s*([\s\S]*)$/);
    if (mention) {
      const q = mention[1].toLowerCase();
      return data.people.filter((p) => p.id !== data.viewer && `${p.username ?? ""} ${p.name}`.toLowerCase().includes(q)).slice(0, 6)
        .map((p) => ({ key: `p:${p.id}`, label: p.name, sub: mention[2] ? `Message: “${mention[2].slice(0, 60)}”` : `@${p.username ?? ""}${p.team ? ` · ${p.team}` : ""}`, icon: "person", person: p, run: () => onDirect(p, mention[2]) }));
    }
    if (t.startsWith("/")) {
      const name = t.slice(1).split(/\s/)[0];
      return homeCommands(name).map((c) => ({ key: `c:${c.name}`, label: `/${c.name}`, sub: c.hint, icon: "command",
        run: () => { if (c.takesArgs && !t.includes(" ")) { setText(`/${c.name} `); input.current?.focus(); } else { runHomeCommand(t.startsWith(`/${c.name}`) ? t : `/${c.name}`, data.viewer); setText(""); } } }));
    }
    const link = panelTarget(t, window.location.origin);
    const out: Row[] = link ? [{ key: "link", label: link.kind === "url" ? t : link.title, sub: "Open beside the chat", icon: "link", run: () => { openInPanel(t); setText(""); } }] : [];
    const found: Intent[] = detectIntent(/^(open|show|go to)\b/i.test(t) ? t : `open ${t}`, ctx);
    for (const i of found.slice(0, 4)) out.push({ key: i.id, label: i.label, sub: "Open beside the chat", icon: "place", run: () => { openInPanel({ href: i.href, title: i.label.split(" → ").pop(), coach: i.coach ?? null, reason: i.reason }); setText(""); } });
    const person = data.people.find((p) => p.id !== data.viewer && t.toLowerCase().startsWith(p.name.split(" ")[0].toLowerCase()));
    if (person) out.push({ key: `p:${person.id}`, label: `Message ${person.name}`, sub: "Starts a chat", icon: "person", person, run: () => onDirect(person, "") });
    return out;
  })();

  function submit() {
    const row = rows[at];
    if (row) { row.run(); return; }
    const t = text.trim(); if (!t) return;
    const { auto } = decide(detectIntent(t, ctx));
    if (auto) { openInPanel({ href: auto.href, title: auto.label.split(" → ").pop(), coach: auto.coach ?? null }); setText(""); return; }
    setSaid(t);
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length) { e.preventDefault(); setAt((a) => (a + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length); return; }
    if (e.key === "Tab" && rows.length && text.trim().startsWith("@") && rows[at]?.person) { e.preventDefault(); setText(`@${rows[at].person!.username ?? ""} `); return; }
    if (e.key === "Escape") { setText(""); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  }

  const mentions = useMemo(() => sortChats(data.channels.filter((c) => !c.moderationOnly && !c.duplicateOf && c.mentions)), [data.channels]);
  // Unread first, then the latest: the conversations to pick up again.
  const recent = useMemo(() => sortChats(data.channels.filter((c) => !c.moderationOnly && !c.duplicateOf && c.lastAt)).sort((a, b) => Number(!!b.unread) - Number(!!a.unread)).slice(0, 4), [data.channels]);
  const quick = [
    { label: "My tasks", icon: CircleCheck, run: () => openInPanel({ href: "/tasks?scope=me", title: "My tasks" }) },
    { label: "My steps", icon: ListChecks, run: () => openInPanel({ href: "/me/steps", title: "My steps" }) },
    { label: "Projects", icon: FolderKanban, run: () => openInPanel({ href: "/tasks?view=projects", title: "Projects" }) },
    { label: "My profile", icon: User, run: () => openInPanel({ href: `/people/${encodeURIComponent(data.viewer)}?tab=info`, title: "My profile" }) },
  ];
  return <div className={css.start}>
    {bar ? createPortal(<div className={css.startBar}><PanelToggle className={css.startToggle} /></div>, bar) : <div className={css.startTop}><PanelToggle className={css.startToggle} /></div>}
    <div className={css.startMain}>
      <h2 className={css.hello}><Avatar name={me?.name ?? "You"} id={data.viewer} photoAt={me?.photoAt} size={34} /><span>{hello ?? "Hello"}{me ? `, ${me.name.split(" ")[0]}` : ""}</span></h2>
      <p className={css.lede}>Message anyone, or ask for any place in Pulse. It opens beside the chat.</p>
      <div className={css.box} data-filled={text.trim() ? "" : undefined}>
        <textarea ref={input} rows={1} value={text} onChange={(e) => { setText(e.target.value); setAt(0); setSaid(null); }} onKeyDown={onKey} maxLength={2000} enterKeyHint="go"
          placeholder="@someone to message them · / for commands · or what you need, like “my steps”" aria-label="Message someone, or ask for a place in Pulse" />
        <div className={css.boxBar}>
          <button type="button" className={css.boxChip} onClick={() => { setText("@"); input.current?.focus(); }}><AtSign size={13} aria-hidden="true" />Mention</button>
          <button type="button" className={css.boxChip} onClick={() => { setText("/"); input.current?.focus(); }}><span aria-hidden="true">/</span>Commands</button>
          <button type="button" className={css.boxChip} onClick={() => showLauncher()}>Open beside the chat</button>
          <button type="button" className={css.go} onClick={submit} disabled={!text.trim()} aria-label="Go"><ArrowUp size={18} aria-hidden="true" /></button>
        </div>
        {rows.length ? <div className={css.rows} role="listbox" aria-label="What this does">{rows.map((r, i) => <button key={r.key} type="button" role="option" aria-selected={i === at} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); r.run(); }}>
          {r.person ? <Avatar ai={r.person.agent} name={r.person.name} id={r.person.id} photoAt={r.person.photoAt} size={26} /> : <span className={css.rowIcon} data-kind={r.icon} aria-hidden="true">{r.icon === "command" ? "/" : r.icon === "link" ? "↗" : "→"}</span>}
          <span><b>{r.label}</b><small>{r.sub}</small></span></button>)}</div> : null}
        {said && !rows.length ? <p className={css.nothing}>Nothing in Pulse matches “{said.slice(0, 60)}”. Start with @ to message someone, or try a page name such as <button type="button" onClick={() => setText("my steps")}>my steps</button>.</p> : null}
      </div>
      <div className={css.quick}>{quick.map((q) => <button key={q.label} type="button" onClick={q.run}><q.icon size={15} aria-hidden="true" />{q.label}</button>)}</div>
      <NeedsYou data={data} mentions={mentions} onChoose={onChoose} onNudge={onDirect} />
      {recent.length ? <section className={css.recent} aria-label="Recent chats">
        <h3>Recent chats</h3>
        <div className={css.recentGrid}>{recent.map((c) => <button key={c.id} type="button" onClick={() => onChoose(c.id)}>
          <GroupAvatar channel={c} size={36} />
          <span className={css.recentText}><b>{c.name}{c.unread ? <i>{c.unread > 99 ? "99+" : c.unread}</i> : null}</b><small>{preview(c, data.viewer)}</small></span>
          <time dateTime={c.lastAt ?? undefined}>{listTime(c.lastAt)}</time></button>)}</div>
      </section> : null}
      <div className={css.startFoot}>
        <button type="button" onClick={onNew}><SquarePen size={14} aria-hidden="true" />New chat</button>
        <button type="button" onClick={onGroup}><Users size={14} aria-hidden="true" />New group</button>
        <a href="/dashboard" onClick={() => { document.cookie = `${HOME_COOKIE}=dashboard; path=/; max-age=31536000; samesite=lax`; }} title="Open Pulse on the dashboard instead of the chat"><LayoutDashboard size={14} aria-hidden="true" />Use the dashboard as my home</a>
        <span className={css.lockNote}><MessageCircle size={12} aria-hidden="true" />Only the people in a conversation can read it. Messages stay {data.retentionDays} days.</span>
      </div>
    </div>
  </div>;
}
