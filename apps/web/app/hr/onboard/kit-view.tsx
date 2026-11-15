"use client";
// HR → Onboard team → Rollout kit: drafts for the owner and HR to copy and send themselves. Pulse sends none of them.
import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { parseMarkdown } from "../../lib/markdown.mjs";
import { MarkdownBody } from "../policy-reader";
import { styles } from "../../ui";
import { KIT } from "./kit";
import css from "./onboard.module.css";

export function RolloutKit() {
  const [current, setCurrent] = useState(KIT[0].key);
  const [copied, setCopied] = useState("");
  const doc = KIT.find((k) => k.key === current) ?? KIT[0];
  const copy = async () => { try { await navigator.clipboard.writeText(doc.body); setCopied(doc.key); window.setTimeout(() => setCopied(""), 1800); } catch { /* clipboard blocked */ } };
  return (
    <div className={css.kit} data-grow="">
      <nav className={css.kitNav} aria-label="Rollout kit">{KIT.map((k) => <button key={k.key} type="button" aria-current={k.key === current ? "true" : undefined} onClick={() => setCurrent(k.key)}><b>{k.title}</b><small>{k.audience}</small></button>)}</nav>
      <article className={css.kitDoc} aria-label={doc.title}>
        <header className={css.kitHead}><span><b>Draft</b> · Pulse never sends this; the owner or HR copies it and sends it.</span>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void copy()}>{copied === doc.key ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied === doc.key ? "Copied" : "Copy text"}</button></header>
        <div className={css.kitBody}><MarkdownBody blocks={parseMarkdown(doc.body).blocks} anchors={false} /></div>
      </article>
    </div>
  );
}
