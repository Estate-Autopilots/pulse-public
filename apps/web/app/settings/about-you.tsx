"use client";
// SELF-SERVE (owner, 4 Nov 2026: types "all editable later in Settings; one person can hold several types and several
// orgs"): Settings → About you. Which describes you (several), what this space was set up as and what it calls things,
// with the way to change each, and Start another space.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Panel } from "../ui";
import { SPACES, type ProfileKey } from "../signup/setup-catalogue";
import { WhoStep } from "../signup/setup-steps";
import s from "../signup/setup.module.css";

type About = { profiles: ProfileKey[]; account: boolean; space: { kind: string; served: string; since: string } | null; words: Record<string, string> | null; admin: boolean };

export function AboutYou() {
  const [about, setAbout] = useState<About | null>(null);
  const [profiles, setProfiles] = useState<ProfileKey[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/account/about", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<About> : null)
      .then((a) => { if (live && a) { setAbout(a); setProfiles(a.profiles); } }).catch(() => { if (live) setNote({ tone: "error", text: "About you could not load. Try again in a minute." }); });
    return () => { live = false; };
  }, []);
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch("/api/v0/account/about", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profiles }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
      setAbout(d as About); setNote({ tone: "ok", text: "Saved." });
    } catch (e) { setNote({ tone: "error", text: (e as Error).message }); } finally { setBusy(false); }
  };
  const space = SPACES.find((x) => x.key === about?.space?.kind);
  const changed = !!about && [...profiles].sort().join() !== [...about.profiles].sort().join();
  return <Panel title="About you" sub="What describes you, and what this space was set up for">
    <div style={{ display: "grid", gap: 14, padding: "12px 16px 16px" }} data-about="">
      <WhoStep answers={{ profiles, space: "personal", served: null, orgName: "" }} onChange={(a) => setProfiles(a.profiles)} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className={s.chip} style={{ justifyContent: "center", fontWeight: 650 }} disabled={busy || !changed || !profiles.length} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        {!profiles.length ? <small style={{ color: "var(--theme-text-muted)" }}>Choose at least one.</small> : null}
        {note ? <span role={note.tone === "error" ? "alert" : "status"} style={{ color: note.tone === "error" ? "var(--theme-danger)" : "var(--theme-success)", fontSize: 13 }}>{note.text}</span> : null}
      </div>
      {space ? <div className={s.more} style={{ ["--space-hue" as string]: space.hue }}>
        <b>This space: {space.label}</b>
        <small style={{ color: "var(--theme-text-muted)" }}>{about?.words?.clients ? `It calls the people it serves ${about.words.clients.toLowerCase()}. ` : ""}Its words, modules and client types are yours to change.</small>
        {about?.admin ? <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link href="/settings?tab=industry">Words and roles</Link><Link href="/settings?tab=organisation">Modules and client types</Link>
        </div> : null}
      </div> : null}
      <p style={{ margin: 0, fontSize: 14 }}>Running something else too? <Link href="/start/space" style={{ fontWeight: 650 }}>Start another space</Link> (a practice, a shop, a school, or just you).</p>
      <small style={{ color: "var(--theme-text-muted)" }}>Only you see what describes you; it shapes the starter plans Pulse suggests.</small>
    </div>
  </Panel>;
}
