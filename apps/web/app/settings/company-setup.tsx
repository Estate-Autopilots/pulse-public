"use client";
// R53: a company set up on this Pulse follows its own setup checklist here (Settings → Organisation → Setup): what Pulse
// did, what its admins and HR do, what the platform operator and the owner still owe, and its source registry. Its admins
// register sources and approve or decline them; payroll, attendance history and chat history need a note saying what
// was approved. Nothing here sends anything or reads a source.
// R54: the readiness result (a rehearsal says so), and the trial's pilot: device checks per platform and HR's
// walkthrough sign-off, each with the kind of evidence it is, and the anonymous feedback totals.
import { Check, Info, Plus } from "lucide-react";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { GateLine, GuideList, ReadinessNote, TrialNote } from "../companies/checklist";
import css from "../companies/companies.module.css";
import { CATEGORIES, SENSITIVE, SOURCE_KINDS } from "../companies/steps";
import type { CompanySetup, Evidence, RegistrySource } from "../companies/types";
import { post } from "../records";
import { Badge, Panel, styles } from "../ui";
import { SelectField } from "../kit/select-field";

type Managed = Extract<CompanySetup, { managed: true }>;
const LABEL: Record<string, string> = { people: "People", structure: "Pods and roles", projects: "Projects", clients: "Clients", tasks: "Tasks", documents: "Documents",
  finance: "Finance", attendance_history: "Attendance history", payroll: "Payroll", chat_history: "Chat history" };
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";

export function CompanySetupView({ initial }: { initial: Managed }) {
  const [d, setD] = useState(initial);
  const live = d.company.activation === "live", open = d.company.status === "active";
  return <div className={css.stage} data-grow="">
    {!live ? <TrialNote name={d.company.name} /> : null}
    {d.readiness ? <ReadinessNote r={d.readiness} /> : null}
    <Panel title="Setup checklist" sub={<GateLine blocked={d.blocked} live={live} open={open} />}>
      <p className={css.note} style={{ paddingTop: 12 }}>Who does each step, whether Pulse does it or a person does, and what still blocks letting your staff sign in. The platform operator sees the same list.</p>
      <GuideList steps={d.guide} />
    </Panel>
    {d.duplicateNames.length || d.sharedEmails.length ? <Panel title="Identities to resolve" sub="Each person must be one clear identity">
      <ul className={css.bullets} data-tone="warning" style={{ paddingTop: 12 }}>
        {d.duplicateNames.map((n) => <li key={`n:${n}`}>More than one person is called {n}: give each a name people can tell apart (People → the person → About).</li>)}
        {d.sharedEmails.map((n) => <li key={`e:${n}`}>{n} share one e-mail address: give each their own.</li>)}
      </ul>
    </Panel> : null}
    <Sources d={d} onChange={setD} />
    <PilotPanel d={d} onChange={setD} />
    <Panel title="Support and recovery">
      <dl className={css.facts}>
        <dt>Support route</dt><dd>{d.handover.supportRoute ?? <span className={styles.muted}>Not set yet by the platform operator</span>}</dd>
        <dt>Restore drill</dt><dd>{d.handover.restore ? `${d.handover.restore.result === "passed" ? "Passed" : "Failed"} on ${d.handover.restore.on}, ${d.handover.restore.minutes} minutes, ${d.handover.restore.isolated ? "into an isolated target" : "not into an isolated target"}` : <span className={styles.muted}>None recorded yet</span>}</dd>
        <dt>Your files</dt><dd className={css.mono}>{d.company.prefix ?? "—"}</dd>
        <dt>Staff sign-in</dt><dd>{live ? `Live since ${d.handover.activatedAt?.slice(0, 10) ?? "before this checklist"}` : "Trial: admins, HR and leadership only"}</dd>
      </dl>
      <p className={styles.panelFoot}>Your company&apos;s data is backed up with this Pulse&apos;s database; the drill above is the operator&apos;s record that a restore was tried. Leaving or pausing Pulse keeps your lawful records: deleting anything is a separate, governed step.</p>
    </Panel>
  </div>;
}

