"use client";
// The first-run wizard. Phone-first: one step on the screen, big fields, the step's own Save at the bottom, "Later"
// always allowed. Every step saves as soon as it is confirmed, so closing the app loses nothing.
// Government IDs: the person types the number once; the API keeps only the masked form (XXXX XXXX 1234) and the
// uploaded file is encrypted. People are asked to upload UIDAI's masked Aadhaar.
import { ArrowLeft, Bell, Briefcase, Camera, Check, FileUp, Fingerprint, Landmark, MapPin, Phone, ScrollText, ShieldAlert, ShieldCheck, Smartphone, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { pipSvg } from "@pulse/companion";
import { ImagePicker } from "../image-crop";
import { BankForm, type BankInput } from "../people/bank-form";
import { post } from "../records";
import { shell } from "../lib/native-shell";
import { qrSvg } from "../lib/qr.mjs";
import { styles } from "../ui";
import type { DocKind, OnboardingState, Proposal } from "./types";
import { FILES_PAUSED, missingText } from "./types";
import css from "./welcome.module.css";
import { DateField } from "../kit/date-field";

type Install = { platform: string; label: string; href: string };
type StepKey = "welcome" | "details" | "work" | "bank" | "documents" | "app" | "notifications" | "consent" | "notice" | "done";
const STEPS: { key: StepKey; title: string; icon: typeof UserRound }[] = [
  { key: "welcome", title: "Welcome", icon: UserRound }, { key: "details", title: "Your details", icon: Phone }, { key: "work", title: "Your work", icon: Briefcase }, { key: "bank", title: "Bank for salary", icon: Landmark },
  { key: "documents", title: "Documents", icon: Fingerprint }, { key: "app", title: "Get the app", icon: Smartphone }, { key: "notifications", title: "Notifications", icon: Bell },
  { key: "consent", title: "Office arrival", icon: MapPin }, { key: "notice", title: "Staff notice", icon: ScrollText }, { key: "done", title: "All set", icon: Check },
];
const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const never = () => () => {};
/** In the Pulse phone app (read after hydration, so the server's page and the first client render agree). */
const useInApp = () => useSyncExternalStore(never, () => !!shell(), () => false);
const readFile = (file: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, "")); r.onerror = () => no(new Error("Could not read the file")); r.readAsDataURL(file); });

/** ONBOARD-GATE: the server's answer while Pulse is closed until the profile is complete. */
type Gate = { blocked: boolean; canSkip?: boolean; missing?: string[] } | null;
/** The steps that must be done before Pulse opens (the rest stay in the full first run, reachable later). */
const GATED: StepKey[] = ["welcome", "details", "work", "bank", "documents", "done"];
const GATE_VISIT = "pulse.profile-gate-visit";

