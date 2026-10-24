"use client";
// FLOW-E (owner, 21 Oct 2026: "customise an account to any industry, role or anything"): Settings → Industry & roles.
// Pick an industry pack (or start neutral): it brings the company's words, its work roles, starter processes (drafts)
// and record types; nothing the company already has is removed and everything stays editable here. Roles are data: any
// name, the screens it uses, its home and the tiles on it, and who holds it (a person can hold several roles).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Briefcase, Building, Building2, Check, CircleDashed, Megaphone, Plus, Stethoscope, Sun, UserRound, X, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { flow, why } from "../processes/flow-client";
import { Badge, Panel, Skeleton, styles } from "../ui";
import css from "./industry.module.css";

type Words = Record<string, string>;
type Tile = { key: string; label: string; of: "mine" | "role" | "runs"; modules?: string[]; late?: boolean; href?: string };
type PackRole = { key: string; name: string; note: string | null; screens: string[]; home: string | null; tiles: Tile[] };
export type PackView = { key: string; name: string; summary: string; icon: string; examples: string; words: Words; roles: PackRole[];
  processes: { key: string; name: string; summary: string; steps: number }[]; recordTypes: { key: string; name: string; plural: string }[] };
type Holder = { id: string; name: string; since: string };
type Role = PackRole & { id: string; source: string | null; holders: Holder[] };
export type Setup = { pack: { key: string; name: string; at: string } | null; words: Words; wordLabels: Words; wordKeys: string[]; roles: Role[];
  people: { id: string; name: string; title: string | null }[]; screens: { key: string; label: string }[]; canEdit: boolean; canName: boolean };

const ICONS: Record<string, LucideIcon> = { "circle-dashed": CircleDashed, "building-2": Building2, sun: Sun, megaphone: Megaphone, briefcase: Briefcase, stethoscope: Stethoscope, building: Building };
const PAIRS: [string, string][] = [["client", "clients"], ["project", "projects"], ["run", "runs"], ["team", "teams"], ["lead", "leads"]];
const PAIR_LABEL: Record<string, string> = { client: "A client is called", project: "A project is called", run: "A run of a process is called", team: "A team is called", lead: "A lead is called" };

export function IndustrySettings() {
  const router = useRouter();
  const [packs, setPacks] = useState<PackView[] | null>(null), [setup, setSetup] = useState<Setup | null>(null), [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([flow<{ packs: PackView[] }>("packs"), flow<Setup>("setup")]).then(([p, s]) => { setPacks(p.packs); setSetup(s); }).catch((e) => setError(why(e)));
  }, []);
  const changed = (s: Setup) => { setSetup(s); router.refresh(); };
  if (error) return <Panel title="Industry & roles"><p className={css.note}>{error}</p></Panel>;
  if (!packs || !setup) return <Panel title="Industry & roles"><div className={css.loading}><Skeleton height={120} /><Skeleton height={120} /></div></Panel>;
  return <div className={css.stack} data-grow="">
    <Packs packs={packs} setup={setup} onChange={changed} />
    <WordsPanel setup={setup} onChange={changed} />
    <Roles setup={setup} onChange={changed} />
  </div>;
}

