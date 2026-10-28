"use client";
// ONBOARD (owner, 26 Oct 2026): HR → Onboard team → Team setup. The team code people type on the public /team-setup
// page, what they sent, and the one next step for each: link their company address to their Pulse profile ("Use this
// email"), or create their Google account with the GAM command shown here (the owner runs it; Pulse never holds the
// Google admin password, and the first password below is made in this browser and never sent to Pulse).
import { Check, ClipboardCopy, KeyRound, RefreshCw, UserPlus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { notify } from "@pulse/ui-shell";
import { day } from "../../lib/format";
import { post } from "../../records";
import { Badge, styles } from "../../ui";
import css from "./team-setup.module.css";

export type SetupMatch = { id: string; name: string; email: string | null; signedIn: boolean; google: boolean };
export type SetupRequest = { id: string; name: string; hasGoogle: boolean; email: string | null; personalEmail: string | null; whatsapp: string | null;
  status: "new" | "done" | "dismissed"; createdAt: string; updatedAt: string; decidedAt: string | null; decidedBy: string | null; personId: string | null;
  workspace: boolean | null; matches: SetupMatch[] };
export type TeamSetupState = { setup: { code: string; enabled: boolean; domain: string | null; changedAt: string; changedBy: string | null } | null;
  suggestedDomain: string | null; directory: { count: number; loadedAt: string | null; emails: string[] }; requests: SetupRequest[] };

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** A first password for a new Google account: made here, shown once, never sent to Pulse. */
export function firstPassword() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    const pw = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}
const plain = (s: string) => s.normalize("NFKD").replace(/[^A-Za-z]/g, "").toLowerCase();
/** first@domain, else first.last@domain, else firstlast@domain: the first that is not in the directory yet. */
export function newAddress(name: string, domain: string, taken: string[]) {
  const [first = "", ...rest] = name.trim().split(/\s+/); const f = plain(first), l = plain(rest.join(""));
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const options = [f, l ? `${f}.${l}` : "", l ? `${f}${l}` : ""].filter(Boolean).map((x) => `${x}@${domain}`);
  return options.find((o) => !used.has(o)) ?? options[options.length - 1] ?? `@${domain}`;
}
const quoted = (s: string) => `"${s.replace(/["`$\\]/g, "")}"`;
/** The owner's command (GAM, on his laptop). */
export function gamCommand(address: string, name: string, password: string) {
  const [first = "", ...rest] = name.trim().split(/\s+/);
  return `gam create user ${address} firstname ${quoted(first)} lastname ${quoted(rest.join(" ") || "-")} password ${password} changepassword on`;
}
/** GAM's "print users" CSV (or one address per line) → the directory rows. */
export function parseDirectory(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const email = col(/primaryemail|^email$/), given = col(/givenname|firstname/), family = col(/familyname|lastname/), suspended = col(/^suspended$/);
  const rows = email >= 0 ? lines.slice(1) : lines;
  return rows.map((l) => l.split(",").map((x) => x.trim())).map((c) => ({
    email: (email >= 0 ? c[email] : c[0]) ?? "", ...(given >= 0 && c[given] ? { givenName: c[given] } : {}), ...(family >= 0 && c[family] ? { familyName: c[family] } : {}),
    ...(suspended >= 0 ? { suspended: /^true$/i.test(c[suspended] ?? "") } : {}),
  })).filter((r) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(r.email));
}
const noSubscribe = () => () => {};
async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); notify({ id: "team-setup-copy", tone: "success", title: `${what} copied`, timeout: 2000 }); }
  catch { notify({ id: "team-setup-copy", tone: "error", title: "Could not copy", message: "Select the text and copy it." }); }
}

