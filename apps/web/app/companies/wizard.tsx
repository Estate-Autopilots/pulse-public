"use client";
// UX-TENANT: the setup wizard for a new company on this Pulse (operator only). Each step previews before it writes and
// can be run again; every write lands in the new company (services/api/src/tenants.ts → pulse.tenant_*). Nothing is
// e-mailed unless the operator presses Send, and a rehearsal company never sends.
// R53: the company step shows the setup plan row by row (and a setup file repeats it for the next company), Sources
// keeps the company's source registry, and Hand over and activate takes it from trial to its staff once every gate passes.
import { AlertTriangle, Check, Copy, FileJson, ImageUp, Info, KeyRound, Lock, Palette, Rocket, Send, ShieldCheck, Trash2, UserRound, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { BRAND } from "@pulse/design-system/brand";
import { notify } from "@pulse/ui-shell";
import { ImageCropper } from "../image-crop";
import { plural } from "../lib/format";
import { post } from "../records";
import { emailPng, toBase64 } from "../settings/organisation";
import { ROLES as RULE_ROLES, SCOPE } from "../settings/work-rules";
import { Badge, Panel, styles } from "../ui";
import { AccentPicker, initialsMark } from "./accent";
import css from "./companies.module.css";
import { GateLine, GuideList, PlanTable, ReadinessNote } from "./checklist";
import { CATEGORIES, SENSITIVE, SOURCE_KINDS, STEPS, type StepKey } from "./steps";
import type { CompanyCheck, PeoplePreview, Person, Plan, Setup } from "./types";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"];
const ACCESS = ["admin", "hr", "leadership", "finance", "manager"] as const;
const ACCESS_LABEL: Record<string, string> = { admin: "Admin", hr: "HR", leadership: "Leadership", finance: "Finance", manager: "Pod manager" };
/** The choices pulse.work_rule_options() allows, first = default (UX-TASKS). */
const RULE_OPTIONS: Record<string, Record<string, string[]>> = {
  hr: { "task.assign": ["anyone", "pod", "self"], "task.ask": ["anyone", "pod", "none"], "project.create": ["anyone", "pod", "none"] },
  pod_head: { "task.assign": ["pod", "self"], "task.ask": ["anyone", "pod", "none"], "project.create": ["pod", "none"] },
  member: { "task.assign": ["self", "pod"], "task.ask": ["anyone", "pod", "none"], "project.create": ["none", "pod"] },
};
const RULE_LABEL: Record<string, string> = { "task.assign": "Assign tasks to others", "task.ask": "Ask someone to take a task", "project.create": "Create projects" };
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";

function done(s: Setup, key: StepKey): boolean {
  if (key === "company") return !!s.org;
  if (key === "admin") return !!s.admin;
  if (key === "open") return s.status === "open" || s.status === "live";
  if (key === "sources") return !!s.activation?.sources.length;
  if (key === "activate") return s.activation?.company.activation === "live" && s.org?.status === "active";
  return !!s.steps[key];
}
function summary(s: Setup, key: StepKey): string {
  if (key === "company") return s.org ? `${s.org.code} · ${s.org.host}` : "Name and address";
  if (key === "brand") return s.brand?.accent ? `Accent ${s.brand.accent}${s.brand.logo || s.brand.mark ? ", logo" : ""}` : "Optional";
  if (key === "admin") return s.admin ? `${s.admin.name} · ${s.admin.invitation === "sent" ? "invited" : s.admin.signedIn ? "signed in" : s.admin.linkReady ? "link ready" : "not invited yet"}` : "Who runs it";
  if (key === "people") return plural(s.counts?.people ?? 0, "person", "people");
  if (key === "structure") return `${plural(s.counts?.pods ?? 0, "pod")} · ${plural(s.counts?.admins ?? 0, "admin")}`;
  if (key === "settings") { const pack = (s.steps.pack as { name?: string } | undefined)?.name; const mods = s.modules ? Object.entries(s.modules).filter(([, v]) => v).map(([k]) => k).join(", ") || "All off" : "";
    return [pack, mods].filter(Boolean).join(" · "); }
  if (key === "sources") return s.activation ? plural(s.activation.sources.length, "source") : "Which sources it uses";
  if (key === "activate") return !s.activation ? "After opening" : s.activation.company.activation === "live" ? "Live for staff" : s.org?.status !== "active" ? "After opening" : s.activation.ready ? "Ready to activate" : `${plural(s.activation.blocked.length, "gate")} open`;
  return s.status === "open" || s.status === "live" ? "Open for sign-in" : s.checklist.blocked.length ? `${s.checklist.blocked.length} to do` : "Ready to open";
}

export function Wizard({ initial, step }: { initial: Setup; step: StepKey }) {
  const [s, setS] = useState(initial);
  const locked = !!s.org && s.org.status !== "setup";
  const update = (next?: Setup) => { if (next) setS(next); };
  const panels: Record<StepKey, ReactNode> = {
    company: <CompanyStep s={s} locked={locked} onSaved={update} />,
    brand: <BrandStep s={s} locked={locked} onSaved={update} />,
    admin: <AdminStep s={s} locked={locked} onSaved={update} />,
    people: <PeopleStep s={s} locked={locked} onSaved={update} />,
    structure: <StructureStep s={s} locked={locked} onSaved={update} />,
    settings: <SettingsStep s={s} locked={locked} onSaved={update} />,
    sources: <SourcesStep s={s} locked={locked} onSaved={update} />,
    open: <OpenStep s={s} onSaved={update} />,
    activate: <ActivateStep s={s} onSaved={update} />,
  };
  const current = s.org || step === "company" ? step : "company";
  return <div className={css.wizard}>
    <nav className={css.steps} aria-label="Setup steps"><ol>{STEPS.map((st, i) => {
      const state = done(s, st.key) ? "done" : st.key === current ? "current" : "todo";
      const body = <><span className={css.no} data-state={state}>{state === "done" ? <Check size={13} aria-hidden="true" /> : i + 1}</span><span><b>{st.label}</b><small>{summary(s, st.key)}</small></span></>;
      return <li key={st.key}>{s.org || st.key === "company" ? <Link href={`/companies/${s.id}?step=${st.key}`} scroll={false} aria-current={st.key === current ? "step" : undefined}>{body}</Link> : <span aria-disabled="true">{body}</span>}</li>;
    })}</ol></nav>
    <div className={css.stage}>
      {s.org?.rehearsal ? <p className={css.banner} data-tone="info"><Info size={16} aria-hidden="true" /><span><b>Rehearsal company.</b> Synthetic people only. It never sends e-mail; its admin gets a private link instead. It is not {s.org.name.replace(/\s*\(rehearsal\)\s*$/i, "")}&apos;s real Pulse.</span></p> : null}
      {locked ? <p className={css.banner} data-tone="success"><Lock size={16} aria-hidden="true" /><span><b>{s.activation?.company.activation === "trial" ? "Open in trial." : "Open for sign-in."}</b> {s.org?.name}&apos;s own admins change it now, in their Settings. This page shows its setup, its checklist and its health.</span></p> : null}
      {panels[current]}
    </div>
  </div>;
}

function Problems({ items, tone = "danger" }: { items: string[]; tone?: "danger" | "warning" }) {
  return items.length ? <ul className={css.bullets} data-tone={tone} role={tone === "danger" ? "alert" : undefined}>{items.map((p) => <li key={p}>{p}</li>)}</ul> : null;
}

function CompanyStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const router = useRouter();
  const [f, setF] = useState({ name: s.org?.name ?? s.name, slug: s.org?.slug ?? s.suggestions.slug, code: s.org?.code ?? s.suggestions.code, timeZone: s.org?.timeZone ?? "",
    dataRegion: s.org?.dataRegion ?? "in", host: s.org?.host ?? "", rehearsal: s.org?.rehearsal ?? /rehearsal/i.test(s.name) });
  const [check, setCheck] = useState<CompanyCheck | null>(null), [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setCheck(null); setPlan(null); setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }); };
  async function send(dry: boolean) {
    setBusy(dry ? "check" : "save"); setError("");
    try {
      const r = await post<{ check: CompanyCheck; plan: Plan; setup?: Setup }>(`tenants/${s.id}/company`, { ...f, check: dry });
      setCheck(r.check); setPlan(r.plan);
      if (r.setup) { onSaved(r.setup); notify({ id: "tenant", tone: "success", title: s.org ? "Company saved" : "Company created", message: `${f.name} is being set up; nobody can sign in until you open it.`, timeout: 3500 }); router.push(`/companies/${s.id}?step=${s.org ? "company" : "brand"}`, { scroll: false }); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <><Panel title="Company and address" sub={s.org ? <Badge tone={s.org.status === "setup" ? "warning" : "success"}>{s.org.status === "setup" ? "Being set up" : "Open"}</Badge> : <Badge>Not created yet</Badge>}>
    <form className={css.form} onSubmit={(e) => { e.preventDefault(); void send(false); }}>
      <label className={`${styles.field} ${css.wide}`}>Company name<input value={f.name} onChange={set("name")} required minLength={2} maxLength={80} disabled={locked} autoComplete="off" /></label>
      <label className={styles.field}>Short name<input value={f.slug} onChange={set("slug")} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" disabled={locked} spellCheck={false} /><small className={styles.muted}>Lowercase, in exports and links</small></label>
      <label className={styles.field}>Code<input value={f.code} onChange={set("code")} required pattern="[A-Za-z]{2,4}" maxLength={4} disabled={locked} spellCheck={false} /><small className={styles.muted}>2–4 letters; starts every employee ID</small></label>
      <label className={styles.field}>Time zone<input value={f.timeZone} onChange={set("timeZone")} list="tenant-zones" required placeholder="e.g. Asia/Kolkata" disabled={locked} spellCheck={false} />
        <datalist id="tenant-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist></label>
      <label className={styles.field}>Where the data is kept<SelectField value={f.dataRegion} onChange={set("dataRegion")} disabled={locked}><option value="in">India</option><option value="eu">European Union</option><option value="us">United States</option><option value="other">Elsewhere</option></SelectField></label>
      <label className={`${styles.field} ${css.wide}`}>Web address<input value={f.host} onChange={set("host")} required placeholder="pulse.atlascrest.example" disabled={locked} spellCheck={false} autoComplete="off" />
        <small className={styles.muted}>Its people open Pulse here and sign in with Pulse passwords. Point the address at this Pulse in Cloudflare (no Access in front of it). A *.localhost address is a rehearsal on this machine.</small></label>
      <label className={`${css.check} ${css.wide}`}><input type="checkbox" checked={f.rehearsal} onChange={set("rehearsal")} disabled={locked || !!s.org} /><span><b>Rehearsal</b> · synthetic people only; never sends e-mail. {s.org ? "Fixed once created." : ""}</span></label>
    </form>
    {check ? <><Problems items={check.problems} /><Problems items={check.warnings} tone="warning" /></> : null}
    {plan && check?.ok ? <><p className={css.note}><b>{plan.applied ? "Written, row by row:" : s.org ? "Saving will write exactly these rows:" : "Creating it will write exactly these rows, in one transaction:"}</b></p><PlanTable plan={plan} /></> : null}
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {locked ? null : <div className={css.actions}>
      <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void send(true)}>{busy === "check" ? "Checking…" : "Check first"}</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void send(false)}>{busy === "save" ? "Saving…" : s.org ? "Save" : "Create company"}</button>
    </div>}
  </Panel>
  <SetupFile s={s} locked={locked} onSaved={onSaved} /></>;
}