export function Wizard({ initial, step: asked, autoAllowed, offices, attendance, checkedIn, installs, origin, gate = null }: {
  initial: OnboardingState; step: string | null; autoAllowed: boolean; offices: number; attendance: boolean; checkedIn: boolean; installs: Install[]; origin: string; gate?: Gate;
}) {
  const router = useRouter();
  const inApp = useInApp();
  const s = initial;
  // ONBOARD-GATE: while Pulse is closed, only what it needs, and no "Later" on those steps.
  // Kept for the whole visit: the last save opens Pulse (the gate lifts) and the person still sees "You're all set".
  // The page remounts when the gate lifts (the shell comes back), so the visit is remembered in this tab until Open Pulse.
  const [gated] = useState(() => {
    const now = !!gate?.blocked && s.self;
    try { if (now) sessionStorage.setItem(GATE_VISIT, "1"); return now || (s.self && sessionStorage.getItem(GATE_VISIT) === "1"); } catch { return now; }
  });
  const leave = () => { try { sessionStorage.removeItem(GATE_VISIT); } catch { /* private mode */ } router.replace("/"); router.refresh(); };
  const steps = STEPS.filter((x) => x.key !== "notice" || s.notice).filter((x) => s.self || !["app", "notifications", "consent", "notice"].includes(x.key))
    .filter((x) => !gated || GATED.includes(x.key));
  const firstOpen = steps.find((x) => x.key !== "welcome" && x.key !== "done" && !s.steps[x.key])?.key;
  const [current, setCurrent] = useState<StepKey>((steps.find((x) => x.key === asked)?.key) ?? (s.steps.welcome ? firstOpen ?? "done" : "welcome"));
  const [busy, setBusy] = useState(false);
  const index = steps.findIndex((x) => x.key === current);
  const go = (key: StepKey) => { setCurrent(key); window.scrollTo({ top: 0 }); document.querySelector("main")?.scrollTo?.({ top: 0 }); };
  const next = () => go(steps[Math.min(index + 1, steps.length - 1)].key);
  const base = `onboarding/${s.person.id}`;
  /** Save a step's data (optional) and mark the step, then move on. */
  async function save(work: (() => Promise<unknown>) | null, state: "done" | "later" = "done") {
    setBusy(true);
    try {
      if (work) await work();
      if (current !== "done") await post(`${base}/step`, { step: current, state });
      router.refresh(); next();
    } catch (e) { notify({ id: "welcome", tone: "error", title: "Not saved", message: message(e) }); }
    finally { setBusy(false); }
  }
  const optional = <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => void save(null, "later")}>Later</button>;
  const later = gated ? null : optional;
  const complete = s.missing.length === 0 || (gated && !gate?.missing?.length);
  /** The owner's "Finish later" (seven days); Pulse opens straight away. */
  async function skip() {
    setBusy(true);
    try { await post("onboarding/gate/skip", {}); leave(); }
    catch (e) { notify({ id: "welcome", tone: "error", title: "Not saved", message: message(e) }); setBusy(false); }
  }
  async function signOut() { await post("auth/sign-out", {}).catch(() => {}); router.replace("/login"); router.refresh(); }

  return (
    <div className={css.wrap}>
      <header className={css.top}>
        {index > 0 ? <button type="button" className={css.back} onClick={() => go(steps[index - 1].key)} aria-label="Back"><ArrowLeft size={18} aria-hidden="true" /></button> : <span />}
        <div className={css.progress} aria-label={`Step ${index + 1} of ${steps.length}`}><i style={{ width: `${Math.round(((index + 1) / steps.length) * 100)}%` }} /></div>
        <span className={css.count}>{index + 1}/{steps.length}</span>
      </header>
      {gated ? <p className={css.gateBar}><span>Set up your profile to open Pulse. Everything saves as you go.</span>
        {gate?.canSkip ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void skip()}>Finish later</button>
          : <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void signOut()}>Sign out</button>}</p> : null}
      {!s.self ? <p className={css.helping}>You are filling this in for <b>{s.person.name}</b>. They can see and change it, and it is logged.</p> : null}

      {current === "welcome" ? <Step title={`Welcome to Pulse, ${s.person.firstName}`} lead={<span className={css.pip} aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: "waking", size: 64, uid: "welcome", still: true }) }} />}
        foot={<button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={() => void save(null)}>{gated ? "Set up my profile · about 5 minutes" : "Start · about 3 minutes"}</button>}>
        {gated ? <ul className={css.points}>
          <li><b>A few things before you start.</b> Your names and photo, WhatsApp and address, an emergency contact, your role and skills, your bank for salary, Aadhaar and PAN.</li>
          <li><b>It saves as you go.</b> Close the app and come back; you continue where you left off.</li>
          <li><b>Your details stay private.</b> Only you and HR see them. Aadhaar and PAN are kept masked, bank details and files are encrypted, and every look is logged.</li>
        </ul> : <ul className={css.points}>
          <li><b>Check in when you arrive, check out when you leave.</b> Payroll and salary are worked out from it, so it matters every day.</li>
          <li><b>One tap.</b> The button is at the top of Pulse, in the phone app and on your computer. It works offline and syncs later.</li>
          <li><b>Your details stay private.</b> Only you and HR see them. ID numbers are kept masked; files are encrypted; every look is logged.</li>
        </ul>}
        {s.percent > 0 ? <p className={css.note}>Already {s.percent}% done. Still to add: {missingText(s) || "nothing"}.</p> : null}
      </Step> : null}

      {current === "details" ? <Details s={s} busy={busy} onSave={(data) => save(() => post(`${base}/details`, data))} later={later} /> : null}
      {current === "work" ? <Work s={s} busy={busy} onSave={(data) => save(() => post(`${base}/work`, data))} later={later} /> : null}
      {current === "bank" ? <Bank s={s} busy={busy} onSave={async (data) => { await post(`${base}/bank`, data); await save(null); }} later={later} onKeep={() => void save(null)} /> : null}
      {current === "documents" ? <Documents s={s} base={base} busy={busy} onDone={() => void save(null)} later={later} /> : null}

      {current === "app" ? <Step title="Get the Pulse app" sub="Check in with one tap from your phone or computer."
        foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={() => void save(null)}>{inApp ? "Done" : "I have installed it"}</button>{optional}</>}>
        {inApp ? <p className={css.ok}><Check size={16} aria-hidden="true" /> You are using the Pulse app on this phone.</p> : null}
        {installs.length ? <ul className={css.installs}>{installs.map((i) => <li key={i.platform}><a href={i.href} target="_blank" rel="noreferrer" className={styles.btn}>{i.label}</a>{s.apps?.[i.platform === "android" ? "phone" : i.platform === "chrome" ? "chrome" : "desktop"] ? <small><Check size={12} aria-hidden="true" /> installed</small> : null}</li>)}</ul>
          : <p className={css.note}>The install links are in Settings → Devices → Get the apps.</p>}
        {!inApp && installs.some((i) => i.platform === "android") ? <figure className={css.qr}>
          <span dangerouslySetInnerHTML={{ __html: qrSvg(`${origin}/apps/android`, 168, "Scan to install the Pulse phone app") }} />
          <figcaption>On a computer? Scan this with your phone’s camera to install the phone app.</figcaption>
        </figure> : null}
      </Step> : null}

      {current === "notifications" ? <Notifications busy={busy} onDone={() => void save(null)} later={optional} /> : null}
      {current === "consent" ? <Consent s={s} autoAllowed={autoAllowed} offices={offices} busy={busy} onSave={(given, auto) => save(async () => {
        await post("onboarding/consent", { given, auto });
        await shell()?.presencePreferences({ enabled: given }).catch(() => {});
        // In the phone app, location "while using" lets Pulse recognise the office Wi-Fi (asked on this tap only).
        if (given) await shell()?.requestPermissions({ permissions: ["location"] }).catch(() => {});
      })} later={optional} /> : null}
      {current === "notice" && s.notice ? <Step title={s.notice.title} sub={`Version ${s.notice.version}. Please read it before work-activity features are ever turned on.`}
        foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy || !!s.notice.readAt} onClick={() => void save(() => post("onboarding/notice", { noticeId: s.notice!.id }))}>{s.notice.readAt ? "Signed" : "I have read it and sign"}</button>{optional}</>}>
        <p>{s.notice.summary ?? "HR has published the staff notice. Open it in My desk → Policies to read it in full."}</p>
        <p className={css.note}><Link href="/me?tab=policies">Open the full notice</Link>. Signing records that you read it; it does not turn anything on.</p>
      </Step> : null}

      {current === "done" ? <Step title={complete ? "You’re all set" : "Nearly there"} lead={<span className={css.pip} aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: complete ? "celebrate" : "in", size: 64, uid: "done", still: true }) }} />}
        sub={complete ? "Your profile is complete. HR has what payroll needs." : gated ? `Still to add: ${missingText(s)}. Pulse opens as soon as these are in.` : `Still to add: ${missingText(s)}. Pulse will remind you; HR can help.`}
        foot={gated || (gate && complete) ? (complete ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} onClick={leave}>Open Pulse</button> : null)
          : attendance && !checkedIn ? <Link href="/me" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`}>Check in now</Link> : <Link href="/me" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`}>Open My desk</Link>}>
        <ol className={css.summary}>{steps.filter((x) => x.key !== "welcome" && x.key !== "done").map((x) => { const st = s.steps[x.key]?.state; const Icon = x.icon;
          return <li key={x.key} data-state={st ?? "open"}><Icon size={15} aria-hidden="true" /><span>{x.title}</span><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => go(x.key)}>{st === "done" ? "Change" : "Add"}</button></li>; })}</ol>
      </Step> : null}
    </div>
  );
}