export function TeamSetupAdmin({ data }: { data: TeamSetupState }) {
  const [s, setS] = useState(data); const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState(data.setup?.domain ?? data.suggestedDomain ?? "");
  const [paste, setPaste] = useState(""); const [show, setShow] = useState<"open" | "all">("open");
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");
  // A first password per request, made in this browser when the admin asks for the command (never stored or sent).
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const makePasswords = (rows: SetupRequest[]) => setPasswords((p) => ({ ...Object.fromEntries(rows.filter((r) => !p[r.id]).map((r) => [r.id, firstPassword()])), ...p }));
  const pw = (id: string) => passwords[id] ?? "";
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const dom = s.setup?.domain ?? s.suggestedDomain ?? "";
  const address = (r: SetupRequest) => addresses[r.id] ?? (r.hasGoogle ? r.email ?? "" : dom ? newAddress(r.name, dom, s.directory.emails) : "");
  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      let next = await post<TeamSetupState>("hr/team-setup", body);
      // The first code takes the domain typed beside it (making a code starts from the suggested one).
      if (body.action === "rotate" && !s.setup && domain && next.setup?.domain !== domain) next = await post<TeamSetupState>("hr/team-setup", { action: "domain", domain });
      setS(next); notify({ id: "team-setup", tone: "success", title: done, timeout: 2500 });
    }
    catch (e) { notify({ id: "team-setup", tone: "error", title: "Not saved", message: (e as Error).message }); } finally { setBusy(false); }
  }
  const open = s.requests.filter((r) => r.status === "new");
  const shown = show === "open" ? open : s.requests;
  const toCreate = open.filter((r) => !r.hasGoogle && dom);
  const message = s.setup ? `Set up your Pulse login: ${origin}/team-setup\nTeam code: ${s.setup.code}\nYour company Google account is your Pulse login.` : "";
  const created = useMemo(() => new Set(s.directory.emails), [s.directory.emails]);
  return <div className={css.wrap} data-grow="">
    <section className={css.card} aria-label="Team code">
      <div className={css.head}><h3>Team code</h3>{s.setup ? <Badge tone={s.setup.enabled ? "success" : "neutral"}>{s.setup.enabled ? "Open" : "Closed"}</Badge> : null}</div>
      {s.setup ? <>
        <p className={css.code}><KeyRound size={18} aria-hidden="true" /><b>{s.setup.code}</b></p>
        <p className={styles.muted}>People type it on <a href="/team-setup" target="_blank" rel="noreferrer">{origin}/team-setup</a>. Share it in the team&apos;s WhatsApp group; make a new one when someone leaves. Company domain: <b>{s.setup.domain ?? "not set"}</b>. Changed {day(s.setup.changedAt)}{s.setup.changedBy ? ` by ${s.setup.changedBy}` : ""}.</p>
        <div className={css.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => void copy(message, "WhatsApp message")}><ClipboardCopy size={13} aria-hidden="true" />Copy the WhatsApp message</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void copy(s.setup!.code, "Code")}>Copy code</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => { if (confirm("Make a new team code? The old one stops working at once.")) void act({ action: "rotate" }, "New team code made"); }}><RefreshCw size={13} aria-hidden="true" />New code</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void act({ action: s.setup!.enabled ? "disable" : "enable" }, s.setup!.enabled ? "Team setup closed" : "Team setup open")}>{s.setup.enabled ? "Close team setup" : "Open team setup"}</button>
        </div>
        <pre className={css.pre}>{message}</pre>
      </> : <p className={styles.muted}>No team code yet. Make one, share it in the team&apos;s WhatsApp group with the link, and people fill in <b>/team-setup</b> themselves.</p>}
      <form className={css.inline} onSubmit={(e) => { e.preventDefault(); void act(s.setup ? { action: "domain", domain } : { action: "rotate" }, s.setup ? "Domain saved" : "Team code made"); }}>
        <label>Company Google domain<input value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="company.com" maxLength={253} spellCheck={false} /></label>
        <button className={`${styles.btn} ${styles.btnSmall}${s.setup ? "" : ` ${styles.btnPrimary}`}`} disabled={busy || (!!s.setup && domain === (s.setup.domain ?? ""))}>{s.setup ? "Save domain" : "Make a team code"}</button>
      </form>
    </section>

    <section className={css.card} aria-label="What people sent">
      <div className={css.head}><h3>What people sent</h3><span className={styles.muted}>{open.length} waiting</span>
        <div className={css.filters} role="group" aria-label="Show"><button type="button" aria-pressed={show === "open"} onClick={() => setShow("open")}>Waiting</button><button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>All</button></div></div>
      {!shown.length ? <p className={styles.muted}>{show === "open" ? "Nothing waiting. When someone fills in team setup, they show here. Nothing is sent to them until you act." : "Nobody has used team setup yet."}</p> : null}
      <ul className={css.list}>{shown.map((r) => {
        const person = picked[r.id] ?? r.matches[0]?.id ?? "";
        const who = r.matches.find((m) => m.id === person);
        const addr = address(r);
        return <li key={r.id} className={css.request} data-status={r.status}>
          <div className={css.reqHead}><b>{r.name}</b><small className={styles.muted}>sent {day(r.updatedAt)}</small>
            {r.status !== "new" ? <Badge tone={r.status === "done" ? "success" : "neutral"}>{r.status === "done" ? `Done${r.decidedBy ? ` by ${r.decidedBy}` : ""}` : "Dismissed"}</Badge> : null}</div>
          <p className={css.answer}>{r.hasGoogle ? <>Has a company Google account: <b>{r.email}</b>{r.workspace === true ? <Badge tone="success">In Workspace</Badge> : r.workspace === false ? <Badge tone="warning">Not in the Workspace list</Badge> : null}</>
            : <>No company Google account yet · personal e-mail <b>{r.personalEmail}</b> · WhatsApp <b>{r.whatsapp}</b></>}</p>
          <div className={css.match}>{r.matches.length ? <label>In Pulse<select value={person} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.value })}>{r.matches.map((m) => <option key={m.id} value={m.id}>{m.name}{m.email ? ` (${m.email})` : " (no work e-mail)"}{m.google ? " · Google linked" : m.signedIn ? " · has signed in" : ""}</option>)}</select></label>
            : <span>Not in Pulse yet. <Link href="/people?add=member"><UserPlus size={13} aria-hidden="true" />Add {r.name} in People</Link>, then come back.</span>}</div>
          {r.status === "new" && !r.hasGoogle && dom ? <div className={css.create}>
            <label>New company address<input value={addr} onChange={(e) => setAddresses({ ...addresses, [r.id]: e.target.value.trim().toLowerCase() })} spellCheck={false} /></label>
            {created.has(addr) ? <p className={css.ok}><Check size={13} aria-hidden="true" />{addr} is in the Workspace list.</p> : !pw(r.id) ? <div className={css.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => makePasswords([r])}><KeyRound size={13} aria-hidden="true" />Make the Google account command</button></div> : <>
              <p className={styles.muted}>The owner runs this once (GAM, on his laptop). The first password is made in this browser and never sent to Pulse; Google asks for a new one at first sign-in.</p>
              <pre className={css.pre}>{gamCommand(addr, r.name, pw(r.id))}</pre>
              <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void copy(gamCommand(addr, r.name, pw(r.id)), "Command")}><ClipboardCopy size={13} aria-hidden="true" />Copy command</button>
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void copy(`Hi ${r.name.split(/\s+/)[0]}, your company Google account is ready.\nAddress: ${addr}\nFirst password: ${pw(r.id)}\nOpen ${origin}/login and press Continue with Google. Google asks you to choose your own password the first time.`, "WhatsApp message")}>Copy the WhatsApp message for {r.name.split(/\s+/)[0]}</button></div>
            </>}
          </div> : null}
          {r.status === "new" ? <div className={css.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy || !person || !addr || (!!who?.email && who.email.toLowerCase() === addr)}
              title={!person ? "Add the person in People first" : undefined}
              onClick={() => void act({ action: "decide", decision: "use-email", id: r.id, personId: person, email: addr }, `${addr} is ${who?.name ?? r.name}'s work e-mail`)}>Use this email{addr ? `: ${addr}` : ""}</button>
            {who?.email && who.email.toLowerCase() === addr ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void act({ action: "decide", decision: "done", id: r.id }, "Marked done")}>Already set: mark done</button> : null}
            <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void act({ action: "decide", decision: "dismiss", id: r.id }, "Dismissed")}>Dismiss</button>
          </div> : <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void act({ action: "decide", decision: "reopen", id: r.id }, "Back in the waiting list")}>Reopen</button></div>}
        </li>;
      })}</ul>
      <p className={styles.muted}>Next: <Link href="/hr?tab=onboard">Team</Link> → select them → <b>Invite…</b>. An invitation to a company address opens with <b>Continue with Google</b>; no Pulse password.</p>
    </section>

    {toCreate.length ? <section className={css.card} aria-label="Google accounts to create">
      <div className={css.head}><h3>Google accounts to create</h3><span className={styles.muted}>{toCreate.length} waiting</span></div>
      <p className={styles.muted}>All the commands at once, for the owner. Each first password is made in this browser and shown only on this screen.</p>
      {toCreate.every((r) => pw(r.id)) ? <>
        <pre className={css.pre}>{toCreate.map((r) => gamCommand(address(r), r.name, pw(r.id))).join("\n")}</pre>
        <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void copy(toCreate.map((r) => gamCommand(address(r), r.name, pw(r.id))).join("\n"), "Commands")}><ClipboardCopy size={13} aria-hidden="true" />Copy all commands</button></div>
      </> : <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => makePasswords(toCreate)}><KeyRound size={13} aria-hidden="true" />Make the commands ({toCreate.length})</button></div>}
    </section> : null}

    <section className={css.card} aria-label="Workspace list">
      <div className={css.head}><h3>Workspace list</h3><span className={styles.muted}>{s.directory.count ? `${s.directory.count} accounts · loaded ${day(s.directory.loadedAt!)}` : "not loaded"}</span></div>
      <p className={styles.muted}>Paste the company&apos;s Google accounts so team setup can suggest each person&apos;s address and this page can mark which exist. On the owner&apos;s laptop: <code>gam print users fields primaryemail,firstname,lastname,suspended</code>, then paste what it prints (or one address per line). Never shown publicly.</p>
      <textarea className={css.paste} value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={"primaryEmail,name.givenName,name.familyName,suspended\nname@company.com,First,Last,False"} />
      <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || !parseDirectory(paste).length} onClick={() => { const accounts = parseDirectory(paste); void act({ action: "directory", accounts }, `${accounts.length} accounts loaded`).then(() => setPaste("")); }}>Load {parseDirectory(paste).length || ""} accounts</button></div>
    </section>
  </div>;
}
