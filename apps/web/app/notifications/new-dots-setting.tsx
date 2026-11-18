"use client";
// NEW-DOTS: each person's own switch for the red "new" dots (Settings → Notifications). On by default; saved at once on
// the server, so it holds on every device. Off: no dots and no "New: …" line; What's new still lists what changed.
import { useEffect, useState } from "react";
import { Switch } from "../kit";
import { NEW_DOTS_REFRESH } from "../lib/new-dots.mjs";
import { styles } from "../ui";
import css from "./notifications.module.css";

export function NewDotsSetting() {
  const [on, setOn] = useState<boolean | null>(null), [saved, setSaved] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/v0/whats-new/unseen", { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (live && r.ok && typeof d.on === "boolean") setOn(d.on); }).catch(() => {});
    return () => { live = false; };
  }, []);
  async function flip(next: boolean) {
    const before = on;
    setOn(next); setSaved(""); setError("");
    try {
      const r = await fetch("/api/v0/whats-new/dots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "That did not save. Please try again.");
      window.dispatchEvent(new CustomEvent(NEW_DOTS_REFRESH, { detail: d }));
      setSaved(next ? "Red dots are on." : "Red dots are off. What's new still lists what changed.");
    } catch (e) { setError((e as Error).message); setOn(before); }
  }
  if (on === null) return null;
  return <fieldset className={css.mute} data-new-anchor="settings.notifications.dots">
    <legend>What&apos;s new</legend>
    <Switch label="Red dots on what's new" hint="After an update, red dots lead you to what changed for you, down to the button, until you have seen it." checked={on} onChange={(v) => void flip(v)} />
    {saved ? <p role="status" className={styles.muted}>{saved}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </fieldset>;
}
