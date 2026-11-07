"use client";
// FLOW-D (owner, 21 Oct 2026: "it makes no sense how it is to be started"): a new process has three doors. Describe it
// (type or paste how the work goes, or pick a write-up; Pip drafts the steps, who and when, and you edit them), start
// from a template, or blank (an empty list with three steps to begin). Then it opens as a list of steps.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, BookOpenText, Briefcase, Building, Building2, Check, LayoutTemplate, Megaphone, PenLine, Plus, Search, Sparkles, Stethoscope, Sun, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { FlowDef } from "../flow-types";
import css from "./new.module.css";

/** FLOW-E: the industry pack a template comes with; the company's own pack's templates come first ("ours"). */
export type Template = { key: string; name: string; summary: string; steps: number; terms?: { run?: string } | null; pack?: { key: string; name: string; icon: string } | null; ours?: boolean };
export type WriteupChoice = { id: string; name: string; summary: string | null; sections: number; steps: number };
type Door = "describe" | "template" | "blank";
type Draft = { definition: FlowDef; notes: string[]; from: string | null };

const PACK_ICONS: Record<string, LucideIcon> = { sun: Sun, "building-2": Building2, megaphone: Megaphone, briefcase: Briefcase, stethoscope: Stethoscope, building: Building };
const iconFor = (t: Template) => /^blank$/i.test(t.key) ? Plus : PACK_ICONS[t.pack?.icon ?? ""] ?? LayoutTemplate;
const EXAMPLE = "When a new lead comes in, the sales executive calls them within a day. Then the site surveyor visits the site and takes photos of the roof and the meter. The sales executive sends the quotation within 2 days. If the customer approves, the install team installs the panels; otherwise the sales executive follows up. Accounts makes the tax invoice.";

