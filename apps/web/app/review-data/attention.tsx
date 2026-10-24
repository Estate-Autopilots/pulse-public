"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { post } from "../records";
import { Badge, styles } from "../ui";
import css from "./review.module.css";

export type AttentionItem = { id: string; kind: string; title: string; why: string; impact: number; impactNote: string; score: number; confidence: number | null; group: string;
  action: { label: string; needs?: "pod" | "option" | "point" | null } | null; dismiss: string; options?: { id: string; label: string; note?: string }[]; href?: string; search?: string };

/** "18.52, 73.85", or a Google Maps link carrying @lat,lng or ?q=lat,lng. */
export function coordinates(text: string): { lat: number; lng: number } | null {
  const m = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ?? text.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ?? text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** R55: everything waiting in Review data, most important first, each with why it matters and one click to resolve it. */
export function AttentionList({ items, canDecide, pods }: { items: AttentionItem[]; canDecide: boolean; pods: string[] }) {
  return <ol className={css.attention} data-items="">{items.map((it, i) => <AttentionRow key={it.id} item={it} rank={i + 1} canDecide={canDecide} pods={pods} />)}</ol>;
}

function AttentionRow({ item, rank, canDecide, pods }: { item: AttentionItem; rank: number; canDecide: boolean; pods: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [done, setDone] = useState("");
  const [pod, setPod] = useState(""), [choice, setChoice] = useState(item.options?.find((o) => item.action?.label.includes(o.label))?.id ?? ""), [point, setPoint] = useState("");
  const needs = item.action?.needs ?? null, at = coordinates(point);
  const decide = async (action: "accept" | "dismiss") => {
    setBusy(true); setNote("");
    try {
      await post("review-data/decide", { ids: [item.id], action, ...(action === "accept" && needs === "pod" ? { proposed: { pod } } : {}),
        ...(action === "accept" && item.kind === "talent" && choice ? { choice } : {}), ...(action === "accept" && needs === "point" && at ? at : {}) });
      setDone(action === "accept" ? "Done" : "Dismissed"); router.refresh();
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  const ready = !needs || (needs === "pod" && !!pod) || (needs === "option" && !!choice) || (needs === "point" && !!at);
  return <li className={css.attentionRow} data-done={done ? "" : undefined}>
    <span className={css.rankNo}>{rank}</span>
    <div className={css.attentionBody}>
      <b>{item.title}</b>
      <p>{item.why}</p>
      <span className={css.chips}><Badge tone={item.impact >= 60 ? "warning" : item.impact >= 25 ? "accent" : "neutral"}>{item.impactNote || item.group}</Badge><Badge>{item.group}</Badge>
        {item.confidence !== null ? <Badge tone={item.confidence >= 0.9 ? "success" : "neutral"}>{Math.round(item.confidence * 100)}% sure</Badge> : null}</span>
      {done ? <span role="status" className={styles.muted}>{done}</span> : canDecide ? <div className={css.attentionActions}>
        {needs === "pod" ? <select aria-label={`Pod for ${item.title}`} value={pod} onChange={(e) => setPod(e.target.value)}><option value="">Choose a pod</option>{pods.map((p) => <option key={p}>{p}</option>)}</select> : null}
        {item.options && item.options.length > 1 || needs === "option" ? <select aria-label={`Choice for ${item.title}`} value={choice} onChange={(e) => setChoice(e.target.value)}><option value="">Choose…</option>{(item.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}{o.note ? ` (${o.note})` : ""}</option>)}</select> : null}
        {needs === "point" ? <><input aria-label={`Location for ${item.title}`} placeholder="Paste coordinates or a Maps link" value={point} onChange={(e) => setPoint(e.target.value)} />
          {item.search ? <a className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.search)}`} target="_blank" rel="noreferrer">Find on Maps <ExternalLink size={12} aria-hidden="true" /></a> : null}</> : null}
        {item.action ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !ready} onClick={() => void decide("accept")}>
          {item.kind === "talent" && choice && item.options ? `${item.options.find((o) => o.id === choice)?.label ? (item.action.label.startsWith("Link") ? `Link to ${item.options.find((o) => o.id === choice)!.label}` : `It's ${item.options.find((o) => o.id === choice)!.label}`) : item.action.label}` : item.action.label}</button> : null}
        {item.href ? <Link className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={item.href}>Open</Link> : null}
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void decide("dismiss")}>{item.dismiss}</button>
        {note ? <span role="alert" className={styles.muted}>{note}</span> : null}
      </div> : null}
    </div>
  </li>;
}
