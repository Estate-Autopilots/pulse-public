"use client";
// AI-AUTONOMY (owner, 27 Oct 2026): the board's list (a vote column, the line, its kind and status, who filed it, the
// discussion's size) and one item's panel (the details, the discussion, a comment box; leadership: the dev queue).
import { Bot, ChevronUp, Lightbulb, MessageSquare, Bug, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerSection } from "../../kit";
import { Badge, Empty } from "../../ui";
import css from "./board.module.css";

type Status = "new" | "triaged" | "fixing" | "fixed" | "wontfix";
type Kind = "bug" | "tool_needed" | "feature";
export type BoardItem = { id: string; number: number; kind: Kind; title: string; words: string; status: Status; severity: string | null; votes: number; devQueue: boolean;
  byAgent: boolean; mine: boolean; comments: number; by: string | null; createdAt: string; statusAt: string; shippedRef: string | null };
export type BoardData = { kind: string; status: string; sort: string; items: BoardItem[] };
type Detail = Omit<BoardItem, "comments" | "statusAt"> & { route: string; canTriage: boolean;
  discussion: { kind: "note" | "status"; value: string | null; note: string | null; at: string; who: string; agent: boolean }[] };

const KIND: Record<Kind, { label: string; Icon: typeof Bug }> = { bug: { label: "Bug", Icon: Bug }, tool_needed: { label: "Tool needed", Icon: Wrench }, feature: { label: "Idea", Icon: Lightbulb } };
const STATUS: Record<Status, { label: string; tone: "neutral" | "warning" | "success" | "accent" }> = {
  new: { label: "New", tone: "warning" }, triaged: { label: "Planned", tone: "neutral" }, fixing: { label: "In progress", tone: "accent" }, fixed: { label: "Shipped", tone: "success" }, wontfix: { label: "Not doing", tone: "neutral" } };
const when = (zone: string, iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short" }).format(new Date(iso));

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? "Could not load");
  return data as T;
}