export function NewProcess({ templates, writeups, flowReady, initial }: { templates: Template[] | null; writeups: WriteupChoice[]; flowReady: boolean; initial: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(""), [busy, setBusy] = useState(false), [q, setQ] = useState(""), [all, setAll] = useState(false);
  const [door, setDoor] = useState<Door | null>(initial ? "describe" : null);
  const [text, setText] = useState(""), [sop, setSop] = useState<string | null>(initial), [tpl, setTpl] = useState<string | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const list = useMemo(() => (templates ?? []).filter((t) => !/^blank$/i.test(t.key)), [templates]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = writeups.filter((w) => words.every((x) => `${w.name} ${w.summary ?? ""}`.toLowerCase().includes(x)));
  const shown = all || q ? found : found.slice(0, 5);
  const title = name.trim();

  async function read() {
    setBusy(true);
    try {
      const r = sop ? await flow<{ definition: FlowDef; source: string }>("propose", "POST", { from: sop }).then((x) => ({ definition: x.definition, notes: [x.source, `${x.definition.steps.length} steps. Nothing runs until you press Go live.`] }))
        : await flow<{ definition: FlowDef; notes: string[] }>("describe", "POST", { text, title: title || "what you wrote" });
      setDraft({ ...r, from: sop });
    } catch (e) { notify({ id: "new-process", tone: "error", title: "Pip could not read it", message: why(e) }); }
    finally { setBusy(false); }
  }

  async function make() {
    if (!door) return;
    setBusy(true);
    try {
      if (!flowReady) {
        const r = await post<{ id: string }>("workflows", { name: title || "New process", definition: { steps: [{ id: "s1", title: "First step", assign: { by: "starter" } }] }, trigger: { kind: "manual" } });
        router.push(`/sops/workflows/${r.id}`); return;
      }
      let id: string;
      if (door === "template" && tpl) id = (await flow<{ id: string }>("processes", "POST", { template: tpl, name: title || undefined })).id;
      else if (door === "describe" && draft?.from) {
        // A write-up the company has: the process keeps it as its write-up, with Pip's steps.
        id = (await flow<{ id: string }>("processes", "POST", { from: draft.from, name: title || undefined })).id;
        await flow(`processes/${encodeURIComponent(id)}`, "POST", { definition: draft.definition });
      } else if (door === "describe" && draft) {
        id = (await flow<{ id: string }>("processes", "POST", { name: title || "New process", definition: draft.definition, writeup: [{ key: "how-it-goes", title: "How the work goes", body: text }] })).id;
      } else id = (await flow<{ id: string }>("processes", "POST", { name: title || "New process", definition: { version: 2, fields: [], roles: [], stages: [], steps: [], wires: [], rules: [] } })).id;
      router.push(`/processes/${encodeURIComponent(id)}`);
    } catch (e) { notify({ id: "new-process", tone: "error", title: "Not made", message: why(e) }); setBusy(false); }
  }

  const ready = door === "blank" || (door === "template" && !!tpl) || (door === "describe" && !!draft);
  return <div className={css.wrap}>
    <label className={css.name}><span>What is it called?</span>
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="e.g. Solar install, Client onboarding" autoFocus /></label>

    <section className={css.section} aria-labelledby="how-start"><h2 id="how-start">How do you want to make it?</h2>
      <div className={css.doors} role="radiogroup" aria-label="How to make it">
        <button type="button" role="radio" aria-checked={door === "describe"} className={css.door} onClick={() => setDoor("describe")}>
          <span className={css.tIcon}><Sparkles size={20} aria-hidden="true" /></span><span className={css.tText}><b>Describe it</b><small>Type or paste how the work goes, or pick a write-up. Pip drafts the steps, who does each and when; you change what is wrong.</small></span>
          {door === "describe" ? <Check className={css.tick} size={16} aria-hidden="true" /> : null}</button>
        <button type="button" role="radio" aria-checked={door === "template"} className={css.door} onClick={() => setDoor("template")}>
          <span className={css.tIcon}><LayoutTemplate size={20} aria-hidden="true" /></span><span className={css.tText}><b>Start from a template</b><small>A whole way of working, ready to change: its stages, steps, people and due days.</small></span>
          {door === "template" ? <Check className={css.tick} size={16} aria-hidden="true" /> : null}</button>
        <button type="button" role="radio" aria-checked={door === "blank"} className={css.door} data-blank="" onClick={() => setDoor("blank")}>
          <span className={css.tIcon}><Plus size={20} aria-hidden="true" /></span><span className={css.tText}><b>Blank</b><small>An empty list: say how it starts, then add the steps one under another.</small></span>
          {door === "blank" ? <Check className={css.tick} size={16} aria-hidden="true" /> : null}</button>
      </div>
    </section>

    {door === "describe" ? <section className={css.section} aria-labelledby="describe"><h2 id="describe">How does the work go? <span><PenLine size={13} aria-hidden="true" />In your own words</span></h2>
      <textarea className={css.describe} value={text} onChange={(e) => { setText(e.target.value); setSop(null); setDraft(null); }} maxLength={100000}
        placeholder={`Say it the way you would to a new colleague: who does what, in what order, and how soon. For example:\n\n${EXAMPLE}`} aria-label="How the work goes" />
      {!text ? <button type="button" className={css.more} onClick={() => { setText(EXAMPLE); setSop(null); setDraft(null); }}>Use the example</button> : null}
      {writeups.length ? <details className={css.orSop} open={!!sop}><summary><BookOpenText size={14} aria-hidden="true" />Or a write-up you already have ({writeups.length})</summary>
        {writeups.length > 5 ? <label className={css.search}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a write-up" aria-label="Find a write-up" /></label> : null}
        <ul className={css.writeups} role="radiogroup" aria-label="A write-up">{shown.map((w) => { const on = sop === w.id;
          return <li key={w.id}><button type="button" role="radio" aria-checked={on} className={css.writeup} onClick={() => { setSop(on ? null : w.id); setDraft(null); }}>
            <BookOpenText size={16} aria-hidden="true" /><span><b>{w.name}</b>{w.summary ? <small>{w.summary}</small> : null}</span>
            {on ? <Check size={16} aria-hidden="true" className={css.tickInline} /> : <em>{w.steps ? `${w.steps} steps in the text` : "Text only"}</em>}
          </button></li>; })}</ul>
        {!all && !q && found.length > 5 ? <button type="button" className={css.more} onClick={() => setAll(true)}>Show all {found.length}</button> : null}
      </details> : null}
      {!draft ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.draftBtn}`} disabled={busy || (!sop && text.trim().length < 8)} onClick={() => void read()}>
        <Sparkles size={14} aria-hidden="true" />{busy ? "Pip is reading…" : "Draft the steps"}</button>
        : <div className={css.draft} aria-label="Pip's draft"><b>Pip’s draft</b><ul>{draft.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          <ol>{draft.definition.steps.slice(0, 14).map((s) => <li key={s.id}><em data-block={s.block ?? undefined}>{(s.block ?? "step").replace("ai", "AI")}</em>{s.title}</li>)}{draft.definition.steps.length > 14 ? <li>… {draft.definition.steps.length - 14} more</li> : null}</ol>
          <button type="button" className={css.more} onClick={() => setDraft(null)}>Change what I wrote</button></div>}
    </section> : null}

    {door === "template" ? <section className={css.section} aria-labelledby="templates"><h2 id="templates">Which one?</h2>
      <div className={css.templates} role="radiogroup" aria-label="A template">
        {list.map((t, i) => { const Icon = iconFor(t), on = tpl === t.key;
          return <button key={t.key} type="button" role="radio" aria-checked={on} className={css.template} style={{ "--i": i } as React.CSSProperties} onClick={() => setTpl(t.key)}>
            <span className={css.tIcon} data-key={t.key}><Icon size={20} aria-hidden="true" /></span>
            <span className={css.tText}><b>{t.name}</b><small>{t.summary}</small></span>
            <span className={css.tFoot}>{t.ours ? "Your industry · " : t.pack ? `${t.pack.name} · ` : ""}{t.steps} steps{t.terms?.run ? ` · each is a ${t.terms.run.toLowerCase()}` : ""}</span>
            {on ? <Check className={css.tick} size={16} aria-hidden="true" /> : null}
          </button>; })}
      </div>
      {!templates && flowReady ? <p className={css.note}>The templates did not load. Describe it and Blank still work.</p> : null}
    </section> : null}

    <div className={css.actions}>
      <button type="button" className={styles.btn} onClick={() => router.push("/processes")}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!ready || busy} onClick={() => void make()}>
        {busy && ready ? "Making the draft…" : <>Open it<ArrowRight size={14} aria-hidden="true" /></>}</button>
    </div>
    {door ? <p className={css.after}>{door === "describe" && !draft ? "Pip drafts first; you see the steps before anything is made." : "You get a draft to change. Nothing runs until you press Go live."}</p> : null}
  </div>;
}
