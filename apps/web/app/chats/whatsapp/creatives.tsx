"use client";
// WA-MEDIA (1100): a client's (or project's) creative library from its WhatsApp groups: every ad creative, brochure page,
// reel or design sent, its version in a series, and what the client said next (approved, changes asked, no answer),
// with a link to the message in its chat; and the figures the group's files carry (payments, ad funds, ad spend,
// leads, invoices). Admins and leadership see every group; anyone else the groups they read (the server decides).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FileText, Film, Images, MessageSquareText } from "lucide-react";
import { get } from "../net";
import { Empty, Panel } from "../../ui";
import { classLabel, figureText, type WaFigure } from "../wa-media";
import css from "./creatives.module.css";

type Creative = { id: string; sha256: string; kind: "image" | "video" | "document"; class: string; format: string | null; headline: string | null; offer: string | null;
  cta: string | null; language: string | null; series: string | null; versionNo: number | null; versions: number | null; status: string; approvals: number; changes: number;
  changeNotes: string[] | null; clientReplies: number; firstReplyMinutes: number | null; sentAt: string; senderSide: string; chatId: string; chat: string; channelId: string; alt: string | null;
  summary: string | null; quality: string[] | null; poster: string | null; messageId: string | null; feedback: string[] };
type Figure = WaFigure & { id: string; at: string; statedDate: boolean; period: string | null; method: string | null; source: string; class: string | null; alt: string | null;
  chat: string; channelId: string; messageId: string | null };
const STATUS: Record<string, string> = { approved: "Approved", changes_requested: "Changes asked", discussed: "Discussed", no_response: "No answer" };
const FILTERS = [["all", "All"], ["approved", "Approved"], ["changes_requested", "Changes asked"], ["no_response", "No answer"]] as const;
const url = (sha: string) => `/api/v0/chats/whatsapp/files/${sha}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const link = (channelId: string, messageId: string | null) => `/chats?channel=${channelId}${messageId ? `&message=${messageId}` : ""}`;
const MONEY = new Set(["payment", "ad_funds", "ad_balance", "invoice", "quotation", "receipt"]);

export function CreativeLibrary({ client, project }: { client?: string; project?: string }) {
  const q = client ? `client=${client}` : project ? `project=${project}` : "";
  const [items, setItems] = useState<Creative[] | null>(null), [figures, setFigures] = useState<Figure[] | null>(null), [filter, setFilter] = useState<string>("all");
  useEffect(() => {
    const a = new AbortController();
    get<{ creatives: Creative[] }>(`chats/whatsapp/creatives?${q}&limit=500`, a.signal).then((d) => { if (!a.signal.aborted) setItems(d.creatives ?? []); }).catch(() => setItems([]));
    get<{ figures: Figure[] }>(`chats/whatsapp/figures?${q}&limit=500`, a.signal).then((d) => { if (!a.signal.aborted) setFigures(d.figures ?? []); }).catch(() => setFigures([]));
    return () => a.abort();
  }, [q]);
  const shown = useMemo(() => (items ?? []).filter((c) => filter === "all" || c.status === filter), [items, filter]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k]) => [k, k === "all" ? (items ?? []).length : (items ?? []).filter((c) => c.status === k).length])), [items]);
  const money = (figures ?? []).filter((f) => MONEY.has(f.kind)), ads = (figures ?? []).filter((f) => !MONEY.has(f.kind));
  const rounds = (items ?? []).filter((c) => (c.versions ?? 1) > 1);
  return <>
    <Panel fill title="Creative library from the WhatsApp groups" sub={items ? `${items.length} creative${items.length === 1 ? "" : "s"} sent in the groups${rounds.length ? ` · ${new Set(rounds.map((c) => c.series)).size} revised in rounds` : ""} · read from the files, check before you rely on it` : "Loading…"}>
      {items && !items.length ? <Empty icon={Images} compact title="No creatives found in this client's groups" text="Creatives appear here once the files of its WhatsApp groups are analysed." /> : null}
      {items?.length ? <div className={css.filters} role="group" aria-label="Show">{FILTERS.map(([k, label]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}<span>{counts[k]}</span></button>)}</div> : null}
      <ul className={css.grid} data-creatives="">{shown.map((c) => <li key={c.id} className={css.card} data-status={c.status}>
        <Link href={link(c.channelId, c.messageId)} className={css.thumb} title="Open it in the chat">
          {c.kind === "image" ? <img src={url(c.sha256)} alt={c.alt ?? classLabel(c.class)} loading="lazy" /> /* eslint-disable-line @next/next/no-img-element -- member-only file served by the API */
            : c.kind === "video" && c.poster ? <><img src={url(c.poster)} alt={c.alt ?? "Video"} loading="lazy" /><Film size={18} className={css.badgeIcon} aria-hidden="true" /></> /* eslint-disable-line @next/next/no-img-element -- member-only file served by the API */
            : <span className={css.doc}>{c.kind === "video" ? <Film size={28} aria-hidden="true" /> : <FileText size={28} aria-hidden="true" />}</span>}
        </Link>
        <div className={css.meta}>
          <span className={css.status} data-status={c.status}>{STATUS[c.status] ?? c.status}{(c.versions ?? 1) > 1 ? ` · v${c.versionNo} of ${c.versions}` : ""}</span>
          <b>{c.headline || classLabel(c.class)}</b>
          {c.offer ? <small>{c.offer}</small> : null}
          <small>{classLabel(c.class)} · {day(c.sentAt)} · {c.senderSide === "team" ? "sent by the team" : c.senderSide === "client" ? "sent by the client" : "sender unknown"}</small>
          <small><Link href={link(c.channelId, c.messageId)}>{c.chat}</Link>{c.feedback.length ? <> · <MessageSquareText size={12} aria-hidden="true" /> {c.feedback.length} client repl{c.feedback.length === 1 ? "y" : "ies"}</> : null}
            {c.firstReplyMinutes != null ? ` · first answer in ${c.firstReplyMinutes < 60 ? `${c.firstReplyMinutes} min` : `${Math.round(c.firstReplyMinutes / 60)} h`}` : ""}</small>
          {c.changeNotes?.length ? <ul className={css.asked} aria-label="Changes the client asked">{c.changeNotes.slice(0, 3).map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          {c.quality?.length ? <small className={css.quality}>Check: {c.quality.slice(0, 2).join("; ")}</small> : null}
        </div>
      </li>)}</ul>
    </Panel>
    {figures?.length ? <Panel fill title="Figures from files" sub="Payments, ad funds, invoices and ad results read from screenshots and documents in the groups · evidence to check, not booked finance">
      {money.length ? <FigureTable title="Money" rows={money} /> : null}
      {ads.length ? <FigureTable title="Ad results" rows={ads} /> : null}
    </Panel> : null}
  </>;
}

function FigureTable({ title, rows }: { title: string; rows: Figure[] }) {
  return <table className={css.table} aria-label={title}>
    <caption>{title}</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Detail</th><th scope="col">Group</th></tr></thead>
    <tbody>{rows.slice(0, 200).map((f) => <tr key={f.id} data-kind={f.kind}>
      <td>{day(f.at)}{f.statedDate ? "" : <small> (sent)</small>}</td>
      <td>{figureText(f)}</td>
      <td>{[f.label, f.period, f.method?.toUpperCase()].filter(Boolean).join(" · ") || classLabel(f.class ?? "other")}</td>
      <td><Link href={link(f.channelId, f.messageId)}>{f.chat}</Link></td>
    </tr>)}</tbody>
  </table>;
}
