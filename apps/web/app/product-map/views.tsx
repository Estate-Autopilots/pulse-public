"use client";
// PRODUCT-MAP: the Product map's views: screens, features, user types, issues, ideas, and what the build team and AI
// agents take away (the plan, tokens, the API).
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy, Download, KeyRound, MessageSquare, Plus, Search, ThumbsUp, Trash2, TriangleAlert } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import hq from "../hq/hq.module.css";
import { IDEA_STATUS, ISSUE_KIND, SEVERITY_TONE, pmPost, screenName, secs, when, type Feature, type Idea, type Issue, type MapData, type Persona, type Screen } from "./model";
import { Err, Origin, Tag, tone } from "./workbench";
import css from "./pm.module.css";

type Props = { data: MapData; onSaved: () => void };
const live = (d: MapData) => d.screens.filter((s) => s.status !== "removed");
const KIND_LABEL: Record<string, string> = { button: "Buttons", tab: "Tabs", link: "Links", form: "Forms", field: "Fields", menu: "Menus", dialog: "Dialogs" };

/** Several screens picked from a searchable list. */
export function ScreenPicker({ screens, value, onChange, label = "Screens" }: { screens: Screen[]; value: string[]; onChange: (v: string[]) => void; label?: string }) {
  const [q, setQ] = useState("");
  const hits = screens.filter((s) => !q || `${s.title} ${s.route} ${s.key}`.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  return <div className={css.picker}>
    <label className={css.searchBox}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${label.toLowerCase()}`} aria-label={`Find ${label.toLowerCase()}`} /></label>
    {value.length ? <div className={css.chips}>{value.map((k) => <button key={k} type="button" className={css.chipOn} onClick={() => onChange(value.filter((x) => x !== k))} aria-label={`Remove ${screenName(screens, k)}`}>{screenName(screens, k)} ×</button>)}</div> : null}
    <ul className={css.pickList}>{hits.map((s) => <li key={s.key}><label><input type="checkbox" checked={value.includes(s.key)} onChange={(e) => onChange(e.target.checked ? [...value, s.key] : value.filter((x) => x !== s.key))} />
      <span>{s.title || s.key}</span><code>{s.route || s.key}</code>{s.proposed ? <Tag t="var(--accent)">proposed</Tag> : null}</label></li>)}</ul>
  </div>;
}

// --------------------------------------------------------------------------------------------------------- screens
export function ScreensView({ data, onSaved }: Props) {
  const [q, setQ] = useState(""), [area, setArea] = useState(""), [only, setOnly] = useState<"" | "proposed" | "issues">("");
  const [open, setOpen] = useState<string | null>(null), [adding, setAdding] = useState(false), [more, setMore] = useState(60);
  const areas = useMemo(() => [...new Set(live(data).map((s) => s.area).filter(Boolean))].sort(), [data]);
  const issueScreens = useMemo(() => new Set(data.issues.filter((i) => i.status === "open").map((i) => i.screenKey)), [data.issues]);
  const counts = useMemo(() => { const m = new Map<string, Record<string, number>>(); for (const e of data.elements) { const c = m.get(e.screenId) ?? {}; c[e.kind] = (c[e.kind] ?? 0) + 1; m.set(e.screenId, c); } return m; }, [data.elements]);
  const list = live(data).filter((s) => (!area || s.area === area) && (!q || `${s.title} ${s.route} ${s.purpose}`.toLowerCase().includes(q.toLowerCase()))
    && (only !== "proposed" || s.proposed) && (only !== "issues" || issueScreens.has(s.key)))
    .sort((a, b) => Number(b.proposed) - Number(a.proposed) || (b.use?.views ?? 0) - (a.use?.views ?? 0) || a.key.localeCompare(b.key));
  const screen = data.screens.find((s) => s.id === open) ?? null;
  return <div className={css.stack}>
    <div className={css.toolbar}>
      <label className={css.searchBox}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a screen" aria-label="Find a screen" /></label>
      <select className={hq.input} value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area"><option value="">Every area</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
      <div className={css.seg} role="group" aria-label="Show">{([["", "All"], ["issues", "With issues"], ["proposed", "Proposed"]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)}>{l}</button>)}</div>
      <span className={css.grow} /><button type="button" className={hq.secondary} onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />Propose a screen</button>
    </div>
    <p className={hq.faint}>{list.length} screens{q || area || only ? " match" : ""}. Most used first.</p>
    <div className={css.grid}>{list.slice(0, more).map((s) => { const c = counts.get(s.id) ?? {};
      return <button key={s.id} type="button" className={css.screenCard} data-proposed={s.proposed || undefined} onClick={() => setOpen(s.id)}>
        <span className={css.thumb}>{s.shot ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a screenshot Pulse keeps, served by the API */}
          <img src={`/api/v0/product-map/shots/${s.id}`} alt="" loading="lazy" /></>
          : <span className={css.wire} aria-hidden="true"><i /><i /><i /><b>{c.button ?? 0}</b></span>}</span>
        <span className={css.cardBody}><b>{s.title || s.key}</b><code>{s.route || s.key}</code>
          <span className={css.meta}>{s.proposed ? <Tag t="var(--accent)">proposed</Tag> : null}{issueScreens.has(s.key) ? <Tag t="var(--warn)">issues</Tag> : null}
            {["button", "tab", "link", "field"].filter((k) => c[k]).map((k) => <span key={k}>{c[k]} {KIND_LABEL[k].toLowerCase()}</span>)}
            {s.use?.views ? <span>{s.use.views} visits{s.use.p75Ms ? ` · ${secs(s.use.p75Ms)}` : ""}</span> : null}</span></span>
      </button>; })}</div>
    {list.length > more ? <button type="button" className={hq.secondary} onClick={() => setMore((n) => n + 120)}>Show more ({list.length - more})</button> : null}
    {screen ? <ScreenDrawer data={data} screen={screen} onOpen={(k) => setOpen(data.screens.find((s) => s.key === k)?.id ?? null)} onClose={() => setOpen(null)} onSaved={onSaved} /> : null}
    {adding ? <ProposeScreen data={data} onClose={() => setAdding(false)} onSaved={onSaved} /> : null}
  </div>;
}

function ScreenDrawer({ data, screen, onOpen, onClose, onSaved }: Props & { screen: Screen; onOpen: (key: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState(screen.title), [purpose, setPurpose] = useState(screen.purpose);
  const [kind, setKind] = useState("button"), [label, setLabel] = useState(""), [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const els = data.elements.filter((e) => e.screenId === screen.id);
  const outs = data.edges.filter((e) => e.from === screen.key), ins = data.edges.filter((e) => e.to === screen.key && e.from !== "*");
  const issues = data.issues.filter((i) => i.screenKey === screen.key && i.status === "open");
  const journeys = data.journeys.filter((j) => j.steps.some((s) => s.screen === screen.key));
  const save = async () => { setBusy(true); setError(null); try { await pmPost(`screens/${screen.id}`, { title, purpose }); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); } };
  const addEl = async () => { if (!label.trim()) return; setBusy(true); try { await pmPost(`screens/${screen.id}/elements`, { kind, label, target }); setLabel(""); setTarget(""); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not added"); } finally { setBusy(false); } };
  const removeEl = async (id: string) => { try { await pmPost(`elements/${id}/remove`); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  const remove = async () => { if (!window.confirm(`Remove ${screen.title || screen.key} from the map?`)) return; try { await pmPost(`screens/${screen.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  const go = (k: string) => k !== "*" && data.screens.some((s) => s.key === k) ? <button type="button" className={css.link} onClick={() => onOpen(k)}>{screenName(data.screens, k)}</button> : <span>{k === "*" ? "the menu" : k}</span>;
  return <Drawer className={css.vars} title={screen.title || screen.key} context={<code>{screen.route || screen.key}</code>} size="lg" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || (title === screen.title && purpose === screen.purpose)} onClick={() => void save()}>Save</button>}>
      {screen.proposed || data.canRemove ? <button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}</DrawerFooter>}>
    {screen.shot ? <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a screenshot Pulse keeps, served by the API */}
      <img className={css.shot} src={`/api/v0/product-map/shots/${screen.id}`} alt={`Screenshot of ${screen.title}`} /></> : null}
    <DrawerSection title="About">
      <label className={hq.fieldLabel}>Title<input className={hq.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></label>
      <label className={hq.fieldLabel}>What it is for<textarea className={`${hq.input} ${hq.textarea}`} value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={1000} placeholder="Who opens it and what they get done here" /></label>
      <dl className={css.facts}>
        <div><dt>Open to</dt><dd>{screen.access.length ? screen.access.join(", ") : "everyone signed in"}</dd></div>
        <div><dt>Area</dt><dd>{screen.area || "—"}</dd></div>
        <div><dt>Found by</dt><dd>{screen.sources.join(", ") || "—"}{screen.file ? <> · <code>{screen.file}</code></> : null}</dd></div>
        {screen.use ? <div><dt>Real use</dt><dd>{screen.use.views} visits by {screen.use.people} people in 30 days{screen.use.p75Ms ? `; shows within ${secs(screen.use.p75Ms)} (3 in 4)` : ""}{screen.use.errors ? `; ${screen.use.errors} errors` : ""}</dd></div> : null}
      </dl>
    </DrawerSection>
    {issues.length ? <DrawerSection title={`Issues (${issues.length})`}><ul className={css.issueMini}>{issues.map((i) => <li key={i.id} style={tone(SEVERITY_TONE[i.severity])}><TriangleAlert size={14} aria-hidden="true" /><span><b>{i.title}</b> {i.detail}</span></li>)}</ul></DrawerSection> : null}
    <DrawerSection title={`On this screen (${els.length})`}>
      {Object.entries(KIND_LABEL).map(([k, l]) => { const xs = els.filter((e) => e.kind === k); if (!xs.length) return null;
        return <div key={k} className={css.elGroup}><h4>{l} <small>{xs.length}</small></h4><ul>{xs.slice(0, 80).map((e) => <li key={e.id} data-proposed={e.proposed || undefined}>
          <span>{e.label || <i>no label</i>}</span>{e.target && e.target !== "submit" ? <span className={css.to}><ArrowRight size={12} aria-hidden="true" />{e.target.startsWith("/") ? go(e.target) : e.target}</span> : null}
          {e.destructive ? <Tag t="var(--bad)">changes data</Tag> : null}{e.noHandler ? <Tag t="var(--warn)">may do nothing</Tag> : null}{e.proposed ? <><Tag t="var(--accent)">proposed</Tag><button type="button" className={css.x} onClick={() => void removeEl(e.id)} aria-label={`Remove ${e.label}`}>×</button></> : null}
        </li>)}{xs.length > 80 ? <li className={hq.faint}>+ {xs.length - 80} more</li> : null}</ul></div>; })}
      <div className={css.addRow}><select className={hq.input} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">{Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <input className={hq.input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Propose a button, tab or link" aria-label="Label" />
        <input className={hq.input} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Goes to (optional)" aria-label="Goes to" list="pm-screen-keys" />
        <datalist id="pm-screen-keys">{live(data).slice(0, 300).map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}</datalist>
        <button type="button" className={hq.secondary} disabled={busy || !label.trim()} onClick={() => void addEl()}><Plus size={15} aria-hidden="true" />Add</button></div>
    </DrawerSection>
    <DrawerSection title="Ways in and out">
      <div className={css.twoCol}><div><h4>Leads to</h4><ul className={css.plain}>{outs.length ? outs.slice(0, 40).map((e, i) => <li key={i}>{go(e.to)}{e.kind === "usage" ? <small> · {e.count} moves</small> : e.label ? <small> · “{e.label}”</small> : null}</li>) : <li className={hq.faint}>nothing found</li>}</ul></div>
        <div><h4>Reached from</h4><ul className={css.plain}>{data.edges.some((e) => e.from === "*" && e.to === screen.key) ? <li>the menu</li> : null}{ins.slice(0, 40).map((e, i) => <li key={i}>{go(e.from)}{e.kind === "usage" ? <small> · {e.count} moves</small> : null}</li>)}
          {!ins.length && !data.edges.some((e) => e.from === "*" && e.to === screen.key) ? <li className={hq.faint}>nothing found</li> : null}</ul></div></div>
    </DrawerSection>
    {journeys.length ? <DrawerSection title={`In journeys (${journeys.length})`}><ul className={css.plain}>{journeys.slice(0, 20).map((j) => <li key={j.id}>{j.title}</li>)}</ul></DrawerSection> : null}
  </Drawer>;
}