/** R53: a company's plan as a file. Copy it from one company; start the next from it (with its own name, code and address). */
function SetupFile({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const router = useRouter();
  const [text, setText] = useState(""), [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  async function load() {
    setBusy("load"); setError("");
    try { const r = await (await fetch(`/api/v0/tenants/${s.id}/plan`, { cache: "no-store" })).json(); if (r.error) throw new Error(r.error); setText(JSON.stringify(r.spec, null, 2)); }
    catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function run(apply: boolean) {
    setBusy(apply ? "apply" : "preview"); setError("");
    try {
      let spec: unknown; try { spec = JSON.parse(text); } catch { throw new Error("The setup file is not valid JSON"); }
      const r = await post<{ plan: Plan; setup?: Setup }>(`tenants/${s.id}/plan`, { spec, apply });
      setPlan(r.plan);
      if (r.setup) { onSaved(r.setup); notify({ id: "tenant-plan", tone: "success", title: "Setup file applied", message: `${r.plan.summary.create} rows created, ${r.plan.summary.update} changed`, timeout: 3500 }); router.push(`/companies/${s.id}?step=brand`, { scroll: false }); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <Panel title="Setup file" sub={s.org ? "This company's plan, to start the next one from" : "Optional: start from another company's plan"}>
    <p className={css.note} style={{ paddingTop: 12 }}>{s.org ? "Its company details, modules, who can do what and source registry. No people, projects, files or credentials are in it." : "Paste a setup file copied from another company, change its name, short name, code and web address, preview, then apply. Only configuration repeats; nothing of the other company is read or copied."}</p>
    {s.org && !text ? <div className={css.actions}><button type="button" className={styles.btn} disabled={!!busy} onClick={() => void load()}><FileJson size={14} aria-hidden="true" />{busy === "load" ? "Reading…" : "Show the setup file"}</button></div> : null}
    {text || !s.org ? <div style={{ padding: "0 14px 12px" }}><label className={styles.field}>Setup file (JSON)<textarea className={css.paste} value={text} readOnly={!!s.org} onChange={(e) => { setText(e.target.value); setPlan(null); }} spellCheck={false} placeholder='{"contract":"pulse.setup.v1","company":{…},"modules":{…},"rules":[…],"sources":[…]}' /></label></div> : null}
    {s.org && text ? <div className={css.actions}><button type="button" className={styles.btn} onClick={() => void navigator.clipboard?.writeText(text).then(() => notify({ id: "copied", tone: "success", title: "Setup file copied", timeout: 2000 }))}><Copy size={14} aria-hidden="true" />Copy</button></div> : null}
    {plan ? <><Problems items={plan.problems} /><Problems items={plan.warnings} tone="warning" />{plan.ok ? <PlanTable plan={plan} /> : null}</> : null}
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {s.org || locked ? null : <div className={css.actions}>
      <button type="button" className={styles.btn} disabled={!text.trim() || !!busy} onClick={() => void run(false)}>{busy === "preview" ? "Checking…" : "Preview the file"}</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!plan?.ok || plan.applied || !!busy} onClick={() => void run(true)}>{busy === "apply" ? "Applying…" : "Apply the file"}</button>
    </div>}
  </Panel>;
}

const SLOTS = [
  { kind: "mark", has: "mark", label: "Square mark", hint: "Heads the navigation rail. Square, at least 64 px." },
  { kind: "logo", has: "logo", label: "Logo, light background", hint: "The sign-in page, e-mails and printed copies." },
  { kind: "logo-dark", has: "logoDark", label: "Logo, dark background", hint: "Dark mode. Empty: the light logo is used." },
] as const;

function BrandStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [cropping, setCropping] = useState<{ kind: string; file: File } | null>(null);
  const accent = s.brand?.accent ?? BRAND.iris; const v = s.brand?.version ?? 0; const name = s.org?.name ?? s.name;
  const src = (kind: string) => `/api/v0/tenants/${s.id}/brand/${kind}?v=${v}`;
  const save = async (body: Record<string, unknown>) => onSaved(await post<Setup>(`tenants/${s.id}/brand`, body));
  async function store(kind: string, file: Blob) {
    setBusy(kind); setError("");
    try {
      if (file.size > 512 * 1024) throw new Error("Choose a picture under 512 KB");
      await save({ kind, mime: file.type, data: await toBase64(file) });
      if (kind === "logo") { const png = await emailPng(file); if (png && png.size <= 512 * 1024) await save({ kind: "logo-png", mime: "image/png", data: await toBase64(png) }); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function upload(kind: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (file.type !== "image/svg+xml") { setCropping({ kind, file }); return; }
    await store(kind, file);
  }
  async function makeMark() {
    setBusy("mark"); setError("");
    try { await save({ kind: "mark", mime: "image/svg+xml", data: btoa(initialsMark(name, accent)) }); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <div className={css.brandGrid}>
    <div className={css.stage}>
      <Panel title="Accent colour" sub="Buttons, links and focus on the company's address">
        <AccentPicker value={s.brand?.accent ?? null} disabled={locked} onSave={async (hex) => save({ accent: hex })} />
        <p className={styles.panelFoot}>Pulse&apos;s own palette (UX-NOTIFY brand system). A colour must carry white text (4.5:1); the dark theme uses a lighter mix of it.</p>
      </Panel>
      <Panel title="Logo" sub={v ? "Saved for the company" : undefined}>
        <ul className={css.slots}>{SLOTS.map((slot) => {
          const has = !!s.brand?.[slot.has];
          return <li key={slot.kind}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the new company's logo, served by the app */}
            <span className={css.slotPreview} data-kind={slot.kind}>{has ? <img src={src(slot.kind)} alt={`${slot.label} of ${name}`} /> : <Palette size={18} aria-hidden="true" />}</span>
            <span className={css.slotText}><b>{slot.label}</b><small>{has ? slot.hint : `Not set. ${slot.hint}`}</small></span>
            {locked ? null : <span className={css.slotActions}>
              <label className={`${styles.btn} ${styles.btnSmall}`} aria-disabled={!!busy}><ImageUp size={14} aria-hidden="true" />{busy === slot.kind ? "Saving…" : has ? "Replace" : "Upload"}
                <input type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg" className={css.fileInput} disabled={!!busy} onChange={(e) => void upload(slot.kind, e)} aria-label={`${has ? "Replace" : "Upload"} the ${slot.label.toLowerCase()}`} /></label>
              {has ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={!!busy} onClick={() => void save({ kind: slot.kind, remove: true }).catch((e) => setError(message(e)))} aria-label={`Remove the ${slot.label.toLowerCase()}`}><Trash2 size={14} aria-hidden="true" /></button> : null}
              {slot.kind === "mark" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void makeMark()}><Wand2 size={14} aria-hidden="true" />From initials</button> : null}
            </span>}
          </li>;
        })}</ul>
        {error ? <p role="alert" className={css.error}>{error}</p> : null}
        <p className={styles.panelFoot}>SVG, PNG, WebP or JPEG up to 512 KB; pictures open in the cropper first. &ldquo;From initials&rdquo; draws a mark on Pulse&apos;s rounded tile in the accent colour.</p>
        {cropping ? <ImageCropper file={cropping.file} title={`Crop the ${SLOTS.find((x) => x.kind === cropping.kind)?.label.toLowerCase() ?? "logo"}`}
          shapes={cropping.kind === "mark" ? ["square", "circle"] : ["wide", "square"]} alpha doneLabel="Use logo" long={cropping.kind === "mark" ? 512 : 1600} maxBytes={500 * 1024}
          onCancel={() => setCropping(null)} onDone={async (r) => { setCropping(null); await store(cropping.kind, r.blob); }} /> : null}
      </Panel>
    </div>
    <Panel title="How it looks" sub="Sign-in page and rail">
      <div className={css.preview}>
        <div className={css.signin}>
          {/* eslint-disable-next-line @next/next/no-img-element -- preview of the saved logo */}
          {s.brand?.logo ? <img src={src("logo")} alt="" /> : s.brand?.mark ? <img src={src("mark")} alt="" style={{ height: 44 }} /> : <Palette size={28} aria-hidden="true" />}
          <strong>Sign in to {name}</strong>
          <span className={css.field} aria-hidden="true" /><span className={css.field} aria-hidden="true" />
          <span className={css.go} style={{ background: accent }}>Sign in</span>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- preview of the saved mark */}
        <div className={css.tile}>{s.brand?.mark ? <img src={src("mark")} alt="" /> : <span className={css.no}>?</span>}<span>{name} · the rail&apos;s top</span></div>
      </div>
    </Panel>
  </div>;
}

function AdminStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const a = s.admin;
  const [f, setF] = useState({ name: a?.name ?? "", email: a?.email ?? "", title: a?.title ?? "Admin" });
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [link, setLink] = useState<string | null>(null), [confirmLink, setConfirmLink] = useState(false), [confirmSend, setConfirmSend] = useState(false);
  const host = s.org?.host ?? "";
  async function save() { setBusy("save"); setError(""); try { onSaved(await post<Setup>(`tenants/${s.id}/admin`, f)); } catch (e) { setError(message(e)); } finally { setBusy(""); } }
  async function invite(action: "link" | "send") {
    setBusy(action); setError("");
    try {
      const r = await post<{ link?: string; sent?: boolean; recipient?: string }>(`tenants/${s.id}/invite`, { action, confirmed: true });
      if (r.link) setLink(r.link);
      if (r.sent) notify({ id: "tenant-invite", tone: "success", title: "Invitation sent", message: `To ${r.recipient}`, timeout: 4000 });
      onSaved(await (await fetch(`/api/v0/tenants/${s.id}`, { cache: "no-store" })).json());
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  const status = !a ? null : a.signedIn ? <Badge tone="success">Signed in</Badge> : a.invitation === "sent" ? <Badge tone="success">Invitation sent</Badge> : a.linkReady ? <Badge tone="accent">Link ready</Badge> : <Badge tone="warning">Not invited yet</Badge>;
  return <>
    <Panel title="First admin" sub={status ?? "Runs the company's Pulse"}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className={styles.field}>Full name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} disabled={locked} autoComplete="off" /></label>
        <label className={styles.field}>Work e-mail<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required disabled={locked} autoComplete="off" spellCheck={false} /></label>
        <label className={styles.field}>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={80} disabled={locked} /></label>
      </form>
      {a ? <p className={css.note}>Username <b className={styles.mono}>{a.username}</b> · admin of {s.org?.name}. They choose their own password; Pulse asks admins for two-step verification after the grace period.</p> : null}
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      {locked ? null : <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy || !f.name || !f.email} onClick={() => void save()}><UserRound size={14} aria-hidden="true" />{busy === "save" ? "Saving…" : a ? "Save admin" : "Add admin"}</button></div>}
    </Panel>
    {a && s.invitation ? <Panel title="Invitation" sub="The same invitation HR sends from People">
      <div className={css.mail}><dl><dt>To</dt><dd>{a.email}</dd><dt>From</dt><dd>{s.mail.from ?? <span className={styles.muted}>not configured</span>}</dd><dt>Subject</dt><dd>{s.invitation.subject}</dd></dl>
        <p>{`Hello ${a.name},\n\n${s.org?.name} now has Pulse at ${host}. You are its first admin.\n\nYour Pulse username: ${a.username}\nSet your password: a private one-time link (expires in 7 days).`}</p></div>
      {link ? <div className={css.link}><KeyRound size={16} aria-hidden="true" /><code>{link}</code><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void navigator.clipboard?.writeText(link).then(() => notify({ id: "copied", tone: "success", title: "Link copied", timeout: 2000 }))}><Copy size={14} aria-hidden="true" />Copy</button>
        <small className={styles.muted} style={{ flexBasis: "100%" }}>Shown once. Hand it to {a.name} yourself; it works once and expires in 7 days.</small></div> : null}
      {locked || a.signedIn || a.invitation === "used" ? null : <>
        <div className={css.actions}>
          <label className={css.check}><input type="checkbox" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} disabled={!s.mail.sendEnabled} /><span>I checked the address: {a.email}</span></label>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!s.mail.sendEnabled || !confirmSend || !!busy || a.invitation === "sent"} onClick={() => void invite("send")}><Send size={14} aria-hidden="true" />{busy === "send" ? "Sending…" : a.invitation === "sent" ? "Sent" : "Send invitation"}</button>
        </div>
        {!s.mail.sendEnabled ? <p className={css.note}>Send is off: {s.mail.reason}.</p> : null}
        <div className={css.actions}>
          <label className={css.check}><input type="checkbox" checked={confirmLink} onChange={(e) => setConfirmLink(e.target.checked)} /><span>I will hand the link to {a.name} privately</span></label>
          <button type="button" className={styles.btn} disabled={!confirmLink || !!busy} onClick={() => void invite("link")}><KeyRound size={14} aria-hidden="true" />{busy === "link" ? "Preparing…" : "Get a private link"}</button>
        </div>
      </>}
    </Panel> : null}
  </>;
}

const TEMPLATE = "Name,Email,Title,Pod,Team,Manager,Access\nPriya Soniba,priya@example.com,Sales lead,Closers,Sales,,manager\n";
function PeopleStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [csv, setCsv] = useState(""), [preview, setPreview] = useState<PeoplePreview | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  async function run(apply: boolean) {
    setBusy(apply ? "apply" : "preview"); setError("");
    try {
      const r = await post<PeoplePreview>(`tenants/${s.id}/people`, { source: "csv", csv, apply });
      setPreview(r); if (r.setup) { onSaved(r.setup); notify({ id: "tenant-people", tone: "success", title: "People imported", message: `${r.new} added, ${r.update} updated`, timeout: 3500 }); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function file(event: ChangeEvent<HTMLInputElement>) { const f = event.target.files?.[0]; event.target.value = ""; if (f) { setCsv(await f.text()); setPreview(null); } }
  return <>
    <Panel title="People" sub={`${s.counts?.people ?? 0} in ${s.org?.name ?? "the company"} now`}>
      <ul className={css.toggles}>
        <li><span><b>A CSV file</b><small>One person per line. Columns (any order): Name, Email, Title, Pod, Team, Manager (e-mail or name), Access (admin, hr, leadership, finance, manager). Nobody is invited by importing.</small></span>
          <span className={css.slotActions}><a className={`${styles.btn} ${styles.btnSmall}`} href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="people-template.csv">Template</a>
            {locked ? null : <label className={`${styles.btn} ${styles.btnSmall}`}><ImageUp size={14} aria-hidden="true" />Choose file<input type="file" accept=".csv,text/csv" className={css.fileInput} onChange={(e) => void file(e)} aria-label="Choose a CSV file" /></label>}</span></li>
        <li><span><b>Google Workspace directory</b><small>{s.workspace.reason}</small></span><Badge tone="neutral">Not connected</Badge></li>
      </ul>
      {locked ? null : <div style={{ padding: "0 14px 12px" }}><label className={styles.field}>Or paste the CSV<textarea className={css.paste} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} spellCheck={false} placeholder={TEMPLATE} /></label></div>}
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      {locked ? null : <div className={css.actions}>
        <button type="button" className={styles.btn} disabled={!csv.trim() || !!busy} onClick={() => void run(false)}>{busy === "preview" ? "Reading…" : "Preview"}</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!preview || preview.applied || !!busy || preview.new + preview.update === 0} onClick={() => void run(true)}>{busy === "apply" ? "Importing…" : preview ? `Import ${preview.new + preview.update} people` : "Import"}</button>
      </div>}
    </Panel>
    {preview ? <Panel title={preview.applied ? "Imported" : "Preview"} sub={`${preview.total} lines read`}>
      <div className={css.summary}><Badge tone="success">{preview.new} new</Badge><Badge tone="accent">{preview.update} already there</Badge>{preview.skip ? <Badge tone="danger">{preview.skip} skipped</Badge> : null}
        {preview.newPods.length ? <Badge>{preview.newPods.length} new pods: {preview.newPods.join(", ")}</Badge> : null}{preview.newTeams.length ? <Badge>{preview.newTeams.length} new teams</Badge> : null}
        {preview.unresolvedManagers ? <Badge tone="warning">{preview.unresolvedManagers} managers not found</Badge> : null}</div>
      <div className={css.tableWrap}><table className={css.table}><thead><tr><th>#</th><th>Name</th><th>E-mail</th><th>Title</th><th>Pod / team</th><th>Access</th><th>Manager</th><th>Result</th></tr></thead>
        <tbody>{preview.rows.map((r) => <tr key={r.row}><td>{r.row}</td><td>{r.name || "—"}</td><td>{r.email ?? "—"}</td><td>{r.title ?? "—"}</td><td>{[r.pod, r.team].filter(Boolean).join(" · ") || "—"}</td><td>{r.access ?? "—"}</td><td>{r.manager ?? "—"}</td>
          <td>{r.status === "skip" ? <><Badge tone="danger">Skipped</Badge><small>{r.problems.join("; ")}</small></> : <Badge tone={r.status === "new" ? "success" : "accent"}>{r.status === "new" ? "New" : "Update"}</Badge>}</td></tr>)}</tbody></table></div>
    </Panel> : null}
  </>;
}

type Op = Record<string, unknown> & { op: string };
function StructureStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [ops, setOps] = useState<Op[]>([]), [pod, setPod] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const people = useMemo(() => s.people ?? [], [s.people]);
  const pods = useMemo(() => [...new Set([...(s.pods ?? []), ...ops.filter((o) => o.op === "pod").map((o) => String(o.name))])].sort(), [s.pods, ops]);
  const teams = useMemo(() => [...new Set(people.map((p) => p.team).filter(Boolean) as string[])].sort(), [people]);
  const pending = (p: Person) => ops.filter((o) => o.personId === p.id);
  const place = (p: Person, key: "pod" | "team", value: string) => setOps([...ops.filter((o) => !(o.op === "place" && o.personId === p.id && key in o)), { op: "place", personId: p.id, [key]: value }]);
  const valueOf = (p: Person, key: "pod" | "team") => { const o = [...pending(p)].reverse().find((x) => x.op === "place" && key in x); return o ? String(o[key] ?? "") : p[key] ?? ""; };
  const hasRole = (p: Person, role: string) => { const o = [...pending(p)].reverse().find((x) => x.op === "role" && x.role === role); return o ? o.grant === true : p.roles.includes(role); };
  const toggleRole = (p: Person, role: string) => { const next = !hasRole(p, role); setOps([...ops.filter((o) => !(o.op === "role" && o.personId === p.id && o.role === role)), ...(next !== p.roles.includes(role) ? [{ op: "role", personId: p.id, role, grant: next }] : [])]); };
  const managerOf = (p: Person) => { const o = [...pending(p)].reverse().find((x) => x.op === "manager"); return o ? String(o.managerId ?? "") : p.managerId ?? ""; };
  async function save() {
    setBusy(true); setError("");
    // Pods first, then places (a manager role needs its pod), then roles and lines.
    const order = ["pod", "pod-rename", "place", "manager", "role"];
    try { onSaved(await post<Setup>(`tenants/${s.id}/structure`, { ops: [...ops].sort((a, b) => order.indexOf(a.op) - order.indexOf(b.op)) })); setOps([]); notify({ id: "tenant-structure", tone: "success", title: "Pods and roles saved", timeout: 2500 }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (!s.people) return <Panel title="Pods, teams and roles"><p className={css.note} style={{ paddingTop: 14 }}>{s.counts?.pods ?? 0} pods, {s.counts?.teams ?? 0} teams and {s.counts?.admins ?? 0} admins. Once open, the company&apos;s own admins manage these in Settings → Team &amp; pods and Roles.</p></Panel>;
  return <>
    <Panel title="Pods" sub={`${pods.length} pods`}>
      <ul className={css.chips}>{pods.length ? pods.map((p) => <li key={p}>{p}</li>) : <li>No pods yet</li>}</ul>
      {locked ? null : <form className={css.actions} onSubmit={(e) => { e.preventDefault(); const name = pod.trim().replace(/\s+/g, " "); if (name.length >= 2 && !pods.some((x) => x.toLowerCase() === name.toLowerCase())) setOps([...ops, { op: "pod", name }]); setPod(""); }}>
        <label className={styles.field} style={{ flex: "0 1 240px" }}>New pod<input value={pod} onChange={(e) => setPod(e.target.value)} maxLength={40} placeholder="e.g. Closers" /></label>
        <button className={`${styles.btn} ${styles.btnSmall}`} disabled={pod.trim().length < 2}>Add pod</button></form>}
    </Panel>
    <Panel title="People, teams and roles" sub={ops.length ? `${ops.length} unsaved changes` : `${people.length} people`}>
      <datalist id="tenant-teams">{teams.map((t) => <option key={t} value={t} />)}</datalist>
      <div className={css.tableWrap}><table className={css.table}><thead><tr><th>Person</th><th>Pod</th><th>Team</th><th>Manager</th><th>Pulse access</th></tr></thead>
        <tbody>{people.map((p) => <tr key={p.id}>
          <td><b>{p.name}</b><small>{p.title}{p.email ? ` · ${p.email}` : ""}</small></td>
          <td><SelectField className={css.cellInput} value={valueOf(p, "pod")} disabled={locked} onChange={(e) => place(p, "pod", e.target.value)} aria-label={`Pod of ${p.name}`}><option value="">No pod</option>{pods.map((x) => <option key={x} value={x}>{x}</option>)}</SelectField></td>
          <td><input className={css.cellInput} list="tenant-teams" value={valueOf(p, "team")} disabled={locked} onChange={(e) => place(p, "team", e.target.value)} aria-label={`Team of ${p.name}`} maxLength={60} /></td>
          <td><SelectField className={css.cellInput} value={managerOf(p)} disabled={locked} onChange={(e) => setOps([...ops.filter((o) => !(o.op === "manager" && o.personId === p.id)), { op: "manager", personId: p.id, managerId: e.target.value || null }])} aria-label={`Manager of ${p.name}`}>
            <option value="">Nobody</option>{people.filter((m) => m.id !== p.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</SelectField></td>
          <td><span className={css.roles}>{ACCESS.map((r) => <label key={r}><input type="checkbox" checked={hasRole(p, r)} disabled={locked} onChange={() => toggleRole(p, r)} />{ACCESS_LABEL[r]}</label>)}</span></td>
        </tr>)}</tbody></table></div>
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      {locked ? null : <div className={css.actions} style={{ paddingTop: 12 }}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!ops.length || busy} onClick={() => void save()}>{busy ? "Saving…" : `Save ${ops.length || ""} changes`.replace("  ", " ")}</button>
        {ops.length ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOps([])}>Discard</button> : null}</div>}
      <p className={styles.panelFoot}>A pod manager needs a pod. Everyone else without a role is a member. The company keeps at least one admin.</p>
    </Panel>
  </>;
}

const MODULES = [
  { key: "tasks", label: "Work and tasks", hint: "Projects' tasks, asks, the pool, workflows and field forms. Datup assigns tasks here." },
  { key: "chats", label: "Chats", hint: "Team chats and direct messages inside the company." },
  { key: "finance", label: "Finance", hint: "Finance desk, Billing (invoices, quotations, catalogue) and money views." },
  { key: "attendance", label: "Attendance", hint: "Check-in, leave and the attendance month. Turn on once HR has set the shift and holidays." },
] as const;
/** FLOW-E: the company's industry (a pack: its words, roles, starter processes and record types), or neutral. */
function IndustryStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [packs, setPacks] = useState<{ key: string; name: string; summary: string; examples: string }[] | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const chosen = (s.steps.pack as { pack?: string } | undefined)?.pack ?? null;
  useEffect(() => { void fetch("/api/v1/flow/packs", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => setPacks(d?.packs ?? [])).catch(() => setPacks([])); }, []);
  async function pick(key: string) {
    setBusy(key); setError("");
    try { onSaved(await post<Setup>(`tenants/${s.id}/pack`, { pack: key })); notify({ id: "tenant-pack", tone: "success", title: "Industry set", message: "Its words, roles and starter processes are in the company.", timeout: 3500 }); }
    catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <Panel title="Industry" sub={chosen ? `${packs?.find((p) => p.key === chosen)?.name ?? chosen}: its words, roles, starter processes and record types are in the company` : "Pick the closest; the company changes any of it later in Settings → Industry & roles"}>
    {!packs ? <p className={css.note} style={{ paddingTop: 12 }}>Loading…</p> : <ul className={css.toggles} aria-label="Industry packs">{packs.map((p) => <li key={p.key}><span><b>{p.name}</b><small>{p.examples}. {p.summary}</small></span>
      {chosen === p.key ? <Badge tone="success">Chosen</Badge> : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={locked || !!busy || !s.org} onClick={() => void pick(p.key)}>{busy === p.key ? "Adding…" : "Use this"}</button>}</li>)}</ul>}
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
  </Panel>;
}

function SettingsStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [mods, setMods] = useState(s.modules ?? { tasks: true, chats: true, finance: true, attendance: false });
  const initialRules = () => Object.fromEntries(Object.entries(RULE_OPTIONS).flatMap(([role, actions]) => Object.entries(actions).map(([action, opts]) => [`${role}:${action}`, s.rules?.find((r) => r.role === role && r.action === action)?.scope ?? opts[0]])));
  const [rules, setRules] = useState<Record<string, string>>(initialRules), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try { onSaved(await post<Setup>(`tenants/${s.id}/settings`, { modules: mods, rules: Object.entries(rules).map(([k, scope]) => { const [role, action] = k.split(":"); return { role, action, scope }; }) })); notify({ id: "tenant-settings", tone: "success", title: "Modules and rules saved", timeout: 2500 }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <IndustryStep s={s} locked={locked} onSaved={onSaved} />
    <Panel title="Modules" sub="What this company uses">
      <ul className={css.toggles}>{MODULES.map((m) => <li key={m.key}><span><b>{m.label}</b><small>{m.hint}</small></span>
        <label className={css.check}><input type="checkbox" role="switch" checked={mods[m.key]} disabled={locked} onChange={(e) => setMods({ ...mods, [m.key]: e.target.checked })} aria-label={`${m.label} ${mods[m.key] ? "on" : "off"}`} />{mods[m.key] ? "On" : "Off"}</label></li>)}</ul>
      <p className={styles.panelFoot}>A module that is off leaves the navigation and its pages answer that it is off. The company&apos;s admins can change this later in Settings → Organisation.</p>
    </Panel>
    <Panel title="Who can do what" sub="Who may give work to whom. The company can change these later in Settings.">
      <div className={css.tableWrap}><table className={css.table}><thead><tr><th>Rule</th>{RULE_ROLES.filter((r) => r.key !== "leadership").map((r) => <th key={r.key}>{r.label}</th>)}<th>Leadership & admins</th></tr></thead>
        <tbody>{Object.keys(RULE_LABEL).map((action) => <tr key={action}><td><b>{RULE_LABEL[action]}</b></td>
          {(["hr", "pod_head", "member"] as const).map((role) => <td key={role}><SelectField className={css.cellInput} value={rules[`${role}:${action}`]} disabled={locked} aria-label={`${RULE_LABEL[action]}: ${role}`}
            onChange={(e) => setRules({ ...rules, [`${role}:${action}`]: e.target.value })}>{RULE_OPTIONS[role][action].map((o, i) => <option key={o} value={o}>{SCOPE[action as keyof typeof SCOPE][o]}{i === 0 ? " (default)" : ""}</option>)}</SelectField></td>)}
          <td><span className={styles.muted}><Lock size={11} aria-hidden="true" /> {SCOPE[action as keyof typeof SCOPE].anyone}</span></td></tr>)}</tbody></table></div>
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      {locked ? null : <div className={css.actions} style={{ paddingTop: 12 }}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save modules and rules"}</button></div>}
    </Panel>
  </>;
}

const ICON: Record<string, ReactNode> = { done: <Check size={12} aria-hidden="true" />, blocked: <AlertTriangle size={12} aria-hidden="true" />, todo: null, owner: <UserRound size={12} aria-hidden="true" />, info: <Info size={12} aria-hidden="true" /> };
const STATE_LABEL: Record<string, string> = { done: "Done", blocked: "Blocked", todo: "To do", owner: "Owner errand", info: "For information" };
function OpenStep({ s, onSaved }: { s: Setup; onSaved: (n?: Setup) => void }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [result, setResult] = useState<{ tables: number; leaks: { table: string; rows: number }[] } | null>(null);
  const origin = s.org?.host ? `${/\.localhost$/.test(s.org.host) ? "http" : "https"}://${s.org.host}` : "";
  async function check() { setBusy("check"); setError(""); try { const r = await post<{ tables: number; leaks: { table: string; rows: number }[]; setup: Setup }>(`tenants/${s.id}/check`); setResult(r); onSaved(r.setup); } catch (e) { setError(message(e)); } finally { setBusy(""); } }
  async function open() { setBusy("open"); setError(""); try { onSaved(await post<Setup>(`tenants/${s.id}/open`)); notify({ id: "tenant-open", tone: "success", title: `${s.org?.name} is open`, message: `Its people sign in at ${s.org?.host}`, timeout: 5000 }); } catch (e) { setError(message(e)); } finally { setBusy(""); } }
  return <>
    <Panel title="Checklist" sub={s.status === "open" || s.status === "live" ? <Badge tone="success">Open</Badge> : s.checklist.canOpen ? <Badge tone="success">Ready to open</Badge> : <Badge tone="warning">{s.checklist.blocked.length} blocking</Badge>}>
      <ul className={css.items}>{s.checklist.items.map((i) => <li key={i.key}><span className={css.state} data-state={i.state} title={STATE_LABEL[i.state]}>{ICON[i.state]}</span>
        <span><b>{i.label}</b>{i.blocking && i.state !== "done" ? <> <Badge tone="danger">Blocks opening</Badge></> : null}{i.state === "owner" ? <> <Badge tone="warning">Owner</Badge></> : null}<small>{i.detail}</small></span></li>)}</ul>
    </Panel>
    <Panel title="Isolation check" sub="Reads every company table as the new company">
      <p className={css.note} style={{ paddingTop: 12 }}>Pulse reads each of its company tables as {s.org?.name}, the way its people&apos;s requests are served, and counts anything that belongs to another company. It must find nothing. Read only; nothing is changed.</p>
      {result ? result.leaks.length ? <Problems items={result.leaks.map((l) => `${l.table}: ${l.rows} rows from another company`)} /> : <p className={css.banner} data-tone="success" style={{ margin: "0 14px 12px" }}><ShieldCheck size={16} aria-hidden="true" /><span>{result.tables} tables read: nothing from another company.</span></p> : null}
      {s.status === "open" || s.status === "live" ? null : <div className={css.actions}><button type="button" className={styles.btn} disabled={!!busy} onClick={() => void check()}><ShieldCheck size={14} aria-hidden="true" />{busy === "check" ? "Checking…" : "Run the isolation check"}</button></div>}
    </Panel>
    <Panel title="Open for sign-in">
      {s.status === "open" || s.status === "live" ? <p className={css.note} style={{ paddingTop: 12 }}>Open. {s.org?.name}&apos;s {s.activation?.company.activation === "trial" ? "admins, HR and leadership" : "people"} sign in at <a href={origin}>{origin}</a>. Its own admins run it from now on; <Link href={`/companies/${s.id}?step=activate`}>Hand over and activate</Link> shows its checklist.</p>
        : <><p className={css.note} style={{ paddingTop: 12 }}>Opening starts its trial: its admins, HR and leadership can sign in at {origin || "the company's address"}; everyone else waits until you activate it for staff under Hand over and activate.</p>
          {s.checklist.blocked.length ? <Problems items={s.checklist.blocked.map((b) => `Still to do: ${b}`)} tone="warning" /> : null}
          {error ? <p role="alert" className={css.error}>{error}</p> : null}
          <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!s.checklist.canOpen || !!busy} onClick={() => void open()}>{busy === "open" ? "Opening…" : `Open ${s.org?.name ?? "the company"} for sign-in`}</button></div></>}
    </Panel>
  </>;
}

const BLANK_SOURCE = { key: "", label: "", kind: "csv", connector: "", categories: [] as string[], grants: "admin" };
const CATEGORY_LABEL: Record<string, string> = { people: "People", structure: "Pods and roles", projects: "Projects", clients: "Clients", tasks: "Tasks", documents: "Documents",
  finance: "Finance", attendance_history: "Attendance history", payroll: "Payroll", chat_history: "Chat history" };
/** R53: the company's source registry: which sources it uses, who grants each, which data categories they bring. */
function SourcesStep({ s, locked, onSaved }: { s: Setup; locked: boolean; onSaved: (n?: Setup) => void }) {
  const [f, setF] = useState(BLANK_SOURCE), [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const sources = s.activation?.sources ?? [];
  const change = (patch: Partial<typeof BLANK_SOURCE>) => { setPlan(null); setF({ ...f, ...patch }); };
  const toggle = (cat: string) => change({ categories: f.categories.includes(cat) ? f.categories.filter((c) => c !== cat) : [...f.categories, cat] });
  async function run(apply: boolean) {
    setBusy(apply ? "apply" : "check"); setError("");
    try {
      const source = { key: f.key.trim().toLowerCase(), label: f.label, kind: f.kind, categories: f.categories, grants: f.grants, ...(f.kind === "plugin" ? { connector: f.connector.trim().toLowerCase() } : {}) };
      const r = await post<{ plan: Plan; setup?: Setup }>(`tenants/${s.id}/plan`, { spec: { sources: [source] }, apply });
      setPlan(r.plan);
      if (r.setup) { onSaved(r.setup); setF(BLANK_SOURCE); notify({ id: "tenant-source", tone: "success", title: "Source registered", message: source.label, timeout: 2500 }); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <>
    <Panel title="Source registry" sub={`${plural(sources.length, "source")}`}>
      <p className={css.note} style={{ paddingTop: 12 }}>Which sources {s.org?.name ?? "the company"} uses and who at the company grants each. Nothing is read from a source here: a connector reads only after the company&apos;s own admin installs and grants it (Settings → Connected sources), and a file or hand-kept source counts once its admin approves it. Payroll, attendance history and chat history need that admin&apos;s specific approval.</p>
      {sources.length ? <div className={css.tableWrap}><table className={css.table}><thead><tr><th>Source</th><th>Kind</th><th>Brings</th><th>Granted by</th><th>Rights</th></tr></thead>
        <tbody>{sources.map((x) => <tr key={x.key}><td><b>{x.label}</b><small className={css.mono}>{x.key}</small></td><td>{SOURCE_KINDS.find((k) => k.key === x.kind)?.label ?? x.kind}{x.connector && x.kind === "plugin" ? <small>{x.connector}</small> : null}</td>
          <td>{x.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ") || "—"}{x.sensitive.length ? <small>Specific approval: {x.sensitive.map((c) => CATEGORY_LABEL[c]).join(", ")}</small> : null}</td>
          <td>{x.grants}</td><td>{x.ready ? <Badge tone="success">Ready</Badge> : x.decision === "declined" ? <Badge>Not used</Badge> : <Badge tone="warning">Not yet</Badge>}<small>{x.why}</small></td></tr>)}</tbody></table></div>
        : <p className={css.note}>No source registered yet. Activation waits until the company&apos;s sources are registered and granted.</p>}
    </Panel>
    {locked ? <Panel title="Add a source"><p className={css.note} style={{ paddingTop: 12 }}>Open: {s.org?.name}&apos;s own admins register and approve sources in their Settings → Organisation → Setup.</p></Panel> :
    <Panel title="Add a source" sub="Previewed before it is written">
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void run(false); }}>
        <label className={styles.field}>Name<input value={f.label} onChange={(e) => change({ label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) })} maxLength={80} placeholder="e.g. People list" /></label>
        <label className={styles.field}>Key<input value={f.key} onChange={(e) => change({ key: e.target.value })} maxLength={40} spellCheck={false} placeholder="people-csv" /><small className={styles.muted}>Lowercase; a rerun with the same key updates it</small></label>
        <label className={styles.field}>Kind<SelectField value={f.kind} onChange={(e) => change({ kind: e.target.value })}>{SOURCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</SelectField></label>
        {f.kind === "plugin" ? <label className={styles.field}>Connector key<input value={f.connector} onChange={(e) => change({ connector: e.target.value })} maxLength={40} spellCheck={false} placeholder="acme-sync" /><small className={styles.muted}>The key in the plugin&apos;s connector.v1 manifest</small></label> : null}
        <label className={styles.field}>Granted by<SelectField value={f.grants} onChange={(e) => change({ grants: e.target.value })}>{["admin", "hr", "finance", "leadership"].map((g) => <option key={g} value={g}>{ACCESS_LABEL[g] ?? g}</option>)}</SelectField></label>
        <fieldset className={`${css.wide} ${css.catsField}`}><legend>Brings</legend><span className={css.cats}>{CATEGORIES.map((c) => <label key={c}><input type="checkbox" checked={f.categories.includes(c)} onChange={() => toggle(c)} />{CATEGORY_LABEL[c]}{(SENSITIVE as readonly string[]).includes(c) ? " *" : ""}</label>)}</span>
          <small className={styles.muted}>* Needs the company admin&apos;s specific approval; never brought in by default.</small></fieldset>
      </form>
      {plan ? <><Problems items={plan.problems} />{plan.ok ? <PlanTable plan={plan} areas={["sources"]} /> : null}</> : null}
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      <div className={css.actions}>
        <button type="button" className={styles.btn} disabled={!f.label || !!busy} onClick={() => void run(false)}>{busy === "check" ? "Checking…" : "Check first"}</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!plan?.ok || plan.applied || !!busy} onClick={() => void run(true)}>{busy === "apply" ? "Saving…" : "Add to the registry"}</button>
      </div>
    </Panel>}
  </>;
}

/** R53: the handover the operator records, the checklist every party follows, and activation for staff. */
function ActivateStep({ s, onSaved }: { s: Setup; onSaved: (n?: Setup) => void }) {
  const a = s.activation; const h = a?.handover;
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ operatorId: a?.operator ?? "", support: h?.supportRoute ?? "", on: h?.restore?.on ?? "", minutes: h?.restore?.minutes ? String(h.restore.minutes) : "",
    result: h?.restore?.result ?? "passed", isolated: h?.restore?.isolated ?? false, ref: h?.restore?.ref ?? "", termsRef: h?.termsRef ?? "", rolloutRef: h?.rolloutRef ?? "" });
  const [busy, setBusy] = useState(""), [error, setError] = useState<{ at: "handover" | "activate"; text: string } | null>(null), [confirm, setConfirm] = useState(false);
  if (!a || !s.org) return <Panel title="Hand over and activate"><p className={css.note} style={{ paddingTop: 12 }}>Create the company first.</p></Panel>;
  const open = s.org.status === "active", live = a.company.activation === "live";
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  async function save() {
    setBusy("save"); setError(null);
    try {
      onSaved(await post<Setup>(`tenants/${s.id}/handover`, { operatorId: f.operatorId || null, support: f.support || null,
        ...(f.on ? { restore: { on: f.on, minutes: Number(f.minutes), result: f.result, isolated: f.isolated, ref: f.ref } } : {}),
        ...(s.org?.rehearsal ? {} : { termsRef: f.termsRef || null, rolloutRef: f.rolloutRef || null }) }));
      notify({ id: "tenant-handover", tone: "success", title: "Handover saved", timeout: 2500 });
    } catch (e) { setError({ at: "handover", text: message(e) }); } finally { setBusy(""); }
  }
  async function isolation() { setBusy("check"); setError(null); try { onSaved((await post<{ setup: Setup }>(`tenants/${s.id}/check`)).setup); } catch (e) { setError({ at: "handover", text: message(e) }); } finally { setBusy(""); } }
  async function activate() {
    setBusy("activate"); setError(null);
    try { onSaved(await post<Setup>(`tenants/${s.id}/activate`, { confirmed: true })); notify({ id: "tenant-live", tone: "success", title: `${s.org?.name} is live for staff`, message: "Its HR invites people from now on", timeout: 5000 }); }
    catch (e) { setError({ at: "activate", text: message(e) }); } finally { setBusy(""); }
  }
  return <>
    {a.readiness ? <ReadinessNote r={a.readiness} /> : null}
    <Panel title="Checklist" sub={<GateLine blocked={a.blocked} live={live} open={open} />}>
      <p className={css.note} style={{ paddingTop: 12 }}>Who does each step, whether Pulse does it or a person does, and what still blocks activation. {s.org.name}&apos;s own admins see the same list in their Settings → Organisation → Setup; during the trial they record the pilot&apos;s device checks and HR&apos;s walkthrough there.</p>
      <GuideList steps={a.guide} />
    </Panel>
    <Panel title="Handover" sub="Recorded by you; its admins see the support route and the drill's result, not who you are">
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className={styles.field}>Responsible operator<SelectField value={f.operatorId} onChange={set("operatorId")}><option value="">Nobody named yet</option>{a.operators.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</SelectField><small className={styles.muted}>An admin of this install&apos;s own company (owner errand E19)</small></label>
        <label className={styles.field}>Support route<input value={f.support} onChange={set("support")} maxLength={200} placeholder="e.g. Pulse Help → Support, weekdays 10–6" /><small className={styles.muted}>Where its people ask for help and raise a grievance</small></label>
        <label className={styles.field}>Restore drill on<DateField value={f.on} max={today} onChange={(e) => setF({ ...f, on: e.target.value })} /></label>
        <label className={styles.field}>Minutes to restore<input inputMode="numeric" value={f.minutes} onChange={set("minutes")} placeholder="e.g. 42" /></label>
        <label className={styles.field}>Result<SelectField value={f.result} onChange={set("result")}><option value="passed">Passed</option><option value="failed">Failed</option></SelectField></label>
        <label className={styles.field}>Receipt<input value={f.ref} onChange={set("ref")} maxLength={200} placeholder="Where the drill's receipt is kept" /></label>
        <label className={`${css.check} ${css.wide}`}><input type="checkbox" checked={f.isolated} onChange={set("isolated")} /><span>Restored into an isolated target that cannot write to production</span></label>
        {s.org.rehearsal ? null : <>
          <label className={styles.field}>Privacy and processor terms<input value={f.termsRef} onChange={set("termsRef")} maxLength={200} placeholder="Reference to the approved terms (E08)" /></label>
          <label className={styles.field}>Owner&apos;s rollout instruction<input value={f.rolloutRef} onChange={set("rolloutRef")} maxLength={200} placeholder="Reference to the owner's instruction (E18)" /></label></>}
      </form>
      <p className={styles.panelFoot}>Pulse records what you enter and who entered it; it does not run the drill. A drill counts for 90 days and only when it passed into an isolated target. No password, key or e-mail address belongs here.</p>
      {error?.at === "handover" ? <p role="alert" className={css.error}>{error.text}</p> : null}
      <div className={css.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save handover"}</button>
        <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void isolation()}><ShieldCheck size={14} aria-hidden="true" />{busy === "check" ? "Checking…" : "Run the isolation check again"}</button>
      </div>
    </Panel>
    <Panel title="Activate for staff" sub={live ? <Badge tone="success">Live</Badge> : undefined}>
      {live ? <p className={css.note} style={{ paddingTop: 12 }}>Live since {a.handover.activatedAt?.slice(0, 10) ?? "before this checklist"}. Its HR invites people; each installs the same Pulse app and pairs it. Real invitations go out only on the owner&apos;s instruction.</p>
        : <><p className={css.note} style={{ paddingTop: 12 }}>{open ? "Activation lets everyone the company invites sign in. Pulse checks every gate again when you press it; nothing is sent." : "Open the company for sign-in first: its admin proves control and turns on two-step verification there."}</p>
          {a.blocked.length ? <Problems items={a.blocked.map((b) => `Still open: ${b}`)} tone="warning" /> : null}
          <div className={css.actions}>
            <label className={css.check}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={!open || !a.ready} /><span>{s.org.rehearsal ? "Rehearsal: synthetic staff may sign in" : "The owner has instructed this rollout"}</span></label>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!open || !a.ready || !confirm || !!busy} onClick={() => void activate()}><Rocket size={14} aria-hidden="true" />{busy === "activate" ? "Activating…" : `Activate ${s.org.name} for staff`}</button>
          </div>
          {error?.at === "activate" ? <p role="alert" className={css.error}>{error.text}</p> : null}</>}
    </Panel>
  </>;
}