function Packs({ packs, setup, onChange }: { packs: PackView[]; setup: Setup; onChange: (s: Setup) => void }) {
  const [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const current = setup.pack?.key ?? null;
  async function apply(p: PackView) {
    setBusy(true);
    try {
      const r = await flow<{ added: { roles: number; recordTypes: number; blocks: number; processes: string[] }; setup: Setup }>("setup/pack", "POST", { pack: p.key });
      const a = r.added; const parts = [a.roles ? `${a.roles} role${a.roles === 1 ? "" : "s"}` : "", a.processes.length ? `${a.processes.length} process${a.processes.length === 1 ? "" : "es"}` : "",
        a.recordTypes ? `${a.recordTypes} record type${a.recordTypes === 1 ? "" : "s"}` : "", a.blocks ? `${a.blocks} company block${a.blocks === 1 ? "" : "s"}` : ""].filter(Boolean);
      notify({ id: "pack", tone: "success", title: `${p.name} is your industry`, message: parts.length ? `Added ${parts.join(", ")}.` : "You already had everything it brings; the words changed.", timeout: 5000 });
      setOpen(null); onChange(r.setup);
    } catch (e) { notify({ id: "pack", tone: "error", title: "Not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <Panel title="Your industry" sub={setup.pack ? `${setup.pack.name} · words, roles and starter processes come from it; everything stays yours to change` : "Not chosen yet: pick the closest, or start neutral"}>
    <div className={css.packs} role="list" aria-label="Industry packs">
      {packs.map((p) => { const Icon = ICONS[p.icon] ?? CircleDashed; const on = current === p.key; const expanded = open === p.key;
        return <section key={p.key} role="listitem" className={css.pack} data-on={on || undefined} data-open={expanded || undefined} aria-label={p.name}>
          <div className={css.packTop}><span className={css.packIcon}><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
            <span className={css.packName}><b>{p.name}</b><small>{p.examples}</small></span>{on ? <Badge tone="success">In use</Badge> : null}</div>
          <p>{p.summary}</p>
          <dl className={css.packFacts}>
            <dt>Words</dt><dd>{[p.words.client, p.words.project, p.words.run].join(" · ")}</dd>
            <dt>Roles</dt><dd>{p.roles.map((r) => r.name).join(", ")}</dd>
            {p.processes.length ? <><dt>Processes</dt><dd>{p.processes.map((x) => `${x.name} (${x.steps} steps)`).join(", ")}</dd></> : null}
            {p.recordTypes.length ? <><dt>Records</dt><dd>{p.recordTypes.map((x) => x.plural).join(", ")}</dd></> : null}
          </dl>
          {setup.canEdit ? expanded ? <div className={css.confirm}>
            <p>{on ? "Apply it again: anything it brings that you removed comes back; your own words stay." : `This adds what you do not have yet. Your words become ${p.words.client}, ${p.words.project} and ${p.words.run}; you can change them below. Nothing you have is removed.`}</p>
            <div className={css.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void apply(p)}>{busy ? "Adding…" : on ? "Apply again" : `Use ${p.name}`}</button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => setOpen(null)}>Cancel</button></div>
          </div> : <div className={css.row}><button type="button" className={`${styles.btn} ${on || current ? "" : styles.btnPrimary} ${styles.btnSmall}`} onClick={() => setOpen(p.key)}>{on ? "Apply again" : current ? "Switch to this" : "Use this pack"}</button></div> : null}
        </section>; })}
    </div>
  </Panel>;
}

function WordsPanel({ setup, onChange }: { setup: Setup; onChange: (s: Setup) => void }) {
  const [w, setW] = useState<Words>(setup.words), [busy, setBusy] = useState(false);
  const dirty = Object.keys(w).some((k) => w[k] !== setup.words[k]);
  async function save() {
    setBusy(true);
    try { const s = await flow<Setup>("setup/words", "POST", { words: w }); setW(s.words); onChange(s); notify({ id: "words", tone: "success", title: "Words saved", message: "Menus and processes use them now.", timeout: 3000 }); }
    catch (e) { notify({ id: "words", tone: "error", title: "Not saved", message: why(e) }); } finally { setBusy(false); }
  }
  return <Panel title="Words" sub="What your company calls things; menus, processes and runs use them">
    <form className={css.words} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {PAIRS.map(([one, many]) => <fieldset key={one} className={css.pair} disabled={!setup.canEdit || busy}><legend>{PAIR_LABEL[one]}</legend>
        <label className={styles.field}>One<input value={w[one] ?? ""} maxLength={40} onChange={(e) => setW({ ...w, [one]: e.target.value })} aria-label={`${PAIR_LABEL[one]}: one`} /></label>
        <label className={styles.field}>Many<input value={w[many] ?? ""} maxLength={40} onChange={(e) => setW({ ...w, [many]: e.target.value })} aria-label={`${PAIR_LABEL[one]}: many`} /></label>
      </fieldset>)}
      {setup.canEdit ? <div className={css.row}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !dirty}>{busy ? "Saving…" : "Save the words"}</button>
        {dirty ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setW(setup.words)}>Undo</button> : null}</div> : <p className={css.note}>Leadership and admins change these.</p>}
    </form>
  </Panel>;
}

function Roles({ setup, onChange }: { setup: Setup; onChange: (s: Setup) => void }) {
  const [name, setName] = useState(""), [busy, setBusy] = useState("");
  async function run(key: string, path: string, payload: unknown, done?: string) {
    setBusy(key);
    try { const s = await flow<Setup>(path, "POST", payload); onChange(s); if (done) notify({ id: "role", tone: "success", title: done, timeout: 2500 }); return true; }
    catch (e) { notify({ id: "role", tone: "error", title: "Not changed", message: why(e) }); return false; } finally { setBusy(""); }
  }
  return <Panel title="Roles" sub="Any role your company has: what it sees, and who holds it. A person can hold several roles; steps given to a role go to its people.">
    {setup.roles.length ? <ul className={css.roles} aria-label="Roles">{setup.roles.map((r) => <RoleRow key={r.id} role={r} setup={setup} busy={busy === r.id} run={run} />)}</ul>
      : <p className={css.note}>No roles yet. Pick an industry above, or add your own.</p>}
    {setup.canEdit ? <form className={css.addRole} onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run("new", "roles", { name: name.trim() }, `${name.trim()} added`).then((ok) => ok && setName("")); }}>
      <label className={styles.field}>A new role<input value={name} maxLength={80} placeholder="Site surveyor, Doctor, Partner…" onChange={(e) => setName(e.target.value)} /></label>
      <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === "new" || !name.trim()}><Plus size={14} aria-hidden="true" />Add the role</button>
    </form> : null}
  </Panel>;
}

