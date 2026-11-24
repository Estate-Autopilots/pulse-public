"use client";
// AI-ACCESS (owner, 23 Nov 2026: "Everyone who connects their Claude gets exactly what they are permitted to do. From one
// account I should manage all of that."). Settings → AI access, the one console (also opened from a personal space):
//  * Your AI apps: every Claude, ChatGPT or pulse command signed in as you, which works in ALL your companies, with
//    when it was last used and Disconnect;
//  * Waiting for your yes: what an AI asked to do that needs you first (Yes / No);
//  * For each company you are an admin of (one picker): the connected apps of everyone there (last used, what each did,
//    Disconnect, or "Turn off here" for one made in another company), and what an AI may do: for everyone, per role
//    and per person, each part On its own / Ask first / Never (the same words as AI employees), with who says yes.
// The API is /api/v0/ai-access (services/api/src/ai-access.ts); the database decides every scope (migration 2536).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, ChevronDown, Hourglass, Plus, ShieldCheck, Unplug, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../ui";
import { ago } from "../lib/format";
import { useConfirm } from "../kit/dialogs";
import { Chip, EmptyState, SegmentedTabs, Skeleton, StatTile, StatTiles } from "../kit/game";
import { SelectField } from "../kit/select-field";
import { GROUP_ORDER, GROUP_TEXT, RULE_TEXT, appKind, askParts, groupLog, roleName, type Group, type Rule } from "../lib/ai-access.mjs";
import css from "./ai-access.module.css";

type Groups = Partial<Record<Group, Rule>>;
type Activity = { calls7d: number; refused7d: number; lastAt: string | null; recent: { at: string; operation: string; status: number; rule: string | null }[] };
type Conn = { id: string; app: string; personId: string; person: string; homeOrgId: string; homeHere: boolean; homeName: string | null; canRevoke: boolean;
  createdAt: string; lastUsedAt: string | null; activity: Activity };
type Req = { id: string; orgId: string; person: string; app: string; tool: string; group: Group; summary: string; state: string; createdAt: string; approver: string | null; decidedBy: string | null; note: string | null };
type PolicyRow = { groups: Groups; approverId: string | null };
type Company = { id: string; name: string; handle: string | null; current: boolean; connections: Conn[]; requests: Req[]; roles: string[]; defaults: Record<Group, Rule>;
  people: { id: string; name: string; roles: string[] }[];
  policy: { company: PolicyRow | null; roles: (PolicyRow & { roleKey: string })[]; people: (PolicyRow & { personId: string; person: string })[] } };
type Mine = { id: string; app: string; homeOrgId: string; homeName: string; createdAt: string; lastUsedAt: string | null };
type Data = { companies: Company[]; mine: Mine[]; askingYou: Req[]; myOrgs: { id: string; name: string }[]; myRules: Groups };

async function send<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work just now. Try again.");
  return data as T;
}
const fail = (title: string) => (e: Error) => notify({ id: "ai-access", tone: "error", title, message: e.message });

function AppMark({ app }: { app: string }) {
  const kind = appKind(app);
  return <span className={css.mark} data-kind={kind} aria-hidden="true">{kind === "claude" ? "C" : kind === "chatgpt" ? "G" : kind === "cli" ? ">_" : <Bot size={16} />}</span>;
}

/** One request waiting for a yes, with Yes / No. */
function Ask({ r, onDone }: { r: Req; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => { setBusy(true); send(`ai-access/requests/${r.id}`, { orgId: r.orgId, approve })
    .then(() => { notify({ id: "ai-access", tone: "success", title: approve ? "Said yes. The AI can do it now." : "Said no. The AI was told.", timeout: 2500 }); onDone(); }, fail("Not saved"))
    .finally(() => setBusy(false)); };
  const waiting = r.state === "waiting";
  return <li className={css.ask} data-state={r.state}>
    <span className={css.askIcon} aria-hidden="true"><Hourglass size={16} /></span>
    <span className={css.askText}><b>{r.person}’s {r.app}: {askParts(r.summary).title}</b>
      {askParts(r.summary).details ? <span className={css.summary}>{askParts(r.summary).details}</span> : null}
      <span className={css.why}>Needs a yes because the rule for {GROUP_TEXT[r.group]?.label.toLowerCase() ?? "this"} is Ask first.</span>
      <small>{waiting ? `asked ${ago(r.createdAt)}${r.approver ? ` · waiting for ${r.approver}` : " · waiting for any admin"}` : r.state === "approved" ? `${r.decidedBy ?? "Someone"} said yes` : r.state === "used" ? "Done after a yes" : r.state === "declined" ? `${r.decidedBy ?? "Someone"} said no` : "Ended without an answer"}</small></span>
    {waiting ? <span className={css.askBtns}>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => decide(true)}><Check size={15} aria-hidden="true" /> Yes</button>
      <button type="button" className={styles.btn} disabled={busy} onClick={() => decide(false)}><X size={15} aria-hidden="true" /> No</button></span> : null}
  </li>;
}