function Step({ title, sub, lead, children, foot }: { title: string; sub?: ReactNode; lead?: ReactNode; children?: ReactNode; foot: ReactNode }) {
  return (
    <section className={css.step} aria-label={title}>
      {lead}
      <h2 className={css.title}>{title}</h2>
      {sub ? <p className={css.sub}>{sub}</p> : null}
      <div className={css.body}>{children}</div>
      <div className={css.foot}>{foot}</div>
    </section>
  );
}

/** A proposal from Pulse's agents: the value, where it came from, and the person's yes or no. */
function Suggestion({ p, onUse }: { p: Proposal; onUse?: (value: string) => void }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function decide(accept: boolean) {
    setBusy(true);
    try { await post(`onboarding/proposals/${p.id}`, { accept }); if (accept && p.value) onUse?.(p.value); router.refresh(); }
    catch (e) { notify({ id: "proposal", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  return <span className={css.suggest}>
    <span>{p.value ? <><b>{p.value}</b> · </> : null}from {p.sourceLabel}</span>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void decide(true)}>{p.field === "document" ? "Yes, that’s mine" : "Use this"}</button>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void decide(false)}>Not right</button>
  </span>;
}

function Field({ label, name, value, type = "text", hint, proposals, required, ...rest }: { label: string; name: string; value?: string | null; type?: string; hint?: string; proposals: Proposal[]; required?: boolean } & Record<string, unknown>) {
  const input = useRef<HTMLInputElement>(null);
  const mine = proposals.filter((p) => p.field === name);
  // UI-POLISH (R017): a date is the kit's DateField (dd MMM yyyy); a suggestion sets it by remounting with that day.
  const [day, setDay] = useState(value ?? "");
  if (type === "date") return <label className={css.field}><span>{label}{required ? null : <small> (optional)</small>}</span>
    <DateField key={day} name={name} defaultValue={day} required={required} />
    {hint ? <small>{hint}</small> : null}
    {mine.map((p) => <Suggestion key={p.id} p={p} onUse={(v) => setDay(v)} />)}
  </label>;
  return <label className={css.field}><span>{label}{required ? null : <small> (optional)</small>}</span>
    <input ref={input} name={name} type={type} defaultValue={value ?? ""} required={required} {...rest} />
    {hint ? <small>{hint}</small> : null}
    {mine.map((p) => <Suggestion key={p.id} p={p} onUse={(v) => { if (input.current) input.current.value = v; }} />)}
  </label>;
}

function Details({ s, busy, onSave, later }: { s: OnboardingState; busy: boolean; onSave: (data: Record<string, string>) => void; later: ReactNode }) {
  const d = s.details ?? {};
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSave(Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]))); };
  return <form onSubmit={submit}>
    <Step title="Your details" sub="For HR records and emergencies. Only you and HR can see them."
      foot={<><button className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy}>Save and continue</button>{later}</>}>
      {!s.canSeeDetails ? <p className={css.note}>You can add details for this person; only they and HR can read them back.</p> : null}
      <fieldset className={css.group}><legend>Your name</legend>
        <Field label="Full legal name" name="legalName" value={d.legalName ?? s.person.name} proposals={s.proposals} required autoComplete="name" hint="As on your PAN or Aadhaar." />
        <Field label="Preferred name" name="preferredName" value={d.preferredName ?? s.person.firstName} proposals={s.proposals} required autoComplete="nickname" hint="What colleagues call you." />
      </fieldset>
      <fieldset className={css.group}><legend>About you</legend>
        <Field label="Date of birth" name="dob" type="date" value={d.dob} proposals={s.proposals} required />
        <Field label="WhatsApp number" name="personalPhone" type="tel" value={d.personalPhone ?? s.person.workPhone} proposals={s.proposals} required inputMode="tel" autoComplete="tel" placeholder="+91 90000 12345" hint="An Indian mobile: 10 digits, +91 is added for you." />
        <Field label="Personal email" name="personalEmail" type="email" value={d.personalEmail} proposals={s.proposals} required autoComplete="email" />
        <Field label="Address" name="address" value={d.address} proposals={s.proposals} required autoComplete="street-address" />
        <div className={css.pair}><Field label="City" name="city" value={d.city} proposals={s.proposals} required autoComplete="address-level2" /><Field label="PIN code" name="pincode" value={d.pincode} proposals={s.proposals} inputMode="numeric" pattern="[0-9]{6}" /></div>
      </fieldset>
      <fieldset className={css.group}><legend>Emergency contact</legend>
        <Field label="Name" name="emergencyName" value={d.emergencyName} proposals={s.proposals} required />
        <div className={css.pair}><Field label="Relation" name="emergencyRelation" value={d.emergencyRelation} proposals={s.proposals} placeholder="Parent, spouse…" required />
          <Field label="Phone" name="emergencyPhone" type="tel" value={d.emergencyPhone} proposals={s.proposals} required inputMode="tel" placeholder="+91 90000 12345" /></div>
      </fieldset>
    </Step>
  </form>;
}

