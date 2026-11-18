"use client";
// FIX-PEOPLE-MONEY C1 (owner walkthrough, 10 Nov 2026: "There's both 'Add people' and 'Add member'. This is confusing."):
// ONE way to bring anyone in, in the shared side panel (kit Drawer: a right sheet on a computer, a bottom sheet on a phone,
// sticky actions). 1. Who are you adding? (Employee, Manager, CA / accountant, Partner, Client, Vendor, and for admins an
// AI employee), each saying in plain words what they will see, can do and won't see. 2. How do they join? A join link by
// e-mail, SMS or WhatsApp (CA-ACCESS), or, for an employee or manager, "No link: just add them" (the old Add member
// record form). The old Add member button and the separate /people/add page are gone; their links open this panel:
// /people?add=people | member | ai | ca | staff | manager | partner | client | vendor.
import { Bot, Briefcase, Calculator, Check, ChevronDown, Copy, Handshake, Link2Off, Mail, MessageCircle, MessageSquare, Truck, UserPlus, UserRound, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { FormField, post, type FieldDef } from "../../records";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit/drawer";
import { celebrate } from "../../kit/game";
import { PICKER, SEATS, type SeatKey } from "../../start/catalogue";
import { MODELS, TOOLS } from "../add-member";
import styles from "../../ui.module.css";
import css from "./add-flow.module.css";

type Who = SeatKey | "ai";
type Channel = "email" | "sms" | "whatsapp" | "none";
type Made = { email: string | null; name: string | null; seat: SeatKey; channel: Channel | "link"; status: string; mailed: boolean; hasAccount?: boolean; link: string | null; message?: string | null };
type Invite = { id: string; seat: SeatKey | null; kind: string; email: string | null; name: string | null; channel: string | null; caSalaries?: boolean; status: string; at: string; who: string | null; mailed: boolean };
type Option = { value: string; label: string };

const ICON: Record<Who, ReactNode> = { staff: <Briefcase size={18} />, manager: <Users size={18} />, accountant: <Calculator size={18} />, partner: <Handshake size={18} />, client: <UserRound size={18} />, vendor: <Truck size={18} />, ai: <Bot size={18} />,
  leadership: <Users size={18} />, sales: <Briefcase size={18} />, freelancer: <Briefcase size={18} /> } as Record<Who, ReactNode>;
const AI_SEAT = { label: "AI employee", line: "an AI helper", sees: ["The tasks and chats it is given", "What its manager shares with it"], does: ["Take tasks and send them for review", "Answer in its chats", "Keep notes of what it learns"], wont: ["Salaries, money or settings", "Anything its manager has not given it"] };
const CHANNELS: { key: Channel; label: string; icon: ReactNode }[] = [{ key: "email", label: "Email", icon: <Mail size={17} /> }, { key: "sms", label: "SMS", icon: <MessageSquare size={17} /> }, { key: "whatsapp", label: "WhatsApp", icon: <MessageCircle size={17} /> }, { key: "none", label: "No link", icon: <Link2Off size={17} /> }];
/** One short line under each choice, so every tile is one line on a phone. */
const SHORT: Partial<Record<Who, string>> = { staff: "a person on your team", manager: "runs a team", accountant: "checks books", partner: "co-owner", client: "sees work", vendor: "sends bills", ai: "does tasks for you" };
/** One short line per tool, for the four boxes (the long hint is the tooltip). */
const TOOL_LINE: Record<string, string> = { chats: "Answers in its chats", tasks: "Does the tasks it gets", memory: "Keeps notes it learns", board: "Posts big jobs on the team board" };
const STATUS: Record<string, string> = { open: "Waiting to join", accepted: "Joined", revoked: "Withdrawn", expired: "Link expired" };
const digits = (phone: string) => { const d = phone.replace(/\D/g, ""); return d.length === 10 ? `91${d}` : d; };
const seatOf = (k: Who | null) => k === "ai" ? { key: "ai" as const, ...AI_SEAT } : SEATS.find((s) => s.key === k);
const sentence = (list: string[]) => list.map((x, i) => i && /^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x).join(", ");
const shareUrl = (channel: Channel, to: string, message: string) => { const n = digits(to); return channel === "whatsapp" ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : `sms:+${n}?&body=${encodeURIComponent(message)}`; };

/** The team (pod) as a list rather than a row of chips, which wrapped one chip alone on a phone. */
const asList = (fields: FieldDef[]) => fields.map((f) => f.key === "pod" && f.type === "choice" ? { ...f, type: "select" as const } : f);

/** What `?add=` asks for: the person picked, and whether it opens on "No link" (the old Add member). */
export function addPreset(add: string | undefined): { who: Who; channel?: Channel; fixed?: boolean } | null {
  if (!add) return null;
  const k = add.toLowerCase();
  if (k === "ai") return { who: "ai", fixed: true };
  if (k === "member" || k === "record") return { who: "staff", channel: "none", fixed: true };
  if (k === "ca" || k === "accountant") return { who: "accountant", fixed: true };
  if (k === "employee" || k === "staff") return { who: "staff", fixed: true };
  if ((PICKER as string[]).includes(k)) return { who: k as SeatKey, fixed: true };
  return { who: "staff" };
}

/** Team's one "Add people" button and its panel. `admin` adds the AI employee; `record` (HR, leadership, admin: who
 *  the API lets add a person) adds "No link", a team record without a sign-in. */
export function AddPeopleButton({ admin, record, fields, owners, open: openAtStart }: { admin: boolean; record: boolean; fields: FieldDef[]; owners: Option[]; /** `?add=` from the address. */ open?: string }) {
  const router = useRouter();
  const preset = addPreset(openAtStart);
  const [open, setOpen] = useState(Boolean(preset));
  const close = () => {
    setOpen(false);
    // The address forgets ?add= so a refresh does not open the panel again.
    if (openAtStart && typeof window !== "undefined") { const u = new URL(window.location.href); u.searchParams.delete("add"); u.searchParams.delete("as"); router.replace(u.pathname + (u.search || ""), { scroll: false }); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><UserPlus size={15} aria-hidden="true" />Add people</button>
    {open ? <AddPeoplePanel admin={admin} record={record} fields={fields} owners={owners} preset={preset} onClose={close} /> : null}
  </>;
}

function AddPeoplePanel({ admin, record, fields, owners, preset, onClose }: { admin: boolean; record: boolean; fields: FieldDef[]; owners: Option[]; preset: { who: Who; channel?: Channel; fixed?: boolean } | null; onClose: () => void }) {
  const router = useRouter(), formId = useId(), saving = useRef(false);
  const choices: Who[] = admin ? [...PICKER, "ai"] : PICKER;
  const start = preset && choices.includes(preset.who) ? preset : null;
  const [who, setWho] = useState<Who>(start?.who ?? "staff");
  // Step 1 folds to one line ("Adding: Employee · Change") once a choice is made, so step 2 starts near the top.
  // Step 1 starts on one line ("Employee · Change"), the most common choice, so the first field is on screen; Change
  // shows all seven.
  const [chosen, setChosen] = useState(true);
  const [channel, setChannel] = useState<Channel>(start?.channel === "none" && record ? "none" : "email");
  const [salaries, setSalaries] = useState(false);
  const [to, setTo] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [made, setMade] = useState<Made | null>(null), [sentTo, setSentTo] = useState(""), [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [provider, setProvider] = useState("claude"), [tools, setTools] = useState<string[]>(["chats", "tasks", "memory"]);
  const [confirmAi, setConfirmAi] = useState<Record<string, string | string[]> | null>(null);
  const primary = useRef<HTMLButtonElement>(null), back = useRef<HTMLButtonElement>(null);
  // "No link" brings its form into view once, when it opens (on a phone it starts below the fold).
  const seat = seatOf(who)!;
  const recordOnly = who !== "ai" && channel === "none";
  const canRecord = record && (who === "staff" || who === "manager");
  const caLocked = who === "accountant" && !admin;
  const validLink = channel === "email" ? /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to.trim()) : digits(to).length >= 10;

  const refresh = useCallback(() => fetch("/api/v0/account/invites", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
    .then((d) => { if (d) setInvites(d.invites ?? []); }).catch(() => { /* the list loads next time */ }), []);
  useEffect(() => { let live = true; fetch("/api/v0/account/invites", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
    .then((d) => { if (live) setInvites(d?.invites ?? []); }).catch(() => { if (live) setInvites([]); }); return () => { live = false; }; }, []);
  useEffect(() => { if (confirmAi) back.current?.focus(); }, [confirmAi]);

  // "No link" is for an employee or a manager: picking anyone else goes back to e-mail.
  const pick = (k: Who) => { setWho(k); setChosen(true); setMade(null); setError(""); setConfirmAi(null); if (k !== "staff" && k !== "manager" && channel === "none") setChannel("email"); };
  const finishRecord = (id: string | undefined, label: string, existing?: { handle: string; offered: boolean }) => {
    celebrate(primary.current);
    notify(existing ? { id: "saved:people", tone: "success", title: `${label} added`, timeout: 12000,
      message: existing.offered ? `They already have a Vitals OS account (@${existing.handle}). This company is added when they accept in their account.` : `They already have a Vitals OS account (@${existing.handle}) in this company.` }
      : { id: "saved:people", tone: "success", title: `${label} added to the team`, timeout: 3000 });
    onClose();
    if (id) router.push(`/people/${id}`); else router.refresh();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    setError("");
    const form = event.currentTarget;
    if (who === "ai" || recordOnly) {
      const data = new FormData(form);
      const list = who === "ai" ? aiFields(fields, owners, provider) : fields;
      const missing = list.find((f) => f.required && !String(data.get(f.key) ?? "").trim());
      if (missing) { setError(`${missing.label}: ${["select", "choice"].includes(missing.type ?? "") ? "choose one" : "fill this in"}`); return; }
      if (!form.reportValidity()) return;
      const body = Object.fromEntries(list.map((f) => [f.key, String(data.get(f.key) ?? "").trim()]).filter(([, v]) => v !== ""));
      if (who === "ai") {
        if (!confirmAi) { const { role, managerId, ...rest } = body; setConfirmAi({ ...rest, title: role, ownerId: managerId, tools }); return; }
        saving.current = true; setBusy(true);
        try {
          const result = await post<{ id: string; employeeId: string }>("agents", confirmAi);
          const href = `/people/ai/${encodeURIComponent(result.id)}`;
          celebrate(primary.current);
          notify({ id: "saved:agents", tone: "success", title: `Added ${result.employeeId}`, message: String(confirmAi.name), href, action: { label: "View", run: () => router.push(href) }, timeout: 10000 });
          onClose(); router.push(href);
        } catch (e) { setError(e instanceof Error ? e.message : "Could not add it. Check your connection and try again."); }
        finally { saving.current = false; setBusy(false); }
        return;
      }
      saving.current = true; setBusy(true);
      try {
        if (who === "manager" && !body.role) body.role = "Manager";
        const result = await post<{ id: string; account?: { handle: string; offered: boolean } }>("people", body);
        finishRecord(result.id, String(body.name ?? "They"), result.account);
      } catch (e) { setError(e instanceof Error ? e.message : "Could not save. Try again."); }
      finally { saving.current = false; setBusy(false); }
      return;
    }
    if (caLocked) return;
    if (!validLink) { setError(channel === "email" ? "Type their e-mail, like name@example.com." : "Type their 10-digit mobile number."); return; }
    saving.current = true; setBusy(true); setMade(null); setCopied(false);
    try {
      const row = { seat: who, channel, ...(channel === "email" ? { email: to.trim() } : {}), name: name.trim(), caSalaries: who === "accountant" && salaries };
      const r = (await post<{ rows: Made[] }>("account/invites", { rows: [row] })).rows[0];
      if (r.status === "member") { setError("They are already in your company."); return; }
      if (r.status !== "created") { setError(channel === "email" ? "That does not look like an e-mail address." : "That did not work. Try again."); return; }
      setMade(r); setSentTo(to);
      celebrate(primary.current);
      if (channel !== "email" && r.message) window.open(shareUrl(channel, to, r.message), "_blank", "noopener");
      setTo(""); setName(""); void refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "That did not work. Try again."); }
    finally { saving.current = false; setBusy(false); }
  }
  const withdraw = async (id: string) => { try { setInvites((await post<{ invites: Invite[] }>(`account/invites/${id}/revoke`)).invites); } catch (err) { setError(err instanceof Error ? err.message : "Could not withdraw it"); } };

  const label = who === "ai" ? (confirmAi ? (busy ? "Adding…" : "Add AI employee") : "Next: review") : recordOnly ? (busy ? "Saving…" : "Add to the team") : busy ? "Sending…" : made ? "Send another" : "Send join link";
  const waiting = invites?.filter((v) => v.status === "open").length ?? 0;
  return <Drawer title="Add people" size="lg" onClose={() => { if (!saving.current) onClose(); }}
    context={<span className={css.context}>Pick who they are, then how they join.</span>}
    footer={<DrawerFooter status={error}
      primary={<button ref={primary} form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || caLocked}>{label}</button>}>
      {confirmAi ? <button ref={back} type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => setConfirmAi(null)}>Back</button>
        : <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onClose}>Cancel</button>}
    </DrawerFooter>}>
    <form id={formId} className={css.form} onSubmit={submit} noValidate>
      <DrawerSection title={<><span className={css.no}>1</span>Who are you adding?</>}>
        {chosen ? <div className={css.chosen}><span className={css.icon} aria-hidden="true">{ICON[who]}</span><span className={css.cardText}><b>{who === "accountant" ? "CA" : seat.label}</b><small>{SHORT[who] ?? seat.line}</small></span>
          <button type="button" className={css.change} onClick={() => setChosen(false)}>Change</button></div>
        : <div className={css.grid} role="radiogroup" aria-label="Who are you adding?">
          {choices.map((k) => { const s = seatOf(k)!; const on = who === k; return <Fragment key={k}>{k === "ai" ? <p className={css.orAi}>Or an AI helper</p> : null}<label className={css.card} data-on={on ? "" : undefined} data-ai={k === "ai" ? "" : undefined}>
            <input type="radio" name="who" value={k} checked={on} onChange={() => pick(k)} />
            <span className={css.icon} aria-hidden="true">{ICON[k]}</span>
            <span className={css.cardText}><b>{k === "accountant" ? "CA" : s.label}</b><small>{SHORT[k] ?? s.line}</small></span>
            {on ? <Check size={16} className={css.tick} aria-hidden="true" /> : null}
          </label></Fragment>; })}
        </div>}
        {who === "ai" ? null : <details className={css.words} key={who} aria-live="polite">
          <summary className={css.wordsHead}>What they will see and do<ChevronDown size={14} aria-hidden="true" /></summary>
          <p><b>They will see:</b> {sentence(who === "accountant" && salaries ? [...seat.sees, "Each person’s salary"] : seat.sees)}.</p>
          <p><b>They can:</b> {sentence(seat.does)}.</p>
          <p><b>They won’t see:</b> {sentence(who === "accountant" && salaries ? seat.wont.filter((w) => !w.includes("salary")) : seat.wont)}.</p>
          {who === "accountant" ? <label className={css.check}><input type="checkbox" checked={salaries} onChange={(e) => setSalaries(e.target.checked)} disabled={caLocked} />
            <span>Also let them see each person’s salary <small>(only if they file TDS on salary for you)</small></span></label> : null}
          {caLocked ? <p className={css.warn}>Only an admin can add a CA. Ask your admin.</p> : null}
        </details>}
      </DrawerSection>

      {who === "ai" ? <AiStep key="ai" formId={formId} fields={fields} owners={owners} provider={provider} setProvider={setProvider} tools={tools} setTools={setTools} confirm={Boolean(confirmAi)} />
        : <DrawerSection title={<><span className={css.no}>2</span>{who === "accountant" ? "How does your CA join?" : `How does the ${seat.label.toLowerCase()} join?`}</>}>
          <div className={css.channels} data-four={canRecord ? "" : undefined} role="radiogroup" aria-label="How do they join?">
            {CHANNELS.filter((c) => c.key !== "none" || canRecord).map((c) => <label key={c.key} className={css.channel} data-on={channel === c.key ? "" : undefined}>
              <input type="radio" name="channel" value={c.key} checked={channel === c.key} onChange={() => { setChannel(c.key); setChosen(true); setTo(""); setError(""); setMade(null); }} />
              <span aria-hidden="true">{c.icon}</span>{c.label}
            </label>)}
          </div>
          {recordOnly ? <div key={who} className={css.record}>
            <p className={css.note}><Link2Off size={15} aria-hidden="true" />Added to the team now. Send them a join link later from their profile.</p>
            <div className={styles.modalBody}>{asList(fields).filter((f) => f.required).map((f) => <FormField key={f.key} f={{ ...f, section: undefined, wide: false, ...(f.key === "name" ? { placeholder: "e.g. Priya Soniba" } : {}) }} value={f.key === "role" && who === "manager" ? "Manager" : ""} formId={formId} />)}</div>
            {/* The rest can follow: one fold, so the form is two fields long. */}
            <details className={css.moreDetails}><summary><ChevronDown size={15} aria-hidden="true" />More details <small>(optional)</small></summary>
              <div className={styles.modalBody}>{asList(fields).filter((f) => !f.required).map((f, i, all) => <Fragment key={f.key}>{f.section && f.section !== [...all.slice(0, i)].reverse().find((x) => x.section)?.section ? <h4 className={css.group}>{f.section}</h4> : null}
                <FormField f={{ ...f, section: undefined }} value="" formId={formId} /></Fragment>)}</div>
            </details>
          </div> : <>
            <div className={css.inputs}>
              <label className={css.field}><span>{channel === "email" ? "Their e-mail" : "Their mobile number"}</span>
                <input value={to} onChange={(e) => setTo(e.target.value)} type={channel === "email" ? "email" : "tel"} inputMode={channel === "email" ? "email" : "tel"} autoCapitalize="none" spellCheck={false}
                  placeholder={channel === "email" ? (who === "accountant" ? "ca@example.com" : "name@example.com") : "98xxxxxxxx"} autoComplete="off" /></label>
              <label className={css.field}><span>Their name <small>(optional)</small></span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" /></label>
            </div>
            <p className={css.small}>{channel === "email" ? "Pulse e-mails them a join link." : `${channel === "whatsapp" ? "WhatsApp" : "Your messages app"} opens with the message ready. You press send. Pulse does not keep the number.`} The link works once and ends in 14 days.</p>
          </>}
          {made ? <Done made={made} to={sentTo} copied={copied} onCopy={async () => { if (!made.link) return; try { await navigator.clipboard.writeText(made.link); setCopied(true); } catch { setCopied(false); } }} /> : null}
        </DrawerSection>}

      {who !== "ai" && !recordOnly && invites?.length ? <details className={css.sent}>
        <summary><ChevronDown size={15} aria-hidden="true" />Links you sent{invites ? <span className={css.count}>{waiting ? `${waiting} waiting` : invites.length ? `${invites.length}` : "none yet"}</span> : null}</summary>
        {invites?.length ? <ul>{invites.slice(0, 30).map((v) => { const s = seatOf(v.seat); return <li key={v.id}>
          <span className={css.who}><b>{v.name || v.email || v.who || "Private link"}</b><small>{s?.label ?? (v.kind === "client" ? "Client" : "Team")}{v.caSalaries ? " · sees salaries" : ""} · {v.channel === "whatsapp" ? "WhatsApp" : v.channel === "sms" ? "SMS" : v.email ? "E-mail" : "Link"}</small></span>
          <span className={css.state} data-s={v.status}>{STATUS[v.status] ?? v.status}</span>
          {v.status === "open" ? <button type="button" className={css.quiet} onClick={() => void withdraw(v.id)} aria-label={`Withdraw the link for ${v.name || v.email || "this person"}`}><X size={14} aria-hidden="true" />Withdraw</button> : <span />}
        </li>; })}</ul> : <p className={css.small}>{invites ? "Nothing sent yet." : "Loading…"}</p>}
      </details> : null}
    </form>
  </Drawer>;
}

/** An AI employee: the person fields that apply (name, role, team, manager), its runtime, limits and tools; then one
 *  confirmation that it is marked AI everywhere. */
function aiFields(humanFields: FieldDef[], owners: Option[], provider: string): FieldDef[] {
  const person = humanFields.filter((f) => ["name", "role", "pod", "department", "managerId"].includes(f.key))
    .map((f) => f.key === "managerId" ? { ...f, options: owners, required: true, hint: "Its manager reviews its work and runs its settings." } : f.key === "name" ? { ...f, label: "Name", maxLength: 80, placeholder: "e.g. Accounts helper" } : f.key === "role" ? { ...f, placeholder: "e.g. Invoice checker" } : f)
    // Role beside team, the pod beside who it reports to.
    .sort((a, b) => ["name", "role", "department", "pod", "managerId"].indexOf(a.key) - ["name", "role", "department", "pod", "managerId"].indexOf(b.key));
  return [...asList(person),
    { key: "provider", label: "Runtime", type: "choice", required: true, section: "How it runs", options: [{ value: "claude", label: "Claude", hint: "Claude Code on this server" }, { value: "codex", label: "Codex", hint: "Codex CLI on this server" }] },
    { key: "model", label: "Model", required: true, suggest: MODELS[provider], placeholder: MODELS[provider][0], maxLength: 80 },
    { key: "effort", label: "Effort", type: "choice", required: true, options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }] },
    { key: "lane", label: "Answers", type: "choice", required: true, options: [{ value: "quick", label: "Quick" }, { value: "thinking", label: "Thinking" }] },
    { key: "dailyTokenBudget", label: "Daily limit (tokens)", type: "number", required: true, hint: "Its runs stop for the day at this." }];
}