function Sources({ d, onChange }: { d: Managed; onChange: (d: Managed) => void }) {
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notes, setNotes] = useState<Record<string, string>>({});
  const [f, setF] = useState({ label: "", key: "", kind: "csv", connector: "", grants: "admin", categories: [] as string[] }), [adding, setAdding] = useState(false);
  async function decide(s: RegistrySource, decision: "approved" | "declined" | "planned") {
    setBusy(s.id); setError("");
    try { onChange(await post<Managed>(`company-setup/sources/${s.id}`, { decision, note: notes[s.id] || null })); notify({ id: "source", tone: "success", title: decision === "approved" ? "Approved" : decision === "declined" ? "Marked as not used" : "Reopened", message: s.label, timeout: 2500 }); }
    catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function add() {
    setBusy("add"); setError("");
    try {
      onChange(await post<Managed>("company-setup/sources", { key: f.key.trim().toLowerCase(), label: f.label, kind: f.kind, grants: f.grants, categories: f.categories, ...(f.kind === "plugin" ? { connector: f.connector.trim().toLowerCase() } : {}) }));
      setF({ label: "", key: "", kind: "csv", connector: "", grants: "admin", categories: [] }); setAdding(false);
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  return <Panel title="Sources" sub={`${d.facts.sourcesReady ?? 0} of ${d.facts.sources ?? 0} ready`}>
    <p className={css.note} style={{ paddingTop: 12 }}>Where {d.company.name}&apos;s data comes from. A connector counts once it is installed and granted under Connected sources; a file or a hand-kept source counts once you approve it. Nothing is read from a source on this page.</p>
    {d.sources.length ? <ul className={css.items}>{d.sources.map((s) => <li key={s.id}>
      <span className={css.state} data-state={s.ready ? "done" : "todo"} title={s.ready ? "Ready" : "Not yet"}>{s.ready ? <Check size={12} aria-hidden="true" /> : null}</span>
      <span><b>{s.label}</b>{" "}<span className={css.tags}><Badge>{SOURCE_KINDS.find((k) => k.key === s.kind)?.label ?? s.kind}</Badge>{s.categories.map((c) => <Badge key={c} tone={(SENSITIVE as readonly string[]).includes(c) ? "warning" : "neutral"}>{LABEL[c] ?? c}</Badge>)}
        {s.decision === "approved" ? <Badge tone="success">Approved</Badge> : s.decision === "declined" ? <Badge>Not used</Badge> : null}</span>
        <small>{s.why}{s.note ? ` · Note: ${s.note}` : ""}</small>
        {d.canEdit ? <span className={css.actions} style={{ padding: "6px 0 0" }}>
          {s.decision === "planned" ? <>
            {s.sensitive.length || !s.connector ? <input className={css.cellInput} style={{ maxWidth: 320 }} value={notes[s.id] ?? ""} onChange={(e) => setNotes({ ...notes, [s.id]: e.target.value })} maxLength={300}
              placeholder={s.sensitive.length ? "What was approved, and by whom (required)" : "Note (optional)"} aria-label={`Note for ${s.label}`} /> : null}
            {!s.connector || s.sensitive.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy || (s.sensitive.length > 0 && (notes[s.id] ?? "").trim().length < 3)} onClick={() => void decide(s, "approved")}>Approve</button> : null}
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void decide(s, "declined")}>Not used</button>
          </> : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void decide(s, "planned")}>Reopen</button>}
        </span> : null}
      </span>
    </li>)}</ul> : <p className={css.note}><Info size={13} aria-hidden="true" /> No source registered yet.</p>}
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {d.canEdit ? adding ? <form className={css.form} onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <label className={styles.field}>Name<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) })} maxLength={80} required /></label>
      <label className={styles.field}>Key<input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} maxLength={40} spellCheck={false} required /></label>
      <label className={styles.field}>Kind<SelectField value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{SOURCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</SelectField></label>
      {f.kind === "plugin" ? <label className={styles.field}>Connector key<input value={f.connector} onChange={(e) => setF({ ...f, connector: e.target.value })} maxLength={40} spellCheck={false} /></label> : null}
      <label className={styles.field}>Granted by<SelectField value={f.grants} onChange={(e) => setF({ ...f, grants: e.target.value })}>{["admin", "hr", "finance", "leadership"].map((g) => <option key={g} value={g}>{g === "hr" ? "HR" : g[0].toUpperCase() + g.slice(1)}</option>)}</SelectField></label>
      <fieldset className={`${css.wide} ${css.catsField}`}><legend>Brings</legend><span className={css.cats}>{CATEGORIES.map((c) => <label key={c}><input type="checkbox" checked={f.categories.includes(c)} onChange={() => setF({ ...f, categories: f.categories.includes(c) ? f.categories.filter((x) => x !== c) : [...f.categories, c] })} />{LABEL[c]}</label>)}</span></fieldset>
      <span className={`${css.actions} ${css.wide}`} style={{ padding: 0 }}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy || !f.label}>{busy === "add" ? "Saving…" : "Register the source"}</button><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setAdding(false)}>Cancel</button></span>
    </form> : <div className={css.actions}><button type="button" className={styles.btn} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Register a source</button></div> : null}
  </Panel>;
}

