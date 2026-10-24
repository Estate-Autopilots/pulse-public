"use client";
// FLOW-C: comments on a record's part (a document's section, an asset's tab): who said what and when, resolved when
// it is dealt with. A change asked for (a media review's change list) has its owner and its date.
import { useState } from "react";
import { Check, MessageSquare, RotateCcw } from "lucide-react";
import { styles } from "../ui";
import type { Work } from "./work";
import { dayText, timeText } from "./types";
import css from "./work.module.css";

export function Comments({ w, recordId, section }: { w: Work; recordId: string; section: string }) {
  const [body, setBody] = useState(""), [shut, setShut] = useState(true);
  const all = (w.rec?.comments ?? []).filter((c) => c.section === section && c.kind === "comment");
  const open = all.filter((c) => !c.resolvedAt), done = all.filter((c) => c.resolvedAt);
  async function add() {
    if (!body.trim()) return;
    if (await w.act(`records/${recordId}/comments`, { body: body.trim(), section }, "Comment added")) setBody("");
  }
  return <section className={css.comments} aria-label={`Comments on ${section}`}>
    <h4><MessageSquare size={13} aria-hidden="true" />Comments<small>{open.length ? `${open.length} open` : "none open"}</small></h4>
    {open.length ? <ul>{open.map((c) => <li key={c.id}><p>{c.body}</p><small>{c.by ?? "Someone"} · {timeText(c.at)}{c.dueOn ? ` · by ${dayText(c.dueOn)}` : ""}</small>
      {w.d.canAct ? <button type="button" className={css.linkBtn} disabled={w.busy} onClick={() => void w.act(`comments/${c.id}/resolve`, { resolved: true }, "Resolved")}><Check size={12} aria-hidden="true" />Resolve</button> : null}</li>)}</ul> : null}
    {done.length ? <details className={css.resolved} open={!shut} onToggle={(e) => setShut(!(e.target as HTMLDetailsElement).open)}><summary>{done.length} resolved</summary>
      <ul>{done.map((c) => <li key={c.id}><p>{c.body}</p><small>{c.by ?? "Someone"} · {timeText(c.at)} · resolved {dayText(c.resolvedAt)}</small>
        {w.d.canAct ? <button type="button" className={css.linkBtn} disabled={w.busy} onClick={() => void w.act(`comments/${c.id}/resolve`, { resolved: false }, "Opened again")}><RotateCcw size={12} aria-hidden="true" />Open again</button> : null}</li>)}</ul></details> : null}
    <form className={css.commentAdd} onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Comment on “${section}”`} aria-label={`Comment on ${section}`} maxLength={4000} />
      <button type="submit" className={styles.btn} disabled={w.busy || !body.trim()}>Comment</button>
    </form>
  </section>;
}