function RoleRow({ role: r, setup, busy, run }: { role: Role; setup: Setup; busy: boolean; run: (key: string, path: string, payload: unknown, done?: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState("");
  const others = setup.people.filter((p) => !r.holders.some((h) => h.id === p.id));
  const toggle = (key: string) => void run(r.id, `roles/${r.id}`, { screens: r.screens.includes(key) ? r.screens.filter((x) => x !== key) : [...r.screens, key] });
  return <li className={css.role} aria-label={r.name}>
    <div className={css.roleHead}><span className={css.roleIcon}><UserRound size={15} aria-hidden="true" /></span>
      <span className={css.roleName}><b>{r.name}</b>{r.note ? <small>{r.note}</small> : null}</span>
      {r.source?.startsWith("pack:") ? <Badge>From the pack</Badge> : null}
      {setup.canEdit ? <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={busy} onClick={() => { if (window.confirm(`Remove the role ${r.name}? Its people keep their steps; new steps of this role find nobody.`)) void run(r.id, `roles/${r.id}`, { archive: true }, `${r.name} removed`); }}>Remove</button> : null}
    </div>
    <div className={css.roleBody}>
      <div className={css.holders}><span className={css.label}>Held by</span>
        {r.holders.length ? r.holders.map((h) => <span key={h.id} className={css.holder}>{h.name}{setup.canName ? <button type="button" aria-label={`${h.name} no longer holds ${r.name}`} disabled={busy} onClick={() => void run(r.id, `roles/${r.id}/holders`, { personId: h.id, remove: true })}><X size={12} aria-hidden="true" /></button> : null}</span>)
          : <span className={css.muted}>Nobody yet</span>}
        {setup.canName && others.length ? <select className={css.addHolder} value={adding} disabled={busy} aria-label={`Add someone to ${r.name}`}
          onChange={(e) => { const pid = e.target.value; setAdding(""); if (pid) void run(r.id, `roles/${r.id}/holders`, { personId: pid }, `${setup.people.find((p) => p.id === pid)?.name ?? "They"} holds ${r.name}`); }}>
          <option value="">+ Add someone</option>{others.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ""}</option>)}</select> : null}
      </div>
      <div className={css.screens}><span className={css.label}>Sees</span>
        {setup.screens.map((s) => { const on = r.screens.includes(s.key); return <button key={s.key} type="button" className={css.screen} aria-pressed={on} disabled={!setup.canEdit || busy} onClick={() => toggle(s.key)}>
          {on ? <Check size={12} aria-hidden="true" /> : null}{s.label}</button>; })}
      </div>
      <div className={css.homeRow}><span className={css.label}>Home</span>
        <select value={r.home ?? ""} disabled={!setup.canEdit || busy} aria-label={`${r.name}: home`} onChange={(e) => void run(r.id, `roles/${r.id}`, { home: e.target.value || null })}>
          <option value="">As their access gives</option><option value="dashboard">Dashboard</option><option value="sales">Sales home</option></select>
        <span className={css.label}>Tiles</span>
        <span className={css.tiles}>{r.tiles.map((t) => <span key={t.key} className={css.tile}>{t.label}{setup.canEdit ? <button type="button" aria-label={`Remove the tile ${t.label}`} disabled={busy} onClick={() => void run(r.id, `roles/${r.id}`, { tiles: r.tiles.filter((x) => x.key !== t.key) })}><X size={11} aria-hidden="true" /></button> : null}</span>)}
          {setup.canEdit && !r.tiles.some((t) => t.key === "late") ? <button type="button" className={css.tileAdd} disabled={busy} onClick={() => void run(r.id, `roles/${r.id}`, { tiles: [...r.tiles, { key: "late", label: "Late", of: "mine", late: true, href: "/me/steps" }] })}><Plus size={11} aria-hidden="true" />Late</button> : null}
          {setup.canEdit && !r.tiles.some((t) => t.key === "queue") ? <button type="button" className={css.tileAdd} disabled={busy} onClick={() => void run(r.id, `roles/${r.id}`, { tiles: [...r.tiles, { key: "queue", label: `Open for every ${r.name}`, of: "role", href: "/runs" }] })}><Plus size={11} aria-hidden="true" />The role&apos;s queue</button> : null}
        </span>
      </div>
    </div>
  </li>;
}