const PLATFORMS: [string, string][] = [["android", "Android"], ["ios", "iPhone or iPad"], ["macos", "Mac"], ["windows", "Windows"], ["chrome", "Chrome"], ["web", "Web"]];
const EVIDENCE: Record<Evidence, string> = { mock: "Mock (synthetic, no device)", simulator: "Simulator or emulator", installed_device: "Installed on a real device", real_data_read_only: "The company's real data, read only" };
const evidenceWord = (kind: "device" | "walkthrough", e: Evidence) => kind === "walkthrough" && e === "mock" ? "Synthetic data" : EVIDENCE[e];
const COVERS: Record<"device" | "walkthrough", [string, string][]> = {
  device: [["pair", "Pairing"], ["check_in", "Check in"], ["check_out", "Check out"], ["offline", "Offline"], ["notification", "A notification"], ["revoke", "Unpairing"]],
  walkthrough: [["people", "People"], ["roles", "Roles"], ["policies", "Policies"], ["leave", "Leave"], ["attendance", "Attendance"], ["tasks", "Tasks"], ["sources", "Sources"], ["payroll", "Payroll"]],
};
const platformName = (p: string | null) => PLATFORMS.find(([k]) => k === p)?.[1] ?? p ?? "";

/** R54: what the trial's pilot tried. A real company needs an installed device and HR's walkthrough of its real data;
 *  a rehearsal can close them with synthetic evidence and stays a rehearsal. */
