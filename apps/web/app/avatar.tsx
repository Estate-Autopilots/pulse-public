"use client";
// PULSE-POLISH (owner, 14 Nov 2026: "My profile picture saved in the database should be used instead of the Autopilots
// icon wherever it is used: tasks, chats, settings, all organisations"): ONE avatar for a person everywhere. It shows the
// person's stored photo whenever they have one, and their initials only when they have none:
//   - with `photoAt` (the list already says when the photo changed) the photo is asked for at once;
//   - without it (most lists carry only the person's id), the page asks once which people in this company have a photo
//     (GET /api/v0/people/photos, shared by every avatar on the page and kept for a few minutes), then shows theirs;
//   - a photo that fails to load falls back to the initials, never a broken picture.
// The initials sit under the photo, so a slow photo is never a blank circle (E2E-4P). A person's photo is the same in
// every company they work in (PROFILE-UNIFY copies it to each of their seats), so this shows it in every company.
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { PresenceDot } from "./presence";
import { hue, initials } from "./lib/face";
import styles from "./ui.module.css";

type Photos = Record<string, string>;
let photos: Photos | null = null, loadedAt = 0, loading = false;
const listeners = new Set<() => void>();
const KEEP = 5 * 60_000;
/** Ask once which people have a photo (and when it changed); every avatar on the page reads the same answer. */
function loadPhotos() {
  if (loading || (photos && Date.now() - loadedAt < KEEP) || typeof window === "undefined") return;
  loading = true;
  void fetch("/api/v0/people/photos", { cache: "no-store", credentials: "same-origin" })
    .then((r) => r.ok ? r.json() as Promise<{ photos?: Photos }> : { photos: photos ?? {} })
    .catch(() => ({ photos: photos ?? {} }))
    .then((d) => { photos = d.photos ?? {}; loadedAt = Date.now(); loading = false; listeners.forEach((f) => f()); });
}
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => photos;
const serverSnapshot = () => null;
/** When this person's photo last changed, if the page has learnt it (for lists built outside React, e.g. mention menus). */
export function knownPhoto(id: string | null | undefined): string | null { if (!id) return null; loadPhotos(); return photos?.[id] ?? null; }
/** The photo's address (with its version, so the browser may keep it). */
export const photoSrc = (id: string, at: string) => `/photo/${id}?v=${Date.parse(at) || 0}`;
/** Tell every avatar on the page that a photo changed (after an upload or removal), without waiting for the next read. */
export function photoChanged(id: string, at: string | null) { photos = { ...(photos ?? {}) }; if (at) photos[id] = at; else delete photos[id]; listeners.forEach((f) => f()); }

/** One avatar everywhere: a fixed square (or circle) of `size`, the photo when there is one, else initials. `status`
 *  adds the person's presence dot (in the office, on a shoot…); `present` is the older "checked in" dot; `ai` marks an AI
 *  employee (its photo too, when it has one). */
export function Avatar({ name, id, photoAt, size = 32, shape, ai, present, status, className }: { name: string; id?: string | null; photoAt?: string | null; size?: number; shape?: "square"; ai?: boolean; present?: boolean; status?: boolean; className?: string }) {
  const known = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [failed, setFailed] = useState<string | null>(null);
  const pid = id ?? undefined;
  // Lists that do not say when the photo changed ask the page's one shared list.
  useEffect(() => { if (pid && !photoAt) loadPhotos(); }, [pid, photoAt]);
  const at = photoAt ?? (pid ? known?.[pid] : undefined) ?? null;
  const src = pid && at ? photoSrc(pid, at) : null;
  const boxed = ai || present || (status && !!pid);
  const face = (
    <span className={`${styles.avatar}${className && !boxed ? ` ${className}` : ""}`} data-shape={ai ? "square" : shape} data-photo={src && failed !== src ? "" : undefined} style={{ "--size": `${size}px`, "--hue": hue(name) } as CSSProperties} aria-hidden="true">
      {initials(name)}
      {/* eslint-disable-next-line @next/next/no-img-element -- served by /photo from the database, already sized */}
      {src && failed !== src ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(src)} /> : null}
    </span>
  );
  // The dot sits outside the clipped circle, so it is never cut in half.
  return boxed ? <span className={`${styles.avatarBox}${className ? ` ${className}` : ""}`} style={{ "--size": `${size}px` } as CSSProperties}>{face}{ai ? <span className={styles.avatarAi} aria-hidden="true">AI</span> : status && pid ? <PresenceDot id={pid} size={size} /> : <i className={styles.presence} title="Checked in" />}</span> : face;
}