/** Five parts, each On its own / Ask first / Never, and who says yes. Keyed by its saved rule, so a reload starts it afresh. */
function RuleCard({ title, sub, groups, base, approverId, people, onSave, onClear }: { title: string; sub?: string; groups: Groups; base: Record<Group, Rule>; approverId: string | null;
  people: Company["people"]; onSave: (g: Groups, approver: string | null) => Promise<void>; onClear?: () => Promise<void> }) {
  const [draft, setDraft] = useState<Groups>(groups), [ap, setAp] = useState(approverId ?? ""), [busy, setBusy] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(groups) || (ap || null) !== (approverId ?? null);
  const asks = GROUP_ORDER.some((g) => (draft[g] ?? base[g]) === "ask");
  // A role's or a person's rule shows only the parts it changes; the rest follow everyone ("Same as everyone").
  const [more, setMore] = useState(false);
  const shown = onClear && !more ? GROUP_ORDER.filter((g) => draft[g] !== undefined) : GROUP_ORDER;
  const same = GROUP_ORDER.length - shown.length;
  return <div className={css.rule}>
    <div className={css.ruleHead}><b>{title}</b>{sub ? <small>{sub}</small> : null}</div>
    <div className={css.parts}>
      {shown.map((g) => {
        const value = draft[g] ?? base[g];
        const own = onClear && draft[g] !== undefined;
        return <label key={g} className={css.part} data-rule={value}>
          <span><b>{GROUP_TEXT[g].label}</b><small>{own && draft[g] !== base[g] ? `Everyone: ${RULE_TEXT[base[g]]}` : GROUP_TEXT[g].hint}</small></span>
          <SelectField size="sm" className={css.pick} value={value} aria-label={`${title}: ${GROUP_TEXT[g].label}`} onChange={(e) => setDraft((d) => ({ ...d, [g]: e.target.value as Rule }))}>
            {(["on", "ask", "off"] as const).map((x) => <option key={x} value={x}>{RULE_TEXT[x]}</option>)}
          </SelectField></label>;
      })}
      {onClear && same ? <button type="button" className={css.same} onClick={() => setMore(true)}>
        + Set another part for {title}</button> : null}
    </div>
    {asks ? <label className={css.approver}><span>Who says yes<small>Gets the Ask first requests</small></span>
      <SelectField size="sm" value={ap} aria-label={`${title}: who says yes`} onChange={(e) => setAp(e.target.value)}>
        <option value="">Any admin</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label> : null}
    <div className={css.ruleBtns}>
      {onClear ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => { setBusy(true); void onClear().finally(() => setBusy(false)); }}>Remove this rule</button> : null}
      {changed ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy}
        onClick={() => { setBusy(true); void onSave(draft, ap || null).finally(() => setBusy(false)); }}>{busy ? "Saving…" : "Save changes"}</button> : null}
    </div>
  </div>;
}