function ProposeScreen({ data, onClose, onSaved }: Props & { onClose: () => void }) {
  const [title, setTitle] = useState(""), [route, setRoute] = useState(""), [purpose, setPurpose] = useState(""), [area, setArea] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const save = async () => { setBusy(true); setError(null); try { await pmPost(`products/${data.product.id}/screens`, { title, route, purpose, area }); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not added"); setBusy(false); } };
  return <Drawer className={css.vars} title="Propose a screen" size="md" onClose={onClose} footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || title.trim().length < 2} onClick={() => void save()}>Add to the map</button>} />}>
    <p className={css.small}>A screen to build. It shows as proposed until the code has it; then it becomes live on its own.</p>
    <label className={hq.fieldLabel}>Name<input className={hq.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Track an order" autoFocus maxLength={160} /></label>
    <label className={hq.fieldLabel}>Address (optional)<input className={hq.input} value={route} onChange={(e) => setRoute(e.target.value)} placeholder="/orders/:id/track" /></label>
    <label className={hq.fieldLabel}>Area (optional)<input className={hq.input} value={area} onChange={(e) => setArea(e.target.value)} maxLength={80} /></label>
    <label className={hq.fieldLabel}>What it is for<textarea className={`${hq.input} ${hq.textarea}`} value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} maxLength={1000} /></label>
  </Drawer>;
}

