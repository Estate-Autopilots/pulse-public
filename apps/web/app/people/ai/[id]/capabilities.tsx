"use client";
// AI-EMPLOYEE-POWER (owner, 6 Nov 2026): an AI employee's Capabilities, on its profile's AI section. Two halves: the
// tools it can use in Pulse (from the API, grouped by area, the ones that make changes marked), and the company's
// servers, one row each, with the tier it works at there: Read-only, Read-write (sandboxed), Root (unsandboxed) or the
// server's own default, and what each tier means (its commands and limits). Root is a full root shell: only the
// organisation owner grants it, through a confirm that spells out what it allows and asks for GRANT ROOT typed, with
// a time limit per job. Organisation admins only (GET /api/v0/admin/runners/agents/:id/capabilities); anyone else
// sees one line saying so.
import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Server, ShieldAlert, Wrench } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ago } from "../../../lib/format";
import { Modal, post } from "../../../records";
import { styles } from "../../../ui";
import { Segmented } from "../../../kit";
import { Disclosure } from "../../../kit/disclosure";
import css from "./profile.module.css";

type Tier = "none" | "read-only" | "sandboxed" | "root";
type Choice = "read-only" | "sandboxed" | "root" | "default";
type Tool = { name: string; title: string; description: string; area: string; writes: boolean };
export type CapServer = { id: string; name: string; online: boolean; aiEmployees: boolean; accessLevel: string; tier: Tier; explicit: boolean; timeLimitSec: number;
  grantedBy: string | null; grantedAt: string | null; directShell: boolean; rootShell: boolean };
type TierInfo = { key: Exclude<Tier, "none">; label: string; commands: string[] };
type Caps = { agent: { id: string; name: string }; canGrantRoot: boolean; tools: Tool[]; servers: CapServer[]; tiers: TierInfo[] };
type Limit = "300" | "600" | "900" | "1800";

const CHOICES: { key: Choice; label: string }[] = [
  { key: "read-only", label: "Read-only" }, { key: "sandboxed", label: "Read-write (sandboxed)" }, { key: "root", label: "Root (unsandboxed)" }, { key: "default", label: "Default" }];
const TIER_WORD: Record<Tier, string> = { none: "no access", "read-only": "Read-only", sandboxed: "Read-write (sandboxed)", root: "Root (unsandboxed)" };
const AREA: Record<string, string> = { tasks: "Tasks", projects: "Projects", people: "People", chats: "Chats", docs: "Documents", billing: "Billing", workflows: "Workflows",
  servers: "Servers", companies: "Companies and clients", search: "Search", events: "Events", finance: "Finance", hr: "HR", memory: "Memory", web: "Web", drive: "Drive" };