/** ONBOARD-GATE: role, pod/team and joining date as HR keeps them (confirm only; a note if something is off), and
 *  skills and tools as short tags. */
function Work({ s, busy, onSave, later }: { s: OnboardingState; busy: boolean; onSave: (data: Record<string, unknown>) => void; later: ReactNode }) {
  const [tags, setTags] = useState<string[]>(s.person.skills ?? []);
  const [draft, setDraft] = useState("");
  const split = (raw: string) => raw.split(",").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const add = (raw: string) => { const next = split(raw); if (next.length) setTags((t) => [...new Set([...t, ...next])].slice(0, 15)); setDraft(""); };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const all = [...new Set([...tags, ...split(draft)])].slice(0, 15);
    if (!all.length) { notify({ id: "welcome", tone: "error", title: "Add a skill", message: "Add at least one skill or tool you use." }); return; }
    onSave({ skills: all, confirm: true, note: String(new FormData(e.currentTarget).get("note") ?? "") });
  };
  const when = s.person.joinedOn ? new Date(`${s.person.joinedOn.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
  return <form onSubmit={submit}>
    <Step title="Your work" sub="HR filled these in. Check them and add what you are good at."
      foot={<><button className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy}>Confirm and continue</button>{later}</>}>
      <dl className={css.facts}>
        <div><dt>Role</dt><dd>{s.person.role || "Not set yet"}</dd></div>
        <div><dt>Pod / team</dt><dd>{s.person.pod || "Not set yet"}</dd></div>
        <div><dt>Joined</dt><dd>{when ?? "Not set yet"}</dd></div>
      </dl>
      <label className={css.field}><span>Something not right? <small>(optional)</small></span>
        <input name="note" defaultValue={s.details?.workNote ?? ""} maxLength={300} placeholder="Tell HR what to fix" /></label>
      <label className={css.field}><span>Skills and tools</span>
        <input value={draft} onChange={(e) => { if (e.target.value.endsWith(",")) add(e.target.value); else setDraft(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); add(draft); } }} placeholder="Canva, Excel, Cold calling" enterKeyHint="done" />
        <small>Type one and press Enter or a comma. Up to 15.</small></label>
      {tags.length ? <ul className={css.tags}>{tags.map((t) => <li key={t}>{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>×</button></li>)}</ul> : null}
    </Step>
  </form>;
}

function Bank({ s, busy, onSave, later, onKeep }: { s: OnboardingState; busy: boolean; onSave: (data: BankInput) => Promise<void>; later: ReactNode; onKeep: () => void }) {
  const [edit, setEdit] = useState(!s.bank);
  if (!edit) return <Step title="Bank for salary" sub="Saved and encrypted. Only the last four digits are shown."
    foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={onKeep}>Keep and continue</button><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setEdit(true)}>Change</button></>}>
    <p className={css.ok}><Landmark size={16} aria-hidden="true" /> {s.bank}</p>
  </Step>;
  // PEOPLE-CONTACTS: the same form as My info: the IFSC names the bank and branch, an optional UPI ID, HR checks it.
  return <Step title="Bank for salary" sub="Your salary is paid into this account. It is encrypted; HR checks it before payroll and opens the full number only to pay you." foot={later}>
    {s.filesReady === false ? <p className={styles.banner} role="status"><ShieldAlert size={14} aria-hidden="true" /><span>{FILES_PAUSED} You can add your bank details later.</span></p>
      : <BankForm holder={s.person.name} onSave={onSave} submitLabel="Save and continue" />}
  </Step>;
}

function Documents({ s, base, busy, onDone, later }: { s: OnboardingState; base: string; busy: boolean; onDone: () => void; later: ReactNode }) {
  const pending = s.documents.filter((d) => d.required && !d.document).length + (s.person.photo ? 0 : 1);
  return <Step title="Documents" sub="HR needs these for your employment record and statutory payroll (PF, ESI, TDS)."
    foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={onDone}>{pending ? "Continue" : "Done"}</button>{later}</>}>
    {s.filesReady === false ? <p className={styles.banner} role="status"><ShieldAlert size={14} aria-hidden="true" /><span>{FILES_PAUSED} You can add Aadhaar and PAN numbers now and the files later.</span></p> : null}
    <ul className={css.docs}>
      <PhotoCard personId={s.person.id} has={s.person.photo} />
      {s.documents.map((d) => <DocCard key={d.kind} d={d} base={base} files={s.filesReady !== false} proposals={s.proposals.filter((p) => p.field === "document" && p.documentKind === d.kind)} />)}
    </ul>
    <p className={css.note}><ShieldCheck size={13} aria-hidden="true" /> ID numbers are kept masked (last four digits). Files are encrypted. Only you and HR can open them, and every time they are opened it is logged on your HR record.</p>
  </Step>;
}

function PhotoCard({ personId, has }: { personId: string; has: boolean }) {
  const router = useRouter();
  // PEOPLE-CONTACTS: the same cropper as the profile (camera or gallery, then pinch, drag and turn).
  async function save(dataUrl: string) {
    try { await post(`people/${personId}/photo`, { dataUrl }); router.refresh(); }
    catch (e) { notify({ id: "photo", tone: "error", title: "The photo was not saved", message: message(e) }); throw e; }
  }
  return <li className={css.doc} data-done={has ? "" : undefined}>
    <span className={css.docHead}><b>Photo</b>{has ? <small><Check size={12} aria-hidden="true" /> Added</small> : <small>Needed</small>}</span>
    <small className={css.docHint}>A clear photo of your face. It is also your Pulse profile picture.</small>
    <ImagePicker label="your photo" has={has} variant="button" shapes={["circle"]} save={(r) => save(r.dataUrl)} onError={(m) => notify({ id: "photo", tone: "error", title: "The photo was not saved", message: m })}>
      <Camera size={14} aria-hidden="true" />{has ? "Change photo" : "Take or choose a photo"}</ImagePicker>
  </li>;
}

const STATUS: Record<string, string> = { on_file: "On file", verified: "Checked by HR", rejected: "HR asked for a new one" };
function DocCard({ d, base, files, proposals }: { d: DocKind; base: string; files: boolean; proposals: Proposal[] }) {
  const router = useRouter(); const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [chosen, setChosen] = useState<File | null>(null);
  const doc = d.document; const [editing, setEditing] = useState(false); const replace = !doc || doc.status === "rejected" || editing;
  const hint = d.idNumber === "aadhaar" ? "12 digits. Pulse keeps only the last four (XXXX XXXX 1234)." : d.idNumber === "pan" ? "Like ABCDE1234F. Pulse keeps only the last four." : null;
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const number = String(new FormData(e.currentTarget).get("number") ?? "").trim();
    try {
      if (chosen && chosen.size > 5 * 1024 * 1024) throw new Error("Choose a file up to 5 MB");
      if (!chosen && !number) throw new Error(d.idNumber ? files ? "Add the number, the file, or both" : "Add the number" : "Choose the file");
      const r = await post<{ masked: string | null }>(`${base}/documents`, { kind: d.kind, ...(number ? { number } : {}), ...(chosen ? { bytes: await readFile(chosen), mime: chosen.type, name: chosen.name } : {}) });
      notify({ id: `doc:${d.kind}`, tone: "success", title: `${d.label} saved`, message: r.masked ? `Kept as ${r.masked}` : undefined, timeout: 3000 });
      setChosen(null); setEditing(false); router.refresh();
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <li className={css.doc} data-done={doc && doc.status !== "rejected" ? "" : undefined}>
    <span className={css.docHead}><b>{d.label}</b>{doc ? <small data-tone={doc.status}>{doc.status === "rejected" ? null : <Check size={12} aria-hidden="true" />} {STATUS[doc.status]}{doc.source === "drive" ? " · in HR’s Drive" : ""}</small> : <small>{d.required ? "Needed" : "Optional"}</small>}</span>
    {doc?.masked ? <span className={css.masked}>{doc.masked}</span> : null}
    {doc?.status === "rejected" && doc.note ? <small className={css.docHint}>HR: {doc.note}</small> : null}
    {files && doc?.hasFile && doc.fileName ? <a className={css.docHint} href={`/api/v0/onboarding/documents/${doc.id}/file`} target="_blank" rel="noreferrer">Open {doc.fileName}</a> : null}
    {proposals.map((p) => <Suggestion key={p.id} p={p} />)}
    {!replace ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setEditing(true)}>Replace</button> : null}
    {replace && (files || d.idNumber) ? <form className={css.docForm} onSubmit={send}>
      {d.idNumber ? <label className={css.field}><span>{d.idNumber === "aadhaar" ? "Aadhaar number" : "PAN"}</span><input name="number" autoComplete="off" inputMode={d.idNumber === "aadhaar" ? "numeric" : "text"} autoCapitalize="characters" placeholder={doc?.masked ?? undefined} />{hint ? <small>{hint}</small> : null}</label> : null}
      <input ref={file} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden onChange={(e) => setChosen(e.target.files?.[0] ?? null)} />
      <span className={css.docActions}>
        {files ? <button type="button" className={styles.btn} onClick={() => file.current?.click()}><FileUp size={14} aria-hidden="true" />{chosen ? chosen.name : doc?.hasFile ? "Replace the file" : "Choose a PDF or photo"}</button> : null}
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </span>
      {d.idNumber === "aadhaar" ? <small className={css.docHint}>Upload the <a href="https://myaadhaar.uidai.gov.in/" target="_blank" rel="noreferrer">masked Aadhaar</a> from UIDAI if you can: it hides the first eight digits.</small> : null}
      {error ? <small role="alert" className={css.error}>{error}</small> : null}
    </form> : null}
  </li>;
}

function Notifications({ busy, onDone, later }: { busy: boolean; onDone: () => void; later: ReactNode }) {
  const permission = useSyncExternalStore(never, () => typeof Notification === "undefined" ? "unsupported" : Notification.permission, () => "default");
  const [asked, setAsked] = useState<string | null>(null);
  const state = asked ?? permission;
  const native = useInApp() ? shell() : null;
  async function ask() {
    if (native) { const r = await native.requestNotifications().catch(() => ({ state: "denied" as const })); setAsked(r.state); return; }
    if (typeof Notification === "undefined") return;
    window.dispatchEvent(new Event("pulse:enable-browser-pings"));
    const r = await Notification.requestPermission().catch(() => "denied" as NotificationPermission); setAsked(r);
  }
  return <Step title="Turn on notifications" sub="So Pulse can remind you to check in, ask “Check in?” when you reach the office, and tell you when HR decides."
    foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={onDone}>{state === "granted" ? "Continue" : "Continue without"}</button>{later}</>}>
    {state === "granted" ? <p className={css.ok}><Check size={16} aria-hidden="true" /> Notifications are on.</p>
      : state === "denied" ? <p className={css.note}>Notifications are blocked. Turn them on in your phone’s or browser’s settings for Pulse.</p>
      : state === "unsupported" && !native ? <p className={css.note}>This browser cannot show notifications. The Pulse app can.</p>
      : <button type="button" className={`${styles.btn} ${css.big}`} onClick={() => void ask()}><Bell size={16} aria-hidden="true" />Turn on notifications</button>}
    <p className={css.note}>Reminders are gentle: at most two a day for each kind, never during quiet hours, and you can snooze or switch them off in Notifications → Preferences.</p>
  </Step>;
}

function Consent({ s, autoAllowed, offices, busy, onSave, later }: { s: OnboardingState; autoAllowed: boolean; offices: number; busy: boolean; onSave: (given: boolean, auto: boolean) => void; later: ReactNode }) {
  const given = !!s.consent.at && !s.consent.withdrawnAt;
  const [on, setOn] = useState(given || !s.consent.at); const [auto, setAuto] = useState(!!s.consent.auto);
  return <Step title="Office arrival" sub={offices ? "Let Pulse notice when you reach the office, so checking in is one tap (or none)." : "When HR adds the office, Pulse can notice your arrival. You can decide now."}
    foot={<><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.wide}`} disabled={busy} onClick={() => onSave(on, on && auto)}>Save and continue</button>{later}</>}>
    <label className={css.toggle}><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /><span><b>Notice my arrival at the office</b><small>When your phone or laptop joins the office Wi-Fi or network, or your phone arrives at the office, Pulse asks “Check in?”.</small></span></label>
    {autoAllowed ? <label className={css.toggle} data-off={on ? undefined : ""}><input type="checkbox" checked={on && auto} disabled={!on} onChange={(e) => setAuto(e.target.checked)} /><span><b>Check me in automatically when Pulse is sure</b><small>Only when two signals agree for a few minutes. You see it in your day and can say “That’s not right”.</small></span></label> : null}
    <div className={css.privacy}>
      <b>What Pulse does and does not do</b>
      <ul>
        <li>It reads location or Wi-Fi only at those moments: arriving, leaving, or when you open Pulse. No tracking during the day and no location history.</li>
        <li>It keeps only which office and which kind of signal (office Wi-Fi, office network, phone at the office), never where you are.</li>
        <li>Check-out is never automatic. If you forget, Pulse reminds you and HR gets a correction to confirm, never a silent change.</li>
        <li>You can switch this off any time here or in Settings → Devices; it stops on every device at once.</li>
      </ul>
    </div>
  </Step>;
}