function AiStep({ formId, fields, owners, provider, setProvider, tools, setTools, confirm }: { formId: string; fields: FieldDef[]; owners: Option[]; provider: string; setProvider: (p: string) => void; tools: string[]; setTools: (f: (t: string[]) => string[]) => void; confirm: boolean }) {
  const list = aiFields(fields, owners, provider);
  const defaults: Record<string, string> = { provider, model: MODELS[provider][0], effort: "medium", lane: "thinking", dailyTokenBudget: "160000" };
  const AI_KEYS = ["provider", "model", "effort", "lane", "dailyTokenBudget"];
  const head = list.filter((f) => !AI_KEYS.includes(f.key)), run = list.filter((f) => AI_KEYS.includes(f.key));
  return <>
    {confirm ? <DrawerSection><p id={`${formId}-confirm`} className={css.confirm}><Bot size={16} aria-hidden="true" />This member is AI. It is marked AI everywhere, has no sign-in, and acts only through its own key.</p></DrawerSection> : null}
    <div style={confirm ? { display: "none" } : undefined} onChange={(e) => {
      const t = e.target as HTMLInputElement; if (t.name !== "provider" || t.value === provider) return;
      const model = t.form?.elements.namedItem("model") as HTMLInputElement | null;
      if (model && (!model.value || MODELS[provider]?.includes(model.value))) model.value = MODELS[t.value]?.[0] ?? "";
      setProvider(t.value);
    }}>
      <DrawerSection title={<><span className={css.no}>2</span>Name and job</>}><div className={styles.modalBody}>{head.filter((f) => f.required).map((f) => <FormField key={f.key} f={{ ...f, section: undefined, hint: undefined, wide: f.key === "managerId" }} value="" formId={formId} />)}</div>
        <p className={css.aiHelp}>Its manager checks its work.</p>
        <details className={css.moreDetails}><summary><ChevronDown size={15} aria-hidden="true" />More options <small>(optional)</small></summary>
          <p className={css.toolsHead}>What it can do</p>
          <fieldset className={css.toolChips}><legend className={css.srOnly}>What it can do</legend>{TOOLS.map((t) => <label key={t.value} title={t.hint}>
          <input type="checkbox" checked={tools.includes(t.value)} onChange={(e) => setTools((x) => e.target.checked ? [...x, t.value] : x.filter((y) => y !== t.value))} />
          <span className={css.box} aria-hidden="true"><Check size={13} /></span><span><b>{t.label}</b><small>{TOOL_LINE[t.value]}</small></span></label>)}</fieldset>
          <div className={styles.modalBody}>{head.filter((f) => !f.required).map((f) => <FormField key={f.key} f={{ ...f, section: undefined }} value="" formId={formId} />)}
            {run.map((f) => <FormField key={f.key} f={{ ...f, section: undefined }} value={defaults[f.key] ?? ""} formId={formId} />)}</div>
        </details>
      </DrawerSection>
    </div>
  </>;
}

function Done({ made, to, copied, onCopy }: { made: Made; to: string; copied: boolean; onCopy: () => void }) {
  const s = seatOf(made.seat);
  if (made.channel === "email" && made.mailed) return <p className={css.ok} role="status"><Check size={16} aria-hidden="true" />Sent to {made.email}. They join as {s?.label.toLowerCase()}{made.hasAccount ? " with the account they already have" : ""}.</p>;
  return <div className={css.ok} role="status">
    <p><Check size={16} aria-hidden="true" />{made.channel === "email" ? "We could not e-mail it. Send this link yourself:" : `Link made. If ${made.channel === "whatsapp" ? "WhatsApp" : "your messages app"} did not open, use these:`}</p>
    {made.link ? <div className={css.linkBox}><code>{made.link}</code><button type="button" className={css.quiet} onClick={onCopy}><Copy size={14} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button></div> : null}
    {made.message && made.channel !== "email" ? <a className={css.secondary} href={shareUrl(made.channel as Channel, to, made.message)} target="_blank" rel="noreferrer">Open {made.channel === "whatsapp" ? "WhatsApp" : "SMS"}</a> : null}
    <p className={css.small}>Shown once. Send it only to them: anyone with the link can join.</p>
  </div>;
}
