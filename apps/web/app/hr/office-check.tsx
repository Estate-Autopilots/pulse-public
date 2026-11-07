"use client";

import Link from "next/link";
import { useState } from "react";
import { placeAt, wifiMatch } from "@pulse/companion";
import { useInShell } from "../use-in-shell";
import { shell } from "../lib/native-shell";
import { styles } from "../ui";
import css from "./hr.module.css";

/** A reading on an explicit tap, using HR's existing rules. Nothing leaves this page or checks in automatically. */
export function OfficeCheck() {
  const inShell = useInShell();
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [needsConsent, setNeedsConsent] = useState(false);
  if (!inShell) return null;
  async function check(kind: "wifi" | "location") {
    const s = shell(); if (!s) return;
    setBusy(true); setNote(""); setNeedsConsent(false);
    try {
      const p = await s.presencePreferences();
      if (!p.enabled) { setNeedsConsent(true); setNote("Turn on office check-in helpers for this phone first."); return; }
      if (!p.offices.length) { setNote("HR has not set up an office for your account yet."); return; }
      const rules = { ...p, autoCheckIn: false };
      const info = await s.info();
      if (info.platform === "android") {
        const permission = await s.requestPermissions({ permissions: ["location"] });
        if (permission.location !== "granted") { setNote("Location permission is off. Android also needs it to read office Wi-Fi."); return; }
      }
      if (kind === "wifi") {
        const reading = await s.wifi();
        if (reading.permission === "unsupported") { setNote("Wi-Fi checks are not available on this phone yet. You can use Check location instead."); return; }
        const match = wifiMatch(reading, rules);
        setNote(match?.strength === "strong" ? `${match.name} Wi-Fi confirmed. Tap Check in when you are ready.`
          : match ? `The network name matches ${match.name}, but its access point is not confirmed. Use Check location or check in yourself.`
          : "This Wi-Fi does not match an office set up by HR. You can still check in yourself.");
      } else {
        const match = placeAt(await s.location(), rules);
        setNote(match.place ? `You are at ${match.place.name}. Tap Check in when you are ready.`
          : match.reason === "weak-gps" ? "The position is too imprecise to confirm an office. Try office Wi-Fi instead."
          : "This position does not confirm an office set up by HR. You can still check in yourself.");
      }
    } catch (e) { setNote(e instanceof Error ? e.message : "The office check could not finish. Try again."); }
    finally { setBusy(false); }
  }
  return <div className={css.todayOfficeCheck}>
    <div className={styles.inline}>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void check("wifi")}>Check office Wi-Fi</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => void check("location")}>Check location</button>
    </div>
    {note ? <p className={styles.muted} role="status">{note} {needsConsent ? <Link href="/settings?tab=devices">This phone settings</Link> : null}</p>
      : <p className={styles.muted}>Optional office check, only when you tap. No location history.</p>}
  </div>;
}