function PilotPanel({ d, onChange }: { d: Managed; onChange: (d: Managed) => void }) {
  const blank = (kind: "device" | "walkthrough") => ({ kind, platform: "android", evidence: (kind === "device" ? "installed_device" : "real_data_read_only") as Evidence, result: "passed", covers: [] as string[], note: "" });
  const [f, setF] = useState(blank("device")), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const p = d.pilot, fb = p?.feedback, checks = d.pilotChecks ?? [];
  const kinds: ("device" | "walkthrough")[] = d.canSignOff ? ["device", "walkthrough"] : ["device"];
  const evidence = (f.kind === "device" ? ["installed_device", "simulator", "mock"] : ["real_data_read_only", "mock"]) as Evidence[];
  async function save() {
    setBusy(true); setError("");
    try {
      onChange(await post<Managed>("company-setup/pilot-checks", { kind: f.kind, ...(f.kind === "device" ? { platform: f.platform } : {}), evidence: f.evidence, result: f.result, covers: f.covers, note: f.note.trim() || null }));
      notify({ id: "pilot-check", tone: "success", title: f.kind === "device" ? `${platformName(f.platform)} check recorded` : "HR's walkthrough recorded", timeout: 2500 });
      setF(blank(f.kind));
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Panel title="Pilot" sub={p ? `${p.passed} of ${p.platforms} platforms passed · walkthrough ${p.walkthrough ? (p.walkthroughOk ? "signed off" : p.walkthrough.result) : "not yet"}` : undefined}>
    <p className={css.note} style={{ paddingTop: 12 }}>During the trial {d.company.name}&apos;s admins, HR and leadership try Pulse on their own devices: record what worked on each platform and how it was tried. A mock or a simulator proves less than an installed device{d.company.rehearsal ? "" : ", and this company needs at least one installed device"}. HR walks through the people, roles, policies and sources, read only, and signs off{d.company.rehearsal ? "" : " on the company's real data"}.</p>
    {p && (p.devices.length || p.walkthrough) ? <ul className={css.items}>
      {p.devices.map((x) => <li key={x.platform}>
        <span className={css.state} data-state={x.result === "passed" ? "done" : "blocked"} title={x.result === "passed" ? "Passed" : "Failed"}>{x.result === "passed" ? <Check size={12} aria-hidden="true" /> : null}</span>
        <span><b>{platformName(x.platform)}</b>{" "}<span className={css.tags}><Badge tone={x.result === "passed" ? "success" : "danger"}>{x.result === "passed" ? "Passed" : "Failed"}</Badge><Badge tone={x.evidence === "installed_device" ? "accent" : "neutral"}>{EVIDENCE[x.evidence]}</Badge></span><small>Latest check on {x.on}</small></span>
      </li>)}
      {p.walkthrough ? <li>
        <span className={css.state} data-state={p.walkthroughOk ? "done" : "todo"}>{p.walkthroughOk ? <Check size={12} aria-hidden="true" /> : null}</span>
        <span><b>HR&apos;s walkthrough</b>{" "}<span className={css.tags}><Badge tone={p.walkthrough.result === "passed" ? "success" : "danger"}>{p.walkthrough.result === "passed" ? "Signed off" : "Failed"}</Badge><Badge>{evidenceWord("walkthrough", p.walkthrough.evidence)}</Badge></span><small>On {p.walkthrough.on}</small></span>
      </li> : null}
    </ul> : <p className={css.note}><Info size={13} aria-hidden="true" /> Nothing tried yet.</p>}
    <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {kinds.length > 1 ? <label className={styles.field}>Record<SelectField value={f.kind} onChange={(e) => setF(blank(e.target.value as "device" | "walkthrough"))}><option value="device">A device check</option><option value="walkthrough">HR&apos;s walkthrough</option></SelectField></label> : null}
      {f.kind === "device" ? <label className={styles.field}>Platform<SelectField value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}>{PLATFORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></label> : null}
      <label className={styles.field}>How it was tried<SelectField value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value as Evidence })}>{evidence.map((k) => <option key={k} value={k}>{evidenceWord(f.kind, k)}</option>)}</SelectField></label>
      <label className={styles.field}>Result<SelectField value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="passed">Passed</option><option value="failed">Failed</option></SelectField></label>
      <fieldset className={`${css.wide} ${css.catsField}`}><legend>{f.kind === "device" ? "What worked" : "What HR read"}</legend><span className={css.cats}>{COVERS[f.kind].map(([k, l]) => <label key={k}><input type="checkbox" checked={f.covers.includes(k)} onChange={() => setF({ ...f, covers: f.covers.includes(k) ? f.covers.filter((x) => x !== k) : [...f.covers, k] })} />{l}</label>)}</span></fieldset>
      <label className={`${styles.field} ${css.wide}`}>Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={300} placeholder={f.result === "failed" ? "What went wrong (no names or identifiers)" : f.kind === "device" ? "Optional: the device class and OS version, no names or identifiers" : "Optional: what HR checked, no names or salaries"} /></label>
      <span className={`${css.actions} ${css.wide}`} style={{ padding: 0 }}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (f.result === "passed" && f.covers.length === 0)}>{busy ? "Saving…" : f.kind === "device" ? "Record the device check" : "Sign off the walkthrough"}</button></span>
    </form>
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {checks.length ? <details className={css.note}><summary>All {checks.length} pilot records</summary><ul className={css.bullets} style={{ padding: "8px 0 0 18px" }}>{checks.map((c) => <li key={c.id}>
      {c.at.slice(0, 10)} · {c.kind === "device" ? platformName(c.platform) : "HR's walkthrough"} · {c.result} · {evidenceWord(c.kind, c.evidence)}{c.covers.length ? ` · ${c.covers.join(", ")}` : ""}{c.note ? ` · ${c.note}` : ""}{c.by ? ` · ${c.by}` : ""}
    </li>)}</ul></details> : null}
    <h3 className={css.note} style={{ paddingTop: 8, fontSize: 13, fontWeight: 600, color: "inherit" }}>Pilot feedback</h3>
    {fb && fb.shownAnswers != null ? <div className={css.tableWrap} style={{ margin: "0 14px 12px" }}><table className={css.table}>
      <thead><tr><th>Question</th><th>Average of 5</th><th>Agree</th></tr></thead>
      <tbody>{fb.questions.map((q) => <tr key={q.key}><td>{q.label}</td><td>{q.average ?? "–"}</td><td>{q.agree == null ? "–" : `${q.agree}%`}</td></tr>)}</tbody>
    </table></div> : null}
    <p className={styles.panelFoot}>{fb ? `${fb.answers} answered. ` : ""}Everyone answers four questions once under Settings → Your devices. Pulse keeps only the totals, never one person&apos;s answers, and shows them from {fb?.minimum ?? 5} answers, as of the last multiple of {fb?.minimum ?? 5}{fb?.shownAnswers ? ` (now ${fb.shownAnswers})` : ""}. Not needed for activation.</p>
  </Panel>;
}