function CompanyView({ co, reload }: { co: Company; reload: () => Promise<void> }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null), [adding, setAdding] = useState("");
  const base = useMemo(() => ({ ...co.defaults, ...(co.policy.company?.groups ?? {}) }) as Record<Group, Rule>, [co]);
  const waiting = co.requests.filter((r) => r.state === "waiting");
  const calls = co.connections.reduce((n, c) => n + (c.activity?.calls7d ?? 0), 0), refused = co.connections.reduce((n, c) => n + (c.activity?.refused7d ?? 0), 0);
  const save = (who: { roleKey?: string; personId?: string }) => async (groups: Groups, approverId: string | null) => {
    await send("ai-access/policy", { orgId: co.id, ...who, groups, approverId }).then(async () => { notify({ id: "ai-access", tone: "success", title: "Saved. It works from the next AI action.", timeout: 2500 }); await reload(); }, fail("Not saved"));
  };
  const clear = (who: { roleKey?: string; personId?: string }) => async () => {
    await send("ai-access/policy", { orgId: co.id, ...who, clear: true }).then(reload, fail("Not removed"));
  };
  const end = async (c: Conn) => {
    if (c.canRevoke) {
      if (!(await confirm({ title: `Disconnect ${c.person}’s ${c.app}?`, body: "It stops working in every company, starting now. They can connect it again later.", confirmLabel: "Disconnect", danger: true }))) return;
      await send(`ai-access/connections/${c.id}/revoke`, { orgId: co.id }).then(async () => { notify({ id: "ai-access", tone: "success", title: "Disconnected", timeout: 2500 }); await reload(); }, fail("Not disconnected"));
      return;
    }
    if (!(await confirm({ title: `Turn off AI for ${c.person} in ${co.name}?`, body: "Their AI apps can’t read or do anything here any more. Their other companies are not changed.", confirmLabel: "Turn off here", danger: true }))) return;
    await send("ai-access/policy", { orgId: co.id, personId: c.personId, groups: { read: "off", work: "off", messages: "off", money: "off", delete: "off" } })
      .then(async () => { notify({ id: "ai-access", tone: "success", title: `AI is off for ${c.person} here`, timeout: 2500 }); await reload(); }, fail("Not changed"));
  };
  const ruled = new Set([...co.policy.roles.map((r) => `role:${r.roleKey}`), ...co.policy.people.map((p) => `person:${p.personId}`)]);
  const choices = [...co.roles.filter((r) => !ruled.has(`role:${r}`)).map((r) => ({ key: `role:${r}`, label: `Everyone who is ${roleName(r)}` })),
    ...co.people.filter((p) => !ruled.has(`person:${p.id}`)).map((p) => ({ key: `person:${p.id}`, label: p.name }))];
  const adder = choices.find((c) => c.key === adding);

  return <div className={css.company}>
    {waiting.length ? <section className={css.card} aria-labelledby={`asks-${co.id}`}>
      <h3 id={`asks-${co.id}`}>Waiting for a yes</h3>
      <ul className={css.list}>{waiting.slice(0, 12).map((r) => <Ask key={r.id} r={{ ...r, orgId: co.id }} onDone={() => void reload()} />)}</ul>
    </section> : null}

    <StatTiles label={`${co.name} at a glance`} min={120}>
      <StatTile label="AI apps" value={co.connections.length} icon={Bot} />
      <StatTile label="Actions" value={calls} />
      <StatTile label="Need a yes" value={waiting.length} tone={waiting.length ? "warn" : undefined} icon={Hourglass} />
      <StatTile label="Stopped" value={refused} />
    </StatTiles>
    <p className={css.note}>Last 7 days. Stopped means your rules said no.</p>


    <section className={css.card} aria-labelledby={`apps-${co.id}`}>
      <h3 id={`apps-${co.id}`}>Connected AI apps in {co.name}</h3>
      {!co.connections.length ? <EmptyState art="connect" title="No AI apps connected here yet" text="When someone connects Claude, ChatGPT or the pulse command, it shows here." /> :
        <ul className={css.list}>{co.connections.map((c) => <li key={c.id} className={css.conn}>
          <div className={css.connRow}>
            <AppMark app={c.app} />
            <span className={css.connText}><b>{c.person}’s {c.app}</b>
              <small>{c.lastUsedAt ? `last used ${ago(c.lastUsedAt)}` : "not used yet"} · {c.activity?.calls7d ?? 0} actions here this week{c.activity?.refused7d ? ` · ${c.activity.refused7d} stopped` : ""}{c.homeHere ? "" : ` · connected in ${c.homeName ?? "another company"}`}</small></span>
            <span className={css.connBtns}>
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                What it did <ChevronDown size={13} aria-hidden="true" className={open === c.id ? css.flip : undefined} /></button>
              <button type="button" className={css.danger} onClick={() => void end(c)}><Unplug size={13} aria-hidden="true" /> {c.canRevoke ? "Disconnect" : "Turn off here"}</button>
            </span>
          </div>
          {open === c.id ? <ol className={css.log}>{(c.activity?.recent ?? []).length ? groupLog(c.activity.recent).map((a, i) => <li key={i} data-ok={a.ok ? "" : undefined}>
            <span>{a.what}{a.times > 1 ? ` (${a.times} times)` : ""}</span><small>{a.how} · {ago(a.at)}</small></li>)
            : <li><small>Nothing yet in {co.name}.</small></li>}</ol> : null}
        </li>)}</ul>}
    </section>

    <section className={css.card} aria-labelledby={`rules-${co.id}`}>
      <h3 id={`rules-${co.id}`}>What AI apps may do in {co.name}</h3>
      <p className={css.note}>An AI app never gets more than its person could do. Here you can allow less. A person’s own rule comes first, then their roles, then everyone.</p>
      <p className={css.key} aria-label="What the colours mean"><span data-rule="on">On its own</span><span data-rule="ask">Ask first</span><span data-rule="off">Never</span></p>
      <RuleCard key={`co:${JSON.stringify(co.policy.company ?? {})}`} title="Everyone" sub="The rule for every person here" groups={co.policy.company?.groups ?? {}} base={co.defaults} approverId={co.policy.company?.approverId ?? null}
        people={co.people} onSave={save({})} />
      {co.policy.roles.map((r) => <RuleCard key={`role:${r.roleKey}:${JSON.stringify(r)}`} title={`Everyone who is ${roleName(r.roleKey)}`} groups={r.groups} base={base} approverId={r.approverId}
        people={co.people} onSave={save({ roleKey: r.roleKey })} onClear={clear({ roleKey: r.roleKey })} />)}
      {co.policy.people.map((p) => <RuleCard key={`person:${p.personId}:${JSON.stringify(p)}`} title={p.person} sub="This person’s rule wins over the general ones" groups={p.groups} base={base} approverId={p.approverId}
        people={co.people} onSave={save({ personId: p.personId })} onClear={clear({ personId: p.personId })} />)}
      {choices.length ? <div className={css.add}>
        <SelectField size="sm" value={adding} aria-label="Add a rule for" onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add a rule for…</option>{choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</SelectField>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!adder} onClick={() => {
          if (!adder) return;
          const [kind, key] = adder.key.split(":");
          void save(kind === "role" ? { roleKey: key } : { personId: key })({}, null).then(() => setAdding(""));
        }}><Plus size={13} aria-hidden="true" /> Add</button>
      </div> : null}
    </section>
  </div>;
}