function Vote({ item, onVoted }: { item: Pick<BoardItem, "id" | "votes" | "mine">; onVoted: (votes: number, mine: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  async function vote() {
    setBusy(true);
    try { const r = await call<{ votes: number }>(`board/${item.id}/vote`, { up: !item.mine }); onVoted(r.votes, !item.mine); }
    catch (e) { notify({ id: "board-vote", tone: "error", title: "Not counted", message: (e as Error).message }); }
    finally { setBusy(false); }
  }
  return <button type="button" className={css.vote} aria-pressed={item.mine} disabled={busy} onClick={() => void vote()}
    aria-label={item.mine ? `Take back your vote (${item.votes})` : `Vote for this (${item.votes})`}>
    <ChevronUp size={16} aria-hidden="true" /><b>{item.votes}</b></button>;
}

export function Board({ data, zone, status, sort, kind, openId }: { data: BoardData; zone: string; status: string; sort: string; kind: string; openId: string | null }) {
  const router = useRouter();
  const [items, setItems] = useState(data.items);
  const [open, setOpen] = useState<string | null>(openId);
  const [from, setFrom] = useState(data);
  if (from !== data) { setFrom(data); setItems(data.items); }
  const link = (over: Record<string, string>) => `/bug-reports/board?${new URLSearchParams({ kind, status, sort, ...over })}`;
  const voted = (id: string, votes: number, mine: boolean) => setItems((xs) => xs.map((x) => x.id === id ? { ...x, votes, mine } : x));
  return <section className={css.board} aria-label="Board">
    <div className={css.bar}>
      <nav className={css.pills} aria-label="Where it stands">{[["open", "Open"], ["fixed", "Shipped"], ["all", "All"]].map(([k, l]) =>
        <Link key={k} href={link({ status: k })} scroll={false} aria-current={status === k ? "page" : undefined}>{l}</Link>)}</nav>
      <nav className={css.pills} aria-label="Order">{[["top", "Most votes"], ["new", "Newest"]].map(([k, l]) =>
        <Link key={k} href={link({ sort: k })} scroll={false} aria-current={sort === k ? "page" : undefined}>{l}</Link>)}</nav>
    </div>
    {!items.length ? <Empty icon={Lightbulb} title="Nothing here yet" text="When an AI employee lacks a tool, or someone has an idea, it shows up here for votes." />
      : <ul className={css.list}>{items.map((x) => { const K = KIND[x.kind] ?? KIND.bug; return <li key={x.id} className={css.item}>
        <Vote item={x} onVoted={(v, m) => voted(x.id, v, m)} />
        <button type="button" className={css.main} onClick={() => setOpen(x.id)}>
          <span className={css.title}><K.Icon size={14} aria-hidden="true" /><b>{x.title}</b></span>
          {x.words && x.words !== x.title ? <span className={css.words}>{x.words.split("\n")[0]}</span> : null}
          <span className={css.meta}>
            <Badge tone={STATUS[x.status]?.tone ?? "neutral"}>{STATUS[x.status]?.label ?? x.status}</Badge>
            <span>{K.label} #{x.number}</span>
            <span>{x.byAgent ? <><Bot size={12} aria-hidden="true" /> </> : null}{x.by ?? "Someone"} · {when(zone, x.createdAt)}</span>
            {x.devQueue && x.status !== "fixed" ? <span className={css.queued}>Dev queue</span> : null}
            <span><MessageSquare size={12} aria-hidden="true" /> {x.comments}</span>
          </span>
        </button>
      </li>; })}</ul>}
    {open ? <Item id={open} zone={zone} onClose={() => { setOpen(null); router.refresh(); }} onVoted={(v, m) => voted(open, v, m)} /> : null}
  </section>;
}

function Item({ id, zone, onClose, onVoted }: { id: string; zone: string; onClose: () => void; onVoted: (votes: number, mine: boolean) => void }) {
  const [d, setD] = useState<Detail | null>(null), [error, setError] = useState(""), [text, setText] = useState(""), [busy, setBusy] = useState(false);
  const load = () => call<Detail>(`board/${id}`).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function comment(e: FormEvent) {
    e.preventDefault(); if (!text.trim()) return;
    setBusy(true);
    try { await call(`board/${id}/comments`, { body: text.trim() }); setText(""); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function queue(on: boolean) {
    try { await call(`board/${id}/queue`, { on }); await load(); notify({ id: "board-queue", tone: "success", title: on ? "On the dev queue" : "Off the dev queue", timeout: 2200 }); }
    catch (err) { setError((err as Error).message); }
  }
  const K = d ? KIND[d.kind] ?? KIND.bug : KIND.bug;
  return <Drawer title={d ? d.title : "Loading"} onClose={onClose} size="lg" icon={<K.Icon size={18} aria-hidden="true" />}
    context={d ? <span>{K.label} #{d.number} · {d.byAgent ? "an AI employee, " : ""}{d.by ?? "Someone"} · {when(zone, d.createdAt)}</span> : undefined}>
    {!d ? <p className={css.fine}>{error || "Loading…"}</p> : <div className={css.detail}>
      <div className={css.head}>
        <Vote item={d} onVoted={(v, m) => { setD({ ...d, votes: v, mine: m }); onVoted(v, m); }} />
        <Badge tone={STATUS[d.status]?.tone ?? "neutral"}>{STATUS[d.status]?.label ?? d.status}</Badge>
        {d.shippedRef ? <span className={css.fine}>Shipped in {d.shippedRef}</span> : null}
        {d.canTriage ? <button type="button" className={css.queueBtn} onClick={() => void queue(!d.devQueue)}>{d.devQueue ? "Take off the dev queue" : "Put on the dev queue"}</button>
          : d.devQueue ? <span className={css.queued}>Dev queue</span> : null}
      </div>
      <DrawerSection title="Details"><p className={css.text}>{d.words}</p></DrawerSection>
      <DrawerSection title={`Discussion (${d.discussion.filter((x) => x.kind === "note").length})`}>
        {d.discussion.length ? <ol className={css.thread}>{d.discussion.map((x, i) => <li key={i} data-kind={x.kind}>
          <span className={css.who}>{x.agent ? <Bot size={12} aria-hidden="true" /> : null}<b>{x.who}</b> · {when(zone, x.at)}</span>
          {x.kind === "status" ? <p className={css.fine}>Marked {STATUS[x.value as Status]?.label ?? x.value}{x.note ? `: ${x.note}` : ""}</p> : <p className={css.text}>{x.note}</p>}
        </li>)}</ol> : <p className={css.fine}>No comments yet.</p>}
        <form className={css.reply} onSubmit={(e) => void comment(e)}>
          <textarea rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add to the discussion" aria-label="Comment" />
          <button type="submit" disabled={busy || !text.trim()}>Comment</button>
        </form>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
      </DrawerSection>
    </div>}
  </Drawer>;
}
