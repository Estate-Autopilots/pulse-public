"use client";

import { CalendarClock, ChevronRight, ImageUp, Palette, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import type { PolicyData } from "../hr/types";
import { dayYear, plural } from "../lib/format";
import { ImageCropper } from "../image-crop";
import { post } from "../records";
import { Badge, Empty, Panel, styles } from "../ui";
import css from "./settings.module.css";
import type { SettingsData } from "./types";
import { dest } from "../destinations/registry.mjs";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** ISO weekdays as "Mon to Sat", or a list when they are not one run. */
function workingDays(days: number[]) {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!sorted.length) return "None set";
  const run = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return run && sorted.length > 2 ? `${DAYS[sorted[0] - 1]} to ${DAYS[sorted.at(-1)! - 1]}` : sorted.map((d) => DAYS[d - 1]).join(", ");
}
const addMinutes = (hhmm: string, minutes: number) => { const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + minutes; return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };
const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? "day" : "days"}`;

/** The working rules HR keeps (shift, working days, leave, holidays), read-only here; they are edited in the HR desk. */
export function WorkingRules({ data, error }: { data?: PolicyData; error?: string }) {
  const edit = <Link href="/hr?tab=policies" className={styles.panelAction}>Edit in HR desk<ChevronRight size={13} aria-hidden="true" /></Link>;
  if (!data) return <Panel fill title="Working rules" tools={edit}><Empty icon={CalendarClock} compact title="The working rules are not available right now" text={error ? `The HR service said: “${error}”. Nothing has been changed.` : "Refresh in a moment."} /></Panel>;
  const { policy, types, holidays } = data; const active = types.filter((t) => t.active); const year = data.today.slice(0, 4);
  const thisYear = holidays.filter((h) => h.day.slice(0, 4) === year); const next = holidays.find((h) => h.day >= data.today);
  return (
    <Panel fill title="Working rules" sub={policy.confirmedAt ? <Badge tone="success">Confirmed by HR</Badge> : <Badge tone="warning">Not confirmed by HR yet</Badge>} tools={edit}>
      <dl className={styles.facts}>
        <dt>Shift</dt><dd>{policy.shiftStart} to {policy.shiftEnd}</dd>
        <dt>Late after</dt><dd>{addMinutes(policy.shiftStart, policy.graceMinutes)} <span className={styles.muted}>· {policy.graceMinutes} min grace</span></dd>
        <dt>Working days</dt><dd>{workingDays(policy.workDays)}</dd>
        <dt>Work from home</dt><dd>{policy.wfhPerMonth === null ? "No monthly limit" : policy.wfhPerMonth === 0 ? "Not allowed without approval" : `${days(policy.wfhPerMonth)} a month for each person`}</dd>
        <dt>Leave year</dt><dd>Starts in {MONTHS[policy.leaveYearStart - 1]}</dd>
        <dt>Leave types</dt><dd>{active.length ? <ul className={css.rules}>{active.map((t) => (
          <li key={t.key}><b>{t.name}</b><span>{t.annualDays === null ? "No fixed allowance" : `${days(t.annualDays)} a year`}{t.annualDays !== null && t.accrual === "monthly" ? ", earned month by month" : ""}{t.carryForwardMax ? `, up to ${days(t.carryForwardMax)} carried forward` : ""} · {t.paid ? "paid" : "unpaid"}</span></li>
        ))}</ul> : <span className={styles.muted}>None set up</span>}</dd>
        <dt>Holidays</dt><dd>{thisYear.length ? <>{plural(thisYear.length, "holiday")} listed for {year}{next ? <span className={styles.muted}> · next: {next.name}, {dayYear(next.day)}</span> : null}</> : <span className={styles.muted}>None listed for {year} yet</span>}</dd>
        <dt>Counted from</dt><dd>{dayYear(policy.trackingFrom)} <span className={styles.muted}>· attendance and leave balances start on this day</span></dd>
      </dl>
      <p className={styles.panelFoot}>{policy.confirmedAt ? `HR confirmed these rules on ${dayYear(policy.confirmedAt)}${data.confirmedBy ? ` (${data.confirmedBy})` : ""}.` : "These are the rules Pulse started with. Until HR confirms them in the HR desk, leave balances are shown as provisional."} HR and admins change them in the HR desk; this page only shows them.</p>
    </Panel>
  );
}

/** The organisation's name (editable), its code and slug (fixed), and what is not configurable yet. */
export function Organisation({ org, canEdit }: { org: SettingsData["org"]; canEdit: boolean }) {
  const router = useRouter(); const [name, setName] = useState(org.name); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const next = name.replace(/\s+/g, " ").trim(); const changed = next !== org.name;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) return;
    setBusy(true); setError("");
    try { await post("settings/org", { name: next }); notify({ id: "org", tone: "success", title: "Organisation name saved", timeout: 2500 }); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  // Details and brand sit side by side: one view, no second row of sub-tabs.
  return <div className={css.orgPair}>
    <Panel title="Organisation">
      <form className={css.orgForm} onSubmit={submit}>
        <label className={styles.field}>Name<input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} readOnly={!canEdit} autoComplete="off" /></label>
        {canEdit ? <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!changed || busy}>{busy ? "Saving…" : "Save name"}</button> : null}
        {changed && !busy ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { setName(org.name); setError(""); }}>Reset</button> : null}
        {error ? <p role="alert" className={styles.status} style={{ flexBasis: "100%", color: "var(--theme-danger)" }}>{error}</p> : null}
      </form>
      <dl className={styles.facts} style={{ borderTop: "1px solid var(--soft)", paddingTop: 12 }}>
        <dt>Code</dt><dd><span className={styles.mono}>{org.code}</span> <span className={styles.muted}>· starts every employee ID, e.g. {org.code}-P007</span></dd>
        <dt>Slug</dt><dd><span className={styles.mono}>{org.slug}</span> <span className={styles.muted}>· used in addresses and exports</span></dd>
      </dl>
      <p className={styles.panelFoot}>The code and slug are fixed: IDs and links already in use depend on them.</p>
    </Panel>
    <LogoSettings canEdit={canEdit} />
  </div>;
}

type Brand = { name: string | null; version: number; mark: boolean; logo: boolean; logoDark: boolean; logoPng: boolean };
const SLOTS = [
  { kind: "mark", has: "mark", label: "Square mark", hint: "Heads Pulse's navigation rail. A square picture, at least 64 px." },
  { kind: "logo", has: "logo", label: "Logo, light background", hint: "The sign-in page, e-mails, printed copies and the phone's page list." },
  { kind: "logo-dark", has: "logoDark", label: "Logo, dark background", hint: "Used in dark mode. Leave empty to use the light logo." },
] as const;
export const toBase64 = (blob: Blob) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => fail(new Error("Could not read the file")); r.readAsDataURL(blob); });
/** E-mail clients do not show SVG: the light logo also goes up as a 96 px tall PNG, drawn here in the browser. */
export async function emailPng(file: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const h = 96, w = Math.max(1, Math.round((img.naturalWidth || 300) * h / (img.naturalHeight || 96)));
    const canvas = document.createElement("canvas"); canvas.width = Math.min(w, 960); canvas.height = h;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, h);
    return await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

/** LAYOUT-SWEEP: the organisation's own logo (an organisation setting): the rail, the sign-in page, e-mails, prints. */
function LogoSettings({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  useEffect(() => { void fetch("/api/v0/brand", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((b: Brand | null) => setBrand(b)).catch(() => setBrand(null)); }, []);
  async function save(kind: string, body: Record<string, unknown>) {
    const next = await post<Brand & { version: number }>("settings/brand", { kind, ...body }); setBrand(next); return next;
  }
  // PEOPLE-CONTACTS: a photo-like logo (PNG, JPEG, WebP) opens the cropper first (trim, straighten, square or wide);
  // an SVG is a drawing and goes up as it is.
  const [cropping, setCropping] = useState<{ kind: string; file: File } | null>(null);
  async function upload(kind: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    setError("");
    if (file.type !== "image/svg+xml") { setCropping({ kind, file }); return; }
    await store(kind, file);
  }
  async function store(kind: string, file: Blob) {
    setBusy(kind);
    try {
      if (file.size > 512 * 1024) throw new Error("Choose a picture under 512 KB");
      await save(kind, { mime: file.type, data: await toBase64(file) });
      if (kind === "logo") { const png = await emailPng(file); if (png && png.size <= 512 * 1024) await save("logo-png", { mime: "image/png", data: await toBase64(png) }); }
      notify({ id: "org-logo", tone: "success", title: "Logo saved", message: "Pulse shows it now; e-mails and printed copies use it from the next one.", timeout: 3000 });
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the logo"); } finally { setBusy(""); }
  }
  async function remove(kind: string) {
    setError(""); setBusy(kind);
    try { await save(kind, { remove: true }); if (kind === "logo") await save("logo-png", { remove: true }); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove the logo"); } finally { setBusy(""); }
  }
  return <Panel title="Logo" sub={brand?.version ? "Shown across Pulse" : undefined}>
    <ul className={css.logos} {...dest("settings.organisation.logo")}>{SLOTS.map((slot) => {
      const has = !!brand?.[slot.has];
      return <li key={slot.kind}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the organisation's logo, served by the app */}
        <span className={css.logoPreview} data-kind={slot.kind}>{has ? <img src={`/api/v0/brand/${slot.kind}?v=${brand?.version ?? 0}`} alt={`${slot.label} of ${brand?.name ?? "the organisation"}`} /> : <Palette size={18} aria-hidden="true" />}</span>
        <span className={css.logoText}><b>{slot.label}</b><small>{has ? slot.hint : `Not set. ${slot.hint}`}</small></span>
        {canEdit ? <span className={css.logoActions}>
          <label className={`${styles.btn} ${styles.btnSmall}`} aria-disabled={!!busy}><ImageUp size={14} aria-hidden="true" />{busy === slot.kind ? "Saving…" : has ? "Replace" : "Upload"}
            <input type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg" className={css.fileInput} disabled={!!busy} onChange={(e) => void upload(slot.kind, e)} aria-label={`${has ? "Replace" : "Upload"} the ${slot.label.toLowerCase()}`} /></label>
          {has ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={!!busy} onClick={() => void remove(slot.kind)} aria-label={`Remove the ${slot.label.toLowerCase()}`}><Trash2 size={14} aria-hidden="true" /></button> : null}
        </span> : null}
      </li>;
    })}</ul>
    {error ? <p role="alert" className={styles.status} style={{ margin: "0 14px 12px", color: "var(--theme-danger)" }}>{error}</p> : null}
    <p className={styles.panelFoot}>SVG, PNG, WebP or JPEG up to 512 KB. Pictures open in the cropper first; an SVG may not contain scripts or links to other files. Every change is recorded.</p>
    {cropping ? <ImageCropper file={cropping.file} title={`Crop the ${SLOTS.find((s) => s.kind === cropping.kind)?.label.toLowerCase() ?? "logo"}`}
      shapes={cropping.kind === "mark" ? ["square", "circle"] : ["wide", "square"]} alpha doneLabel="Use logo" long={cropping.kind === "mark" ? 512 : 1600} maxBytes={500 * 1024}
      onCancel={() => setCropping(null)} onDone={async (r) => { setCropping(null); await store(cropping.kind, r.blob); }} /> : null}
  </Panel>;
}
