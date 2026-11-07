"use client";
// FLOW-C: the Asset screen (Write · a deliverable with its own ID): the ID on top (project, type, persona, angle, hook,
// version), what it is for (type, persona, the idea and its hooks), the working doc as tabs (script, notes for whoever
// shoots, edits or designs it), its timeline from draft to live with the review verdict, the revision count and the ad
// IDs it maps to. Moving it along its statuses dates each stage; a new version bumps the ID's V number.
import { useEffect, useState } from "react";
import { Check, ClipboardCopy, Clapperboard, GitCommitVertical, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../ui";
import { flow } from "../processes/flow-client";
import { TextEditor } from "./editor";
import { Comments } from "./comments";
import type { Work } from "./work";
import { dayText, str, strList } from "./types";
import css from "./work.module.css";
import m from "./screens.module.css";
import { SelectField } from "../kit/select-field";

type Tab = { title: string; text: string };
const STAGES: { key: string; label: string }[] = [
  { key: "draft", label: "Draft" }, { key: "sent", label: "Sent" }, { key: "confirmed", label: "Confirmed" }, { key: "in_production", label: "Shoot / design" },
  { key: "rough_cut", label: "Rough cut" }, { key: "final", label: "Final" }, { key: "live", label: "Live" },
];

export function AssetScreen({ w }: { w: Work }) {
  const { d } = w, s = d.step, rec = w.rec?.record ?? null, t = w.rec?.type ?? null;
  const data = (rec?.data ?? {}) as Record<string, unknown>;
  const tabs0 = (Array.isArray(data.tabs) ? data.tabs : []) as Tab[];
  const [tab, setTab] = useState(tabs0[0]?.title ?? "Script");
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(tabs0.map((x) => [x.title, str(x.text)])));
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [newTab, setNewTab] = useState("");
  const [fields, setFields] = useState({ persona: str(data.persona), big_idea: str(data.big_idea), angle: str(data.angle), ad_ids: strList(data.ad_ids).join("\n"), final_url: str(data.final_url), verdict: str(data.verdict) });
  const frozen = !!rec?.frozenAt, writable = w.live && !frozen;
  const text = texts[tab] ?? "";
  const { focus } = w;
  useEffect(() => { focus({ label: `the ${tab} tab`, text }); }, [tab, text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rec) return <div className={css.emptyWork}><Clapperboard size={18} aria-hidden="true" /><b>{s.state === "waiting" ? "The asset opens when the step does" : "No asset yet"}</b><span>{s.state === "waiting" ? s.stateText : "Its person opens it."}</span></div>;
  const status = t?.statuses.find((x) => x.key === rec.status);
  const dates = (data.dates ?? {}) as Record<string, string>;
  const personas = w.runRecords.filter((r) => r.type === "persona"), ideas = w.runRecords.filter((r) => r.type === "big_idea");
  const idea = ideas.find((r) => r.id === fields.big_idea) ?? null;
  // Review sessions that had it on their agenda.
  const sessions = w.runRecords.filter((r) => r.type === "session" && Array.isArray(r.data.agenda) && (r.data.agenda as { id?: string }[]).some((x) => x.id === rec.id)).length;
  async function saveTab(n: string) {
    if (!dirty[n]) return true;
    try { await flow(`steps/${s.id}/actions/tab`, "POST", { tab: n, text: texts[n] ?? "" }); setDirty((x) => ({ ...x, [n]: false })); return true; }
    catch { notify({ id: "tab", tone: "error", title: "Not saved", message: "The tab did not save. Try again." }); return false; }
  }
  async function copyId() { try { await navigator.clipboard.writeText(rec!.code ?? ""); notify({ id: "copy", tone: "success", title: "Asset ID copied", timeout: 2000 }); } catch { /* the ID stays on screen */ } }
  const saveFields = () => w.act(`records/${rec.id}`, { data: { persona: fields.persona || null, big_idea: fields.big_idea || null, angle: fields.angle || null, final_url: fields.final_url || null, verdict: fields.verdict || null,
    ad_ids: fields.ad_ids.split("\n").map((x) => x.trim()).filter(Boolean) } }, "Saved");
  const titles = [...tabs0.map((x) => x.title), ...Object.keys(texts).filter((k) => !tabs0.some((x) => x.title === k))];
  return <div className={m.stack}>
    <header className={m.assetHead}>
      <span className={m.assetId}><small>Asset ID</small><code>{rec.code ?? "—"}</code>
        <button type="button" className={css.iconBtn} aria-label="Copy the Asset ID" title="Copy" onClick={() => void copyId()}><ClipboardCopy size={13} /></button></span>
      <span className={css.chip} data-tone={status?.tone ?? "neutral"}>{status?.label ?? rec.statusLabel}</span>
      <span className={m.assetMeta}>{str(data.asset_type) || "Asset"}{data.cut ? ` · ${str(data.cut)}` : ""} · {Number(data.revisions ?? 0)} revision{Number(data.revisions ?? 0) === 1 ? "" : "s"}{frozen ? " · frozen" : ""}</span>
      {writable ? <button type="button" className={styles.btn} disabled={w.busy} onClick={() => void w.act(`steps/${s.id}/actions/version`, {}, "New version")}><GitCommitVertical size={14} aria-hidden="true" />New version</button> : null}
    </header>

    <section className={m.card} aria-label="Timeline">
      <ol className={m.stages}>{STAGES.map((g) => { const at = dates[g.key], current = rec.status === g.key;
        return <li key={g.key} data-on={at ? "" : undefined} data-current={current ? "" : undefined}><i /><b>{g.label}</b><small>{at ? dayText(at) : "—"}</small></li>; })}
        <li data-on={fields.verdict ? "" : undefined}><i /><b>Review verdict</b><small>{fields.verdict || "—"}</small></li></ol>
      <div className={m.row}><small className={css.quiet}>{sessions ? `In ${sessions} review session${sessions > 1 ? "s" : ""}` : "Not in a review session yet"}</small>
        {w.live && status?.next.length ? <span className={css.moves}>{status.next.map((n) => { const to = t?.statuses.find((x) => x.key === n);
          return <button key={n} type="button" disabled={w.busy} data-tone={to?.tone ?? "neutral"} onClick={() => void w.act(`steps/${s.id}/actions/status`, { status: n }, `${to?.label ?? n}: dated today`)}>{to?.label ?? n}</button>; })}</span> : null}</div>
    </section>

    <section className={m.card} aria-label="What it is for">
      <h3>What it is for</h3>
      <div className={m.grid3}>
        <label className={m.lab}>Persona<SelectField value={fields.persona} disabled={!writable} onChange={(e) => setFields({ ...fields, persona: e.target.value })}><option value="">Everyone</option>{personas.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</SelectField></label>
        <label className={m.lab}>Idea<SelectField value={fields.big_idea} disabled={!writable} onChange={(e) => setFields({ ...fields, big_idea: e.target.value })}><option value="">None chosen</option>{ideas.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</SelectField></label>
        <label className={m.lab}>Angle<input value={fields.angle} disabled={!writable} onChange={(e) => setFields({ ...fields, angle: e.target.value })} placeholder="e.g. light, school run" /></label>
      </div>
      {idea ? <div className={m.idea}><b>{idea.title}</b>{str(idea.data.why) ? <p>{str(idea.data.why)}</p> : null}
        {strList(idea.data.hooks).length ? <ol>{strList(idea.data.hooks).map((h, i) => <li key={i}><small>H{String(i + 1).padStart(2, "0")}</small>{h}</li>)}</ol> : <p className={css.quiet}>The idea has no hooks yet.</p>}</div> : null}
      <div className={m.grid2}>
        <label className={m.lab}>Ad IDs it runs as (one per line)<textarea rows={2} value={fields.ad_ids} disabled={!w.live} onChange={(e) => setFields({ ...fields, ad_ids: e.target.value })} placeholder="The ad platform's IDs" /></label>
        <div className={m.col}>
          <label className={m.lab}>Final link<input type="url" value={fields.final_url} disabled={!w.live} onChange={(e) => setFields({ ...fields, final_url: e.target.value })} placeholder="https://" /></label>
          <label className={m.lab}>Review verdict<SelectField value={fields.verdict} disabled={!w.live} onChange={(e) => setFields({ ...fields, verdict: e.target.value })}><option value="">Not yet</option>
            {(t?.fields.find((f) => f.key === "verdict")?.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</SelectField></label>
        </div>
      </div>
      {w.live ? <div className={m.row}><button type="button" className={styles.btn} disabled={w.busy} onClick={() => void saveFields()}>Save</button></div> : null}
    </section>

    <div className={css.docTabs} role="tablist" aria-label="Working doc">{titles.map((n) => <button key={n} type="button" role="tab" aria-selected={tab === n}
      onClick={async () => { await saveTab(tab); setTab(n); }}>{(texts[n] ?? "").trim() ? <Check size={13} aria-hidden="true" /> : <span className={css.dotEmpty} aria-hidden="true" />}{n}</button>)}
      {writable ? <form className={m.newTab} onSubmit={(e) => { e.preventDefault(); const n = newTab.trim(); if (!n || titles.includes(n)) return; setTexts({ ...texts, [n]: "" }); setDirty({ ...dirty, [n]: true }); setTab(n); setNewTab(""); }}>
        <input value={newTab} onChange={(e) => setNewTab(e.target.value)} placeholder="Add a tab" aria-label="Add a tab" maxLength={60} /><button type="submit" className={css.iconBtn} aria-label="Add the tab"><Plus size={14} /></button></form> : null}</div>
    <section className={css.section} aria-label={tab}>
      <div className={css.sectionHead}><h2>{tab}</h2>{dirty[tab] ? <small>Not saved yet</small> : null}</div>
      <TextEditor key={tab} value={text} readOnly={!writable} label={`The ${tab} tab`} onChange={(v) => { setTexts({ ...texts, [tab]: v }); setDirty({ ...dirty, [tab]: true }); }} onBlur={() => void saveTab(tab)}
        placeholder={`Write the ${tab.toLowerCase()} here. Pip, on the right, can critique it against what good looks like.`} />
      {writable ? <div className={css.sectionFoot}><small>{text.trim() ? text.trim().split(/\s+/).length : 0} words</small><button type="button" className={styles.btn} disabled={w.busy || !dirty[tab]} onClick={() => void saveTab(tab)}>Save the tab</button></div> : null}
      <Comments w={w} recordId={rec.id} section={tab} />
    </section>

    {w.live ? <div className={css.finishBar}><span>{status?.label ?? rec.statusLabel} · {rec.code}</span>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy} onClick={async () => { for (const n of titles) await saveTab(n); await w.act(`steps/${s.id}/finish`, {}, "Done: the asset goes to the steps that need it"); }}><Check size={14} aria-hidden="true" />Done</button></div>
      : s.state === "done" ? <p className={css.done}><Check size={14} aria-hidden="true" />Done; the steps that needed it have it.</p> : null}
  </div>;
}