const areaName = (a: string) => AREA[a] ?? (a ? a.charAt(0).toUpperCase() + a.slice(1).replace(/[-_]/g, " ") : "Other");
const LIMITS: { value: Limit; label: string }[] = [{ value: "300", label: "5 min" }, { value: "600", label: "10 min" }, { value: "900", label: "15 min" }, { value: "1800", label: "30 min" }];
const mins = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`;
const why = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** The Capabilities pane: tools, then servers with their tier. */
export function AiCapabilities({ id }: { id: string }) {
  const [caps, setCaps] = useState<Caps | null>(null), [state, setState] = useState<"loading" | "ok" | "denied" | "missing" | "error">("loading"), [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const load = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    fetch(`/api/v0/admin/runners/agents/${encodeURIComponent(id)}/capabilities`, { cache: "no-store" }).then(async (r) => {
      const d = await r.json().catch(() => ({})) as Partial<Caps> & { error?: string };
      if (!live) return;
      if (r.status === 401 || r.status === 403) { setState("denied"); return; }
      if (r.status === 404) { setState("missing"); return; }
      if (!r.ok) { setErr(d.error ?? "Pulse could not load this. Try again."); setState("error"); return; }
      setCaps({ agent: d.agent ?? { id, name: "" }, canGrantRoot: !!d.canGrantRoot, tools: d.tools ?? [], servers: d.servers ?? [], tiers: d.tiers ?? [] }); setState("ok");
    }).catch(() => { if (live) { setErr("Pulse could not load this. Try again."); setState("error"); } });
    return () => { live = false; };
  }, [id, tick]);
  const saved = (row: CapServer | null) => { if (row) setCaps((c) => c ? { ...c, servers: c.servers.map((s) => s.id === row.id ? row : s) } : c); else load(); };
  return <section className={css.pane} role="tabpanel" id="ai-pane-capabilities" aria-labelledby="ai-tab-capabilities">
    <header className={css.paneHead}><div><h3>Capabilities</h3><p>What it can use in Pulse, and what it may do on each of the company’s servers.</p></div></header>
    <div className={css.paneBody}>
      {state === "loading" ? <p className={css.note} role="status"><LoaderCircle size={14} className={css.spin} aria-hidden="true" />Loading what it can do…</p>
        : state === "denied" ? <p className={css.note}><CircleAlert size={14} aria-hidden="true" />Only organisation admins see and change server access.</p>
        : state === "missing" ? <p className={css.note}><CircleAlert size={14} aria-hidden="true" />Server access for AI employees is not available here yet.</p>
        : state === "error" || !caps ? <p className={css.note} role="alert"><CircleAlert size={14} aria-hidden="true" />{err}
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => { setState("loading"); load(); }}>Try again</button></p>
        : <>
          <ToolList tools={caps.tools} />
          <div className={css.fieldGroup}>
            <div className={css.groupHead}><span>Servers</span><small className={css.help}>{caps.servers.length ? `${caps.servers.filter((s) => s.online).length} of ${caps.servers.length} online` : ""}</small></div>
            {caps.servers.length ? <ul className={css.capServers}>{caps.servers.map((s) => <ServerTier key={s.id} agent={caps.agent} s={s} tiers={caps.tiers} canGrantRoot={caps.canGrantRoot} onSaved={saved} />)}</ul>
              : <p className={css.note}>No server is connected yet. An admin connects one in Settings → Servers.</p>}
            <small className={css.help}>Default follows the server’s own access, set in Settings → Servers. Every change is kept with who made it.</small>
          </div>
        </>}
    </div>
  </section>;
}

/** The tools it can use, grouped by area; a long list folds away. */
function ToolList({ tools }: { tools: Tool[] }) {
  const groups = new Map<string, Tool[]>();
  for (const t of tools) groups.set(t.area, [...(groups.get(t.area) ?? []), t]);
  const writes = tools.filter((t) => t.writes).length;
  const body = <div className={css.capAreas}>{[...groups.entries()].map(([area, list]) => <div key={area} className={css.capArea}>
    <h4>{areaName(area)}<small>{list.length}</small></h4>
    <ul className={css.toolList}>{list.map((t) => <li key={t.name}><div className={css.capTool} title={t.name}>
      <span><b>{t.title || t.name}</b>{t.description ? <small>{t.description}</small> : null}</span>
      {t.writes ? <em className={css.tag} data-writes="">Makes changes</em> : <em className={css.tag}>Reads only</em>}
    </div></li>)}</ul>
  </div>)}</div>;
  return <div className={css.fieldGroup}>
    <div className={css.groupHead}><span><Wrench size={14} aria-hidden="true" /> Tools it can use</span>
      <small className={css.help}>{tools.length ? `${tools.length} tools · ${writes} make changes` : ""}</small></div>
    {!tools.length ? <p className={css.note}>No tools are open to it yet.</p>
      : tools.length > 12 ? <Disclosure summary={`Show all ${tools.length} tools`}>{body}</Disclosure> : body}
  </div>;
}

/** One server: online or not, and the tier it works at there (with what each tier means). */
function ServerTier({ agent, s, tiers, canGrantRoot, onSaved }: { agent: Caps["agent"]; s: CapServer; tiers: TierInfo[]; canGrantRoot: boolean; onSaved: (row: CapServer | null) => void }) {
  const [busy, setBusy] = useState<Choice | null>(null), [asking, setAsking] = useState(false);
  const current: Choice | null = !s.explicit ? "default" : s.tier === "none" ? null : s.tier;
  async function save(choice: Choice, extra: { timeLimitSec?: number; confirm?: "GRANT ROOT"; reason?: string } = {}) {
    setBusy(choice);
    try {
      const r = await post<{ server?: CapServer }>(`admin/runners/agents/${encodeURIComponent(agent.id)}/servers/${encodeURIComponent(s.id)}/tier`, { tier: choice, ...extra });
      onSaved(r.server ?? null);
      notify({ id: `ai-tier-${s.id}`, tone: "success", title: `${s.name}: ${CHOICES.find((c) => c.key === choice)?.label}`, message: choice === "root" ? `Root for up to ${mins(extra.timeLimitSec ?? 0)} a job.` : undefined, timeout: 3000 });
      return true;
    } catch (e) { notify({ id: `ai-tier-${s.id}`, tone: "error", title: "Not changed", message: why(e) }); return false; }
    finally { setBusy(null); }
  }
  const pick = (c: Choice) => { if (c === current || busy) return; if (c === "root") setAsking(true); else void save(c); };
  const commands = (k: Choice) => k === "default" ? [] : tiers.find((t) => t.key === k)?.commands ?? [];
  const granted = s.explicit && s.grantedBy ? `${s.tier === "root" ? "Root granted" : "Set"} by ${s.grantedBy}${s.grantedAt ? `, ${ago(s.grantedAt)}` : ""}${s.tier === "root" ? ` · up to ${mins(s.timeLimitSec)} a job` : ""}` : null;
  return <li className={css.capServer} data-off={s.aiEmployees ? undefined : ""}>
    <div className={css.capServerHead}>
      <span className={css.itemIcon}><Server size={15} aria-hidden="true" /></span>
      <span className={css.itemMain}><b>{s.name}</b>
        <small>{!s.aiEmployees ? "AI employees are off here" : `Now: ${s.explicit ? TIER_WORD[s.tier] : `Default (${TIER_WORD[s.tier]})`}`}{granted ? ` · ${granted}` : ""}</small></span>
      <em className={css.pill} data-status={s.online ? "done" : "muted"}>{s.online ? "Online" : "Offline"}</em>
    </div>
    {!s.aiEmployees ? <p className={css.note}><CircleAlert size={14} aria-hidden="true" />AI employees are off for this server (Settings → Servers)</p>
      : <fieldset className={css.capTiers} disabled={!!busy} aria-label={`Tier on ${s.name}`}>
        {CHOICES.map((c) => {
          const rootOff = c.key === "root" && !canGrantRoot, list = commands(c.key);
          return <div key={c.key} className={css.capTier} data-on={current === c.key ? "" : undefined} data-root={c.key === "root" ? "" : undefined} data-disabled={rootOff ? "" : undefined}>
            <label className={css.capTierHead}>
              <input type="radio" name={`tier-${s.id}`} checked={current === c.key} disabled={rootOff} onChange={() => pick(c.key)} />
              <b>{c.label}</b>
              {busy === c.key ? <LoaderCircle size={13} className={css.spin} aria-hidden="true" /> : null}
            </label>
            {c.key === "default" ? <small>Follows the server’s own access, set in Settings → Servers{s.explicit ? "" : ` (now ${TIER_WORD[s.tier]})`}.</small> : null}
            {c.key === "root" && rootOff ? <small>Only the organisation owner can grant root</small> : null}
            {c.key === "root" && !s.rootShell ? <small className={css.capWarn}>This server has not enabled root jobs yet</small> : null}
            {list.length ? <ul className={css.capCmds} aria-label={`${c.label}: what it allows`}>{list.map((x) => <li key={x}><code>{x}</code></li>)}</ul> : null}
          </div>;
        })}
      </fieldset>}
    {asking ? <RootConfirm agentName={agent.name} s={s} busy={busy === "root"} onCancel={() => setAsking(false)}
      onGrant={async (timeLimitSec, reason) => { if (await save("root", { timeLimitSec, confirm: "GRANT ROOT", reason: reason || undefined })) setAsking(false); }} /> : null}
  </li>;
}

/** The root confirm: what root means, a time limit per job, a reason, and GRANT ROOT typed. */
function RootConfirm({ agentName, s, busy, onCancel, onGrant }: { agentName: string; s: CapServer; busy: boolean; onCancel: () => void; onGrant: (timeLimitSec: number, reason: string) => void }) {
  const [typed, setTyped] = useState(""), [reason, setReason] = useState("");
  const [limit, setLimit] = useState<Limit>(() => LIMITS.find((l) => Number(l.value) === s.timeLimitSec)?.value ?? "600");
  const ready = typed.trim() === "GRANT ROOT";
  return <Modal title={`Give ${agentName || "this AI employee"} root on ${s.name}?`} onClose={onCancel} icon={<ShieldAlert size={18} aria-hidden="true" />}
    foot={<div className={css.confirmActions}>
      <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnDanger}`} disabled={!ready || busy} onClick={() => onGrant(Number(limit), reason.trim())}>
        {busy ? <LoaderCircle size={14} className={css.spin} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}Grant root</button>
    </div>}>
    <div className={css.capConfirm}>
      <p><b>This is a full root shell on {s.name}.</b> Each job it runs there may:</p>
      <ul>
        <li>download from the internet (packages, scripts, files)</li>
        <li>use ssh and scp between the company’s own servers</li>
        <li>run docker and start, stop or change services</li>
        <li>read and write any file on the server</li>
      </ul>
      <p>There is no list of allowed commands. Each job stops at its time limit (30 minutes at most). Every command and its output is kept in the root log in Settings → Servers, and an admin can revoke root for every AI employee at once there.</p>
      {!s.rootShell ? <p className={css.capWarn}>This server has not enabled root jobs yet. The grant is kept, and works once the server’s own admin enables root jobs.</p> : null}
      <div className={css.fieldGroup}><div className={css.groupHead}><span>Time limit per job</span></div>
        <Segmented size="sm" label="Time limit per job" value={limit} onChange={setLimit} options={LIMITS} /></div>
      <label className={css.field}><span>Why (kept with the grant)</span><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
      <label className={css.field}><span>Type GRANT ROOT to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} placeholder="GRANT ROOT" aria-invalid={typed.length > 0 && !ready ? true : undefined} /></label>
    </div>
  </Modal>;
}
