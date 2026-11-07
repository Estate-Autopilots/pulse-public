"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): "comment threads pinned to each selected element (like Figma or Marker.io)". The
// elements picked with the picker (picker.tsx), each with its own short thread: the reporter writes what is wrong with
// that element; on the triage page the team answers in the same thread (POST /api/v0/bug-reports/:id/pins).
import { Crosshair, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PickedElement } from "../lib/friction.mjs";
import styles from "./picker.module.css";

export type PinComment = { text: string; at: string; by?: string; team?: boolean };
export type Pin = PickedElement & { comments: PinComment[] };
export const MAX_COMMENT = 500;

function Thread({ pin, onAdd, label }: { pin: Pin; onAdd?: (text: string) => void; label: string }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (!t || !onAdd) return; onAdd(t.slice(0, MAX_COMMENT)); setText(""); };
  return <>
    {pin.comments.length ? <ul className={styles.thread}>{pin.comments.map((c, i) => <li key={i}>{c.by ? <small>{c.by}{c.team ? " · team" : ""}</small> : null}{c.text}</li>)}</ul> : null}
    {onAdd ? <div className={styles.reply}>
      <input value={text} maxLength={MAX_COMMENT} aria-label={label} placeholder={pin.comments.length ? "Add to this thread" : "What’s wrong with this one?"}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <button type="button" className={styles.iconButton} aria-label="Add the comment" disabled={!text.trim()} onClick={add}><Send size={14} aria-hidden="true" /></button>
    </div> : null}
  </>;
}

/** The picked elements with their threads. `onAdd(index, text)` adds a comment; `onRemove(index)` drops a pin. */
export function PinList({ pins, onAdd, onRemove }: { pins: readonly Pin[]; onAdd?: (index: number, text: string) => void; onRemove?: (index: number) => void }) {
  if (!pins.length) return null;
  return <ol className={styles.pins} aria-label="Picked elements">{pins.map((p, i) => <li key={`${p.sel}-${i}`} className={styles.pin} data-testid="pin">
    <div className={styles.pinHead}>
      <span className={styles.pinNo} aria-hidden="true">{i + 1}</span>
      <span className={styles.pinText}><b>{p.label || p.tag}{p.component ? ` · ${p.component}` : ""}</b><code title={p.sel ?? ""}>{p.sel ?? p.tag}</code></span>
      {onRemove ? <button type="button" className={styles.iconButton} aria-label={`Remove element ${i + 1}`} onClick={() => onRemove(i)}><Trash2 size={14} aria-hidden="true" /></button> : null}
    </div>
    <Thread pin={p} label={`Comment on element ${i + 1}`} onAdd={onAdd ? (text) => onAdd(i, text) : undefined} />
  </li>)}</ol>;
}

/** The "Point at what's wrong" row: a button that opens the picker, and what was picked. */
export function PickRow({ count, onPick }: { count: number; onPick: () => void }) {
  return <div className={styles.pickRow}>
    <button type="button" className={styles.cancel} onClick={onPick} data-testid="pick-elements"><Crosshair size={14} aria-hidden="true" />{count ? "Pick again" : "Point at what’s wrong"}</button>
    <small>{count ? `${count} element${count === 1 ? "" : "s"} picked. Comment on each below.` : "Pick one or more things on the screen (Shift-click for more)."}</small>
  </div>;
}