export function AiAccess({ appName }: { appName: string }) {
  const confirm = useConfirm();
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState<string | null>(null), [pick, setPick] = useState<string>("");
  const load = useCallback(() => send<Data>("ai-access").then((d) => { setData(d); setError(null); }, (e: Error) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);
  const companies = data?.companies ?? [];
  const co = companies.find((c) => c.id === pick) ?? companies.find((c) => c.current) ?? companies[0];
  const many = (data?.myOrgs.length ?? 0) > 1;

  const endMine = async (m: Mine) => {
    if (!(await confirm({ title: `Disconnect ${m.app}?`, body: `It can’t reach ${appName} any more, in any of your companies, starting now.`, confirmLabel: "Disconnect", danger: true }))) return;
    await send(`ai-access/connections/${m.id}/revoke`, { orgId: m.homeOrgId }).then(async () => { notify({ id: "ai-access", tone: "success", title: `${m.app} disconnected`, timeout: 2500 }); await load(); }, fail("Not disconnected"));
  };

  if (error && !data) return <div className={css.page} data-grow=""><EmptyState art="nothing" title="AI access did not load" text={error} action={{ label: "Try again", onClick: () => void load() }} /></div>;
  if (!data) return <div className={css.page} data-grow="" aria-busy="true"><Skeleton height={64} /><Skeleton height={160} /><Skeleton height={220} /></div>;

  return <div className={css.page} data-grow="">

    {data.askingYou.length ? <section className={css.card} aria-labelledby="ai-asking">
      <h3 id="ai-asking">Waiting for your yes</h3>
      <ul className={css.list}>{data.askingYou.map((r) => <Ask key={r.id} r={r} onDone={() => void load()} />)}</ul>
    </section> : null}

    {companies.length ? <>
      <div className={css.coHead}>
        <h2><ShieldCheck size={18} aria-hidden="true" /> {companies.length > 1 ? "Companies you manage" : co?.name}</h2>
        {companies.length > 1 ? <SegmentedTabs label="Company" value={co?.id ?? ""} onChange={setPick} size="sm"
          options={companies.map((c) => { const n = c.requests.filter((r) => r.state === "waiting").length; return { value: c.id, label: n ? `${c.name} · ${n} waiting` : c.name }; })} /> : null}
      </div>
      {co ? <CompanyView key={co.id} co={co} reload={load} /> : null}
    </> : <p className={css.note}><Chip>Admins</Chip> Your company’s admins choose what AI apps may do here.</p>}

    <section className={css.card} aria-labelledby="ai-mine">
      <h3 id="ai-mine">Your own AI apps</h3>
      {!data.mine.length ? (companies.length
        ? <p className={css.note}>None yet. <a href="/settings?tab=connect-ai">Connect Claude or ChatGPT →</a>{many ? " One connection works in all your companies." : ""}</p>
        : <EmptyState art="connect" title="You have no AI app connected" text={<>Connect Claude or ChatGPT in <a href="/settings?tab=connect-ai">Connect your AI</a>.{many ? " One connection works in all your companies." : ""}</>} />) :
        <ul className={css.list}>{data.mine.map((m) => <li key={m.id} className={css.connRow}>
          <AppMark app={m.app} />
          <span className={css.connText}><b>{m.app}</b><small>{many ? "works in all your companies" : `works in ${m.homeName}`} · {m.lastUsedAt ? `last used ${ago(m.lastUsedAt)}` : "not used yet"}</small></span>
          <button type="button" className={css.danger} onClick={() => void endMine(m)}><Unplug size={13} aria-hidden="true" /> Disconnect</button></li>)}</ul>}
      {many && data.mine.length ? <p className={css.note}>Ask your AI “switch to {data.myOrgs.find((o) => !companies.some((c) => c.current && c.id === o.id))?.name ?? data.myOrgs[0].name}” to work in another company. Each company’s own rules apply there.</p> : null}
    </section>
  </div>;
}