// -------------------------------------------------------------------------------------------------------- features
export function FeaturesView({ data, onSaved }: Props) {
  const [open, setOpen] = useState<Feature | "new" | null>(null);
  return <div className={css.stack}>
    <div className={css.toolbar}><p className={hq.faint}>What the app can do, as groups of screens. Pulse starts from the screens’ areas; rename, merge and add your own.</p><span className={css.grow} />
      <button type="button" className={hq.secondary} onClick={() => setOpen("new")}><Plus size={15} aria-hidden="true" />Feature</button></div>
    <div className={css.list}>{data.features.map((f) => <button key={f.id} type="button" className={css.rowCard} onClick={() => setOpen(f)}>
      <span className={css.rowMain}><b>{f.name}{f.proposed ? <> <Tag t="var(--accent)">proposed</Tag></> : null}</b>{f.description ? <span>{f.description}</span> : null}
        <span className={css.chips}>{f.screens.slice(0, 6).map((k) => <i key={k}>{screenName(data.screens, k)}</i>)}{f.screens.length > 6 ? <i>+{f.screens.length - 6}</i> : null}</span></span>
      <span className={css.rowSide}><Origin origin={f.origin} /><small>{f.screens.length} screens</small></span></button>)}</div>
    {!data.features.length ? <p className={hq.faint}>No features yet: connect a source, or add one.</p> : null}
    {open ? <FeatureDrawer data={data} feature={open === "new" ? null : open} onClose={() => setOpen(null)} onSaved={onSaved} /> : null}
  </div>;
}
function FeatureDrawer({ data, feature, onClose, onSaved }: Props & { feature: Feature | null; onClose: () => void }) {
  const [name, setName] = useState(feature?.name ?? ""), [description, setDescription] = useState(feature?.description ?? ""), [screens, setScreens] = useState<string[]>(feature?.screens ?? []), [proposed, setProposed] = useState(feature?.proposed ?? false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const save = async () => { setBusy(true); setError(null);
    try { if (feature) await pmPost(`features/${feature.id}`, { name, description, screens, proposed }); else await pmPost(`products/${data.product.id}/features`, { name, description, screens, proposed }); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); } };
  const remove = async () => { if (!feature || !window.confirm(`Remove ${feature.name}?`)) return; try { await pmPost(`features/${feature.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  return <Drawer className={css.vars} title={feature ? feature.name : "New feature"} size="lg" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || !name.trim()} onClick={() => void save()}>Save</button>}>
      {feature && data.canRemove ? <button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}</DrawerFooter>}>
    <label className={hq.fieldLabel}>Name<input className={hq.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus={!feature} /></label>
    <label className={hq.fieldLabel}>What it does<textarea className={`${hq.input} ${hq.textarea}`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} /></label>
    <label className={css.check}><input type="checkbox" checked={proposed} onChange={(e) => setProposed(e.target.checked)} />Proposed (to build)</label>
    <DrawerSection title={`Screens (${screens.length})`}><ScreenPicker screens={live(data)} value={screens} onChange={setScreens} /></DrawerSection>
  </Drawer>;
}

// ------------------------------------------------------------------------------------------------------ user types
export function UsersView({ data, onSaved }: Props) {
  const [open, setOpen] = useState<Persona | "new" | null>(null);
  const total = live(data).filter((s) => !s.proposed).length;
  const feat = (k: string) => data.features.find((f) => f.key === k)?.name ?? k;
  return <div className={css.stack}>
    <div className={css.toolbar}><p className={hq.faint}>{data.personas.length} kinds of user. Pulse starts from the app’s roles and real use; the AI pass adds age group, skill level and goals. Edit any of it: what you change stays yours.</p><span className={css.grow} />
      <button type="button" className={hq.secondary} onClick={() => setOpen("new")}><Plus size={15} aria-hidden="true" />User type</button></div>
    <div className={css.people}>{data.personas.map((p) => <article key={p.id} className={css.person}>
      <header><div><h3>{p.name}</h3>{p.role ? <code>{p.role}</code> : null}</div><Origin origin={p.origin} confidence={p.confidence} /></header>
      {p.description ? <p>{p.description}</p> : null}
      <dl className={css.traits}>
        <div><dt>Age group</dt><dd>{p.ageGroup || "—"}</dd></div><div><dt>Skill</dt><dd>{p.skillLevel || "—"}</dd></div><div><dt>Tech comfort</dt><dd>{p.techComfort || "—"}</dd></div>
        <div><dt>How often</dt><dd>{p.frequency || "—"}</dd></div><div><dt>Device</dt><dd>{p.device || "—"}</dd></div><div><dt>Opens</dt><dd>{p.permissions.length ? `${p.permissions.length} of ${total}` : "every"} screen{p.permissions.length === 1 ? "" : "s"}</dd></div>
      </dl>
      {p.goals.length ? <ul className={css.goals}>{p.goals.map((g, i) => <li key={i}>{g}</li>)}</ul> : null}
      {p.features.length ? <div className={css.chips}>{p.features.slice(0, 10).map((k) => <i key={k}>{feat(k)}</i>)}{p.features.length > 10 ? <i>+{p.features.length - 10}</i> : null}</div> : null}
      {p.evidence.length ? <details className={css.evidence}><summary>Why Pulse thinks so ({p.evidence.length})</summary><ul>{p.evidence.map((e, i) => <li key={i}><Tag>{e.kind}</Tag> {e.text}{e.ref ? <code> {e.ref}</code> : null}</li>)}</ul></details> : null}
      <footer><span className={hq.faint}>{data.journeys.filter((j) => j.personaKey === p.key).length} journeys</span><button type="button" className={hq.secondary} onClick={() => setOpen(p)}>Edit</button></footer>
    </article>)}</div>
    {open ? <PersonaDrawer data={data} persona={open === "new" ? null : open} onClose={() => setOpen(null)} onSaved={onSaved} /> : null}
  </div>;
}
function PersonaDrawer({ data, persona, onClose, onSaved }: Props & { persona: Persona | null; onClose: () => void }) {
  const [f, setF] = useState({ name: persona?.name ?? "", role: persona?.role ?? "", description: persona?.description ?? "", goals: (persona?.goals ?? []).join("\n"), ageGroup: persona?.ageGroup ?? "",
    skillLevel: persona?.skillLevel ?? "", techComfort: persona?.techComfort ?? "", frequency: persona?.frequency ?? "", device: persona?.device ?? "" });
  const [features, setFeatures] = useState<string[]>(persona?.features ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => { setBusy(true); setError(null); const body = { ...f, goals: f.goals.split("\n").map((g) => g.trim()).filter(Boolean), features };
    try { if (persona) await pmPost(`personas/${persona.id}`, body); else await pmPost(`products/${data.product.id}/personas`, body); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); } };
  const remove = async () => { if (!persona || !window.confirm(`Remove ${persona.name}?`)) return; try { await pmPost(`personas/${persona.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  const sel = (k: keyof typeof f, label: string, opts: string[]) => <label className={hq.fieldLabel}>{label}<select className={hq.input} value={f[k]} onChange={set(k)}><option value="">—</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>;
  return <Drawer className={css.vars} title={persona ? persona.name : "New user type"} size="lg" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || !f.name.trim()} onClick={() => void save()}>Save</button>}>
      {persona && data.canRemove ? <button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}</DrawerFooter>}>
    <div className={css.row2}><label className={hq.fieldLabel}>Name<input className={hq.input} value={f.name} onChange={set("name")} maxLength={120} /></label>
      <label className={hq.fieldLabel}>Role in the app<input className={hq.input} value={f.role} onChange={set("role")} maxLength={80} placeholder="admin, member…" /></label></div>
    <label className={hq.fieldLabel}>Who they are<textarea className={`${hq.input} ${hq.textarea}`} value={f.description} onChange={set("description")} rows={2} maxLength={1000} /></label>
    <div className={css.row3}><label className={hq.fieldLabel}>Age group<input className={hq.input} value={f.ageGroup} onChange={set("ageGroup")} placeholder="25-40" maxLength={40} /></label>
      {sel("skillLevel", "Skill with the work", ["beginner", "intermediate", "expert"])}{sel("techComfort", "Tech comfort", ["low", "medium", "high"])}</div>
    <div className={css.row2}>{sel("frequency", "How often", ["daily", "weekly", "monthly", "rarely"])}{sel("device", "Device", ["phone", "desktop", "both"])}</div>
    <label className={hq.fieldLabel}>Goals (one per line)<textarea className={`${hq.input} ${hq.textarea}`} value={f.goals} onChange={set("goals")} rows={3} /></label>
    <DrawerSection title="Features they need"><div className={css.chips}>{data.features.map((x) => <button key={x.key} type="button" className={features.includes(x.key) ? css.chipOn : css.chipOff} aria-pressed={features.includes(x.key)}
      onClick={() => setFeatures((v) => v.includes(x.key) ? v.filter((k) => k !== x.key) : [...v, x.key])}>{x.name}</button>)}</div></DrawerSection>
  </Drawer>;
}

// ---------------------------------------------------------------------------------------------------------- issues
export function IssuesView({ data, onSaved }: Props) {
  const [status, setStatus] = useState("open"), [kind, setKind] = useState(""), [error, setError] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const list = data.issues.filter((i) => (status === "all" || i.status === status) && (!kind || i.kind === kind));
  const kinds = [...new Set(data.issues.filter((i) => status === "all" || i.status === status).map((i) => i.kind))];
  const act = async (i: Issue, next: string) => { setError(null); try { await pmPost(`issues/${i.id}`, { status: next }); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } };
  const idea = async (i: Issue) => { setError(null); try { await pmPost(`products/${data.product.id}/ideas`, { title: `Fix: ${i.title}`.slice(0, 200), body: i.detail, kind: "fix", screens: i.screenKey ? [i.screenKey] : [], issueId: i.id, priority: i.severity === "high" ? "now" : "next" }); await pmPost(`issues/${i.id}`, { status: "accepted" }); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not added"); } };
  return <div className={css.stack}>
    <div className={css.toolbar}>
      <div className={css.seg} role="group" aria-label="Status">{[["open", "Open"], ["accepted", "Accepted"], ["fixed", "Fixed"], ["dismissed", "Dismissed"], ["all", "All"]].map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setKind(""); }}>{l}</button>)}</div>
      <select className={hq.input} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">Every kind</option>{kinds.map((k) => <option key={k} value={k}>{ISSUE_KIND[k] ?? k}</option>)}</select>
      <span className={css.grow} /><button type="button" className={hq.secondary} onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />Issue</button>
    </div>
    <Err text={error} />
    <ul className={css.issues}>{list.slice(0, 200).map((i) => <li key={i.id} style={tone(SEVERITY_TONE[i.severity])} data-status={i.status}>
      <span className={css.sev} title={i.severity} />
      <div className={css.issueMain}><b>{i.title}</b><span>{i.detail}</span>
        <span className={css.meta}><Tag>{ISSUE_KIND[i.kind] ?? i.kind}</Tag><Tag t={SEVERITY_TONE[i.severity]}>{i.severity}</Tag><Origin origin={i.origin} confidence={i.confidence} />{i.screenKey ? <code>{i.screenKey}</code> : null}</span>
        {i.evidence.length ? <details className={css.evidence}><summary>Evidence</summary><ul>{i.evidence.map((e, n) => <li key={n}><Tag>{e.kind}</Tag> {e.text}{e.ref ? <code> {e.ref}</code> : null}</li>)}</ul></details> : null}</div>
      <span className={css.rowActions}>{i.status === "open" ? <><button type="button" className={hq.secondary} onClick={() => void idea(i)}>Make it an idea</button><button type="button" className={hq.ghost} onClick={() => void act(i, "fixed")}><Check size={14} aria-hidden="true" />Fixed</button>
        <button type="button" className={hq.ghost} onClick={() => void act(i, "dismissed")}>Dismiss</button></> : <button type="button" className={hq.ghost} onClick={() => void act(i, "open")}>Reopen</button>}</span>
    </li>)}</ul>
    {!list.length ? <p className={hq.faint}>Nothing here.</p> : list.length > 200 ? <p className={hq.faint}>Showing 200 of {list.length}: filter by kind to see the rest.</p> : null}
    {adding ? <IssueDrawer data={data} onClose={() => setAdding(false)} onSaved={onSaved} /> : null}
  </div>;
}
function IssueDrawer({ data, onClose, onSaved }: Props & { onClose: () => void }) {
  const [title, setTitle] = useState(""), [detail, setDetail] = useState(""), [kind, setKind] = useState("other"), [severity, setSeverity] = useState("medium"), [screenKey, setScreenKey] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const save = async () => { setBusy(true); try { await pmPost(`products/${data.product.id}/issues`, { title, detail, kind, severity, screenKey }); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not added"); setBusy(false); } };
  return <Drawer className={css.vars} title="Report an issue" size="md" onClose={onClose} footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || title.trim().length < 3} onClick={() => void save()}>Add</button>} />}>
    <label className={hq.fieldLabel}>What is wrong<input className={hq.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></label>
    <label className={hq.fieldLabel}>Details<textarea className={`${hq.input} ${hq.textarea}`} value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} maxLength={2000} /></label>
    <div className={css.row3}><label className={hq.fieldLabel}>Kind<select className={hq.input} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(ISSUE_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className={hq.fieldLabel}>Severity<select className={hq.input} value={severity} onChange={(e) => setSeverity(e.target.value)}>{["high", "medium", "low"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      <label className={hq.fieldLabel}>Screen<select className={hq.input} value={screenKey} onChange={(e) => setScreenKey(e.target.value)}><option value="">—</option>{live(data).map((s) => <option key={s.key} value={s.key}>{screenName(data.screens, s.key)}</option>)}</select></label></div>
  </Drawer>;
}

// ----------------------------------------------------------------------------------------------------------- ideas
export function IdeasView({ data, onSaved }: Props) {
  const [open, setOpen] = useState<Idea | "new" | null>(null), [error, setError] = useState<string | null>(null);
  const vote = async (i: Idea) => { try { await pmPost(`ideas/${i.id}/vote`); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } };
  const cols = IDEA_STATUS.filter((s) => s.key !== "parked");
  const version = (id: string | null) => data.versions.find((v) => v.id === id)?.label;
  return <div className={css.stack}>
    <div className={css.toolbar}><p className={hq.faint}>Ideas and planned changes for the next versions. Vote, comment, give each a priority and the version it goes in.</p><span className={css.grow} />
      <button type="button" className={hq.primary} onClick={() => setOpen("new")}><Plus size={15} aria-hidden="true" />Idea</button></div>
    <Err text={error} />
    <div className={css.board}>{cols.map((c) => { const xs = data.ideas.filter((i) => i.status === c.key).sort((a, b) => b.votes - a.votes);
      return <section key={c.key} className={css.lane} aria-label={c.label}><h3>{c.label} <small>{xs.length}</small></h3>
        {xs.map((i) => <article key={i.id} className={css.idea}>
          <button type="button" className={css.ideaMain} onClick={() => setOpen(i)}><b>{i.title}</b>{i.body ? <span>{i.body.slice(0, 160)}</span> : null}
            <span className={css.meta}><Tag>{i.kind}</Tag><Tag t={i.priority === "now" ? "var(--bad)" : i.priority === "next" ? "var(--warn)" : "var(--faint)"}>{i.priority}</Tag>{version(i.targetVersionId) ? <Tag t="var(--good)">{version(i.targetVersionId)}</Tag> : null}{i.origin === "ai" ? <Origin origin="ai" /> : null}</span></button>
          <footer><button type="button" className={css.vote} aria-pressed={i.voted} onClick={() => void vote(i)}><ThumbsUp size={13} aria-hidden="true" />{i.votes}</button>
            <span className={hq.faint}><MessageSquare size={13} aria-hidden="true" /> {data.comments.filter((m) => m.ideaId === i.id).length}</span><span className={hq.faint}>{i.by ?? ""}</span></footer>
        </article>)}{!xs.length ? <p className={hq.faint}>—</p> : null}</section>; })}</div>
    {data.ideas.some((i) => i.status === "parked") ? <details className={css.evidence}><summary>Parked ({data.ideas.filter((i) => i.status === "parked").length})</summary><ul>{data.ideas.filter((i) => i.status === "parked").map((i) => <li key={i.id}><button type="button" className={css.link} onClick={() => setOpen(i)}>{i.title}</button></li>)}</ul></details> : null}
    {open ? <IdeaDrawer data={data} idea={open === "new" ? null : open} onClose={() => setOpen(null)} onSaved={onSaved} /> : null}
  </div>;
}
function IdeaDrawer({ data, idea, onClose, onSaved }: Props & { idea: Idea | null; onClose: () => void }) {
  const [f, setF] = useState({ title: idea?.title ?? "", body: idea?.body ?? "", kind: idea?.kind ?? "change", priority: idea?.priority ?? "next", status: idea?.status ?? "new", targetVersionId: idea?.targetVersionId ?? "", personaKey: idea?.personaKey ?? "" });
  const [screens, setScreens] = useState<string[]>(idea?.screens ?? []), [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => { setBusy(true); setError(null); const body = { ...f, targetVersionId: f.targetVersionId || null, screens };
    try { if (idea) await pmPost(`ideas/${idea.id}`, body); else await pmPost(`products/${data.product.id}/ideas`, body); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); } };
  const say = async () => { if (!idea || !comment.trim()) return; try { await pmPost(`ideas/${idea.id}/comments`, { body: comment }); setComment(""); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } };
  const remove = async () => { if (!idea || !window.confirm(`Remove “${idea.title}”?`)) return; try { await pmPost(`ideas/${idea.id}/remove`); onSaved(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  const canRemove = idea && (data.canRemove || idea.byId === data.me);
  return <Drawer className={css.vars} title={idea ? "Idea" : "New idea"} size="lg" onClose={onClose}
    footer={<DrawerFooter status={error ?? undefined} primary={<button type="button" className={hq.primary} disabled={busy || f.title.trim().length < 2} onClick={() => void save()}>Save</button>}>
      {canRemove ? <button type="button" className={css.danger} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" />Remove</button> : null}</DrawerFooter>}>
    <label className={hq.fieldLabel}>Idea<input className={hq.input} value={f.title} onChange={set("title")} maxLength={200} autoFocus={!idea} placeholder="One-tap reorder from the order page" /></label>
    <label className={hq.fieldLabel}>Why and how<textarea className={`${hq.input} ${hq.textarea}`} value={f.body} onChange={set("body")} rows={4} maxLength={4000} /></label>
    <div className={css.row3}>
      <label className={hq.fieldLabel}>Kind<select className={hq.input} value={f.kind} onChange={set("kind")}>{["screen", "feature", "journey", "change", "fix"].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      <label className={hq.fieldLabel}>Priority<select className={hq.input} value={f.priority} onChange={set("priority")}>{["now", "next", "later"].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      <label className={hq.fieldLabel}>Status<select className={hq.input} value={f.status} onChange={set("status")}>{IDEA_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label></div>
    <div className={css.row2}>
      <label className={hq.fieldLabel}>For version<select className={hq.input} value={f.targetVersionId} onChange={set("targetVersionId")}><option value="">Not yet</option>{data.versions.map((v) => <option key={v.id} value={v.id}>{v.label}{v.title ? ` · ${v.title}` : ""}</option>)}</select></label>
      <label className={hq.fieldLabel}>For user type<select className={hq.input} value={f.personaKey} onChange={set("personaKey")}><option value="">Everyone</option>{data.personas.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label></div>
    {!data.versions.length ? <p className={css.small}>Versions come from Product Story: <a className={css.link} href={`/story?product=${data.product.id}`}>add the next version there</a>.</p> : null}
    <DrawerSection title={`Screens (${screens.length})`}><ScreenPicker screens={live(data)} value={screens} onChange={setScreens} /></DrawerSection>
    {idea ? <DrawerSection title="Comments"><ul className={css.comments}>{data.comments.filter((m) => m.ideaId === idea.id).map((m) => <li key={m.id}><b>{m.by ?? "Someone"}</b> <small>{when(m.createdAt)}</small><p>{m.body}</p></li>)}</ul>
      <div className={css.addRow}><input className={hq.input} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" aria-label="Comment" maxLength={2000} /><button type="button" className={hq.secondary} disabled={!comment.trim()} onClick={() => void say()}>Send</button></div></DrawerSection> : null}
  </Drawer>;
}

// ------------------------------------------------------------------------------------------- build team and agents
export function BuildView({ data, onSaved }: Props) {
  const [version, setVersion] = useState(""), [md, setMd] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState("");
  const [name, setName] = useState(""), [push, setPush] = useState(false), [fresh, setFresh] = useState<string | null>(null);
  const q = version ? `&version=${version}` : "";
  const planUrl = (fmt: string) => `/api/v0/product-map/products/${data.product.id}/plan?format=${fmt}${q}`;
  const show = async () => { setError(null); try { const r = await fetch(planUrl("md"), { cache: "no-store" }); if (!r.ok) throw new Error("The plan could not be read"); setMd(await r.text()); } catch (e) { setError(e instanceof Error ? e.message : "Not read"); } };
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1600); } catch { setError("Copy did not work here: select the text instead."); } };
  const make = async () => { setError(null); try { const r = await pmPost<{ token: string }>(`products/${data.product.id}/tokens`, { name, canPush: push, days: 90 }); setFresh(r.token); setName(""); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not made"); } };
  const revoke = async (id: string) => { if (!window.confirm("Revoke this token? Tools using it stop at once.")) return; try { await pmPost(`tokens/${id}/revoke`); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not revoked"); } };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const planned = data.journeys.filter((j) => version ? j.targetVersionId === version : j.status === "planned");
  return <div className={css.stack}>
    <section className={css.card} aria-label="The plan">
      <div className={css.cardHead}><h3>The plan for the build team</h3></div>
      <p className={css.small}>The journeys to build with their steps, every screen they touch with its elements (proposed ones marked), acceptance criteria, the ideas and the open issues on those screens. As Markdown for people and agents that read text, as JSON for tools.</p>
      <div className={css.toolbar}><select className={hq.input} value={version} onChange={(e) => { setVersion(e.target.value); setMd(null); }} aria-label="Which plan">
        <option value="">Planned journeys</option>{data.versions.map((v) => <option key={v.id} value={v.id}>For {v.label}{v.title ? ` · ${v.title}` : ""}</option>)}</select>
        <span className={hq.faint}>{planned.length} journeys</span><span className={css.grow} />
        <button type="button" className={hq.secondary} onClick={() => void show()}>Show Markdown</button>
        <a className={hq.secondary} href={planUrl("json")} download={`${data.product.name.replace(/[^\w-]+/g, "-")}-plan.json`}><Download size={15} aria-hidden="true" />JSON</a></div>
      {md !== null ? <div className={css.mdBox}><button type="button" className={hq.secondary} onClick={() => void copy(md, "md")}><Copy size={14} aria-hidden="true" />{copied === "md" ? "Copied" : "Copy"}</button><pre>{md}</pre></div> : null}
    </section>
    {data.canRemove ? <section className={css.card} aria-label="Tokens">
      <div className={css.cardHead}><h3><KeyRound size={16} aria-hidden="true" /> Tokens for tools and AI agents</h3></div>
      <p className={css.small}>A token reads this app’s map and plan (and, if allowed, pushes a manifest or adds ideas). It never reaches anything else in Pulse.</p>
      <div className={css.addRow}><input className={hq.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Who uses it: Paperclip, Claude Code, CI…" aria-label="Token name" maxLength={80} />
        <label className={css.check}><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />May push</label>
        <button type="button" className={hq.primary} disabled={name.trim().length < 2} onClick={() => void make()}>Make a token</button></div>
      {fresh ? <div className={css.fresh}><b>Copy it now: it is shown once.</b><code>{fresh}</code><button type="button" className={hq.secondary} onClick={() => void copy(fresh, "token")}><Copy size={14} aria-hidden="true" />{copied === "token" ? "Copied" : "Copy"}</button></div> : null}
      {data.tokens.length ? <ul className={css.sources}>{data.tokens.map((t) => <li key={t.id} data-status={t.revokedAt ? "failed" : "ok"}><span className={css.srcIcon}><KeyRound size={16} aria-hidden="true" /></span>
        <div><b>{t.name}</b><span>{t.canPush ? "reads and pushes" : "reads"} · made {when(t.createdAt)} · {t.revokedAt ? `revoked ${when(t.revokedAt)}` : `ends ${when(t.expiresAt)}`} · used {when(t.lastUsedAt)}</span></div>
        {!t.revokedAt ? <span className={css.rowActions}><button type="button" className={hq.ghost} onClick={() => void revoke(t.id)}>Revoke</button></span> : null}</li>)}</ul> : null}
    </section> : null}
    <section className={css.card} aria-label="For AI agents">
      <div className={css.cardHead}><h3>For AI agents (MCP-friendly)</h3></div>
      <p className={css.small}>Send <code>Authorization: Bearer &lt;token&gt;</code> and nothing else. On this server agents can also call the API directly.</p>
      <Code text={[`# the tools, as an MCP server would list them`, `curl -s -H "Authorization: Bearer $PULSE_MAP_TOKEN" ${origin}/api/v0/product-map/feed/tools`, ``,
        `# the plan to build next, as Markdown (or format=json)`, `curl -s -H "Authorization: Bearer $PULSE_MAP_TOKEN" "${origin}/api/v0/product-map/feed/plan?format=md"`, ``,
        `# the whole map: screens, elements, links, features, user types, journeys, issues, ideas`, `curl -s -H "Authorization: Bearer $PULSE_MAP_TOKEN" ${origin}/api/v0/product-map/feed/map`, ``,
        `# after a build: push what the app has now (a token that may push)`, `node services/api/dist/product-map-scan.js . apps/web > map.json`,
        `curl -s -X POST -H "Authorization: Bearer $PULSE_MAP_TOKEN" -H "content-type: application/json" --data @map.json ${origin}/api/v0/product-map/feed/manifest`].join("\n")} onCopy={(t) => void copy(t, "curl")} copied={copied === "curl"} />
    </section>
    <section className={css.card} aria-label="Manifest schema">
      <div className={css.cardHead}><h3>The manifest an app can publish</h3></div>
      <p className={css.small}>Publish it at <code>/.well-known/pulse-product-map.json</code> or push it. Every field but <code>screens</code> is optional.</p>
      <Code text={MANIFEST_EXAMPLE} onCopy={(t) => void copy(t, "schema")} copied={copied === "schema"} />
    </section>
    <Err text={error} />
  </div>;
}
function Code({ text, onCopy, copied }: { text: string; onCopy: (t: string) => void; copied: boolean }): ReactNode {
  return <div className={css.mdBox}><button type="button" className={hq.secondary} onClick={() => onCopy(text)}><Copy size={14} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button><pre>{text}</pre></div>;
}
const MANIFEST_EXAMPLE = JSON.stringify({
  schema: "pulse-product-map/1", app: { name: "Your app", baseUrl: "https://app.example.com", kind: "web" },
  roles: [{ key: "member", name: "Member", description: "Uses the app every day" }, { key: "admin", name: "Admin" }], entries: ["/"],
  screens: [{ key: "/orders", route: "/orders", title: "Orders", purpose: "See and open orders", area: "Orders", access: ["member", "admin"],
    elements: [{ kind: "button", label: "New order", target: "", destructive: false }, { kind: "link", label: "Open order", target: "/orders/:id" }, { kind: "tab", label: "Open" }] }],
  edges: [{ from: "*", to: "/orders", kind: "nav", label: "Orders" }, { from: "/orders", to: "/orders/:id", kind: "link" }],
  features: [{ key: "orders", name: "Orders", screens: ["/orders", "/orders/:id"] }],
  personas: [{ key: "shop-owner", name: "Shop owner", role: "admin", ageGroup: "30-50", skillLevel: "intermediate", techComfort: "medium", goals: ["Know today's orders"] }],
  journeys: [{ title: "Find an order", personaKey: "shop-owner", status: "planned", steps: [{ screen: "/orders", action: "Opens Orders", expected: "Today's orders show" }] }],
}, null, 2);

