"use client";
import { lower } from "../lib/words.mjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { ExternalLink } from "lucide-react";
import { post } from "../records";
import { Badge, styles } from "../ui";
import css from "./review.module.css";
import { SelectField } from "../kit/select-field";
import { useWords } from "../org-code";

export type AttentionItem = { id: string; kind: string; title: string; why: string; impact: number; impactNote: string; score: number; confidence: number | null; group: string;
  action: { label: string; needs?: "pod" | "option" | "point" | null } | null; dismiss: string; options?: { id: string; label: string; note?: string }[]; href?: string; search?: string;
  /** SETTINGS-APPLE (T1.3.3): the company's own AI's check, and whether it is a sure one (accepted together). */ ai?: { confidence: number; reason: string } | null; sure?: boolean };

/** "18.52, 73.85", or a Google Maps link carrying @lat,lng or ?q=lat,lng. */
export function coordinates(text: string): { lat: number; lng: number } | null {
  const m = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ?? text.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/) ?? text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const PAGE = 20;

/** R55: everything waiting in Review data, most important first, each with why it matters and one click to resolve it.
 *  SETTINGS-APPLE (judge: "hundreds of cards on one endless scroll"): 20 at a time, then "Show more". A row's type tag
 *  uses the same name as its chip above (`labels`). Three or more suggestions of one type with the same reason (eight
 *  "Finance source conflict" rows in a row) show as the first one and "N more like this", opened in place. */
export function AttentionList({ items, canDecide, pods, labels = {}, total }: { items: AttentionItem[]; canDecide: boolean; pods: string[]; labels?: Record<string, string>; total?: number }) {
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (it: AttentionItem) => `${it.kind}|${it.ai ? "" : it.why}`;
  const sizes = new Map<string, number>();
  for (const it of items) sizes.set(keyOf(it), (sizes.get(keyOf(it)) ?? 0) + 1);
  const entries: { item: AttentionItem; more: AttentionItem[] }[] = [];
  const firstOf = new Map<string, { item: AttentionItem; more: AttentionItem[] }>();
  for (const it of items) {
    const k = keyOf(it), lead = firstOf.get(k);
    if (lead && (sizes.get(k) ?? 0) >= 3 && !it.ai) { lead.more.push(it); continue; }
    const e = { item: it, more: [] as AttentionItem[] }; entries.push(e); if (!firstOf.has(k)) firstOf.set(k, e);
  }
  const page = entries.slice(0, shown), left = entries.length - page.length;
  const all = Math.max(total ?? 0, items.length);
  const row = (it: AttentionItem) => <AttentionRow key={it.id} item={it} canDecide={canDecide} pods={pods} tag={labels[it.kind] ?? it.group} />;
  return <>
    <ol className={css.attention} data-items="">{page.map((e) => <Fragment key={e.item.id}>
      {row(e.item)}
      {e.more.length ? open.has(e.item.id) ? e.more.map((m) => row(m))
        : <li className={css.moreLike}><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setOpen((o) => new Set(o).add(e.item.id))}>
          {e.more.length} more like this</button></li> : null}
    </Fragment>)}</ol>
    <div className={css.showMore}>
      <span>Showing {page.length.toLocaleString("en-IN")} of {all.toLocaleString("en-IN")}</span>
      {left > 0 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setShown((n) => n + PAGE)}>Show more</button>
        // Everything loaded is on screen but more are waiting: say how they come, not a dead end.
        : all > items.length ? <span>The next ones come in as you decide these.</span> : null}
    </div>
  </>;
}

function AttentionRow({ item, canDecide, pods, tag }: { item: AttentionItem; canDecide: boolean; pods: string[]; tag: string }) {
  const words = useWords();
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
    <div className={css.attentionBody}>
      <b>{item.title}</b>
      {/* SETTINGS-APPLE (T1.3.3): the company's AI's reason first, when it has checked; the source's own why otherwise. */}
      <p>{item.ai ? <><span className={css.aiBy}>Your AI:</span> {item.ai.reason}</> : item.why}</p>
      <span className={css.chips}><Badge>{tag}</Badge>
        {item.ai ? <Badge tone={item.ai.confidence >= 0.9 ? "success" : "neutral"}>AI {Math.round(item.ai.confidence * 100)}% sure</Badge>
          // Before the AI has checked, no number (judge, two rounds: "the AI has not checked them" beside a percent read as a
          // contradiction, even as "Pulse's guess"); the order still puts the likely ones first.
          : null}
        {item.impact >= 60 ? <Badge tone="warning">{item.impactNote}</Badge> : null}</span>
      {done ? <span role="status" className={styles.muted}>{done}</span> : canDecide ? <div className={css.attentionActions}>
        {needs === "pod" ? <SelectField aria-label={`${words.team} for ${item.title}`} value={pod} onChange={(e) => setPod(e.target.value)}><option value="">{`Choose a ${lower(words.team)}`}</option>{pods.map((p) => <option key={p}>{p}</option>)}</SelectField> : null}
        {item.options && item.options.length > 1 || needs === "option" ? <SelectField aria-label={`Choice for ${item.title}`} value={choice} onChange={(e) => setChoice(e.target.value)}><option value="">Choose…</option>{(item.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}{o.note ? ` (${o.note})` : ""}</option>)}</SelectField> : null}
        {needs === "point" ? <><input aria-label={`Location for ${item.title}`} placeholder="Paste coordinates or a Maps link" value={point} onChange={(e) => setPoint(e.target.value)} />
          {item.search ? <a className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.search)}`} target="_blank" rel="noreferrer">Find on Maps <ExternalLink size={12} aria-hidden="true" /></a> : null}</> : null}
        {item.action ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${css.lead}`} disabled={busy || !ready} onClick={() => void decide("accept")}>
          {item.kind === "talent" && choice && item.options ? `${item.options.find((o) => o.id === choice)?.label ? (item.action.label.startsWith("Link") ? `Link to ${item.options.find((o) => o.id === choice)!.label}` : `It's ${item.options.find((o) => o.id === choice)!.label}`) : item.action.label}` : item.action.label}</button> : null}
        {item.href ? <Link className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={item.href}>Open</Link> : null}
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void decide("dismiss")}>{item.dismiss}</button>
        {note ? <span role="alert" className={styles.muted}>{note}</span> : null}
      </div> : null}
    </div>
  </li>;
}
