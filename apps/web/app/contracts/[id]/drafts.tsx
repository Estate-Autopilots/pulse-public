"use client";
// CONTRACTS-3 (the 7 Nov meeting: "first, second, third and final drafts, with a diff between them"; owner, 8 Nov: "Claude
// or ChatGPT can edit it and the edit uploads straight in as a new version"): every kept draft, "Compare" clause by
// clause with the added and taken-out words marked (the chosen concept: one card per changed clause, the unchanged ones
// folded), and drafts proposed through the API or an AI assistant, which a person compares and uses (a new draft) or drops.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, GitCompare } from "lucide-react";
import { compareClauses } from "@pulse/invoice-doc/browser";
import { post } from "../../orgs/client";
import { useOrgZone } from "../../org-code";
import { toast } from "../../kit/dialogs";
import { celebrate } from "../../kit/game";
import { Drawer } from "../../kit/drawer";
import { SelectField } from "../../kit/select-field";
import { Fold } from "./fold";
import type { ContractDetail } from "../parts";
import css from "../contracts.module.css";
import d3 from "./drafts.module.css";

type Proposal = NonNullable<ContractDetail["proposals"]>[number];
const stamp = (iso: string, timeZone: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });
const VIA = { mcp: "an AI assistant", api: "the API", app: "Vitals OS" } as Record<string, string>;
const STATUS = { changed: "Changed", added: "Added", removed: "Taken out", same: "Same" } as Record<string, string>;

/** Two texts compared clause by clause; the unchanged clauses fold into one line. */
export function Comparison({ before, after, labels }: { before: string; after: string; labels: [string, string] }) {
  const rows = useMemo(() => compareClauses(before, after), [before, after]);
  const changed = rows.filter((r) => r.status !== "same");
  const same = rows.filter((r) => r.status === "same");
  // Counted as the agreement's page counts them: its numbered parts; the untitled opening lines are named on their own.
  const isPart = (r: { name: string }) => r.name !== "Opening";
  const opening = rows.find((r) => !isPart(r));
  const n = (k: string) => rows.filter((r) => isPart(r) && r.status === k).length;
  const parts = (k: number) => `${k} part${k === 1 ? "" : "s"}`;
  const sameParts = same.filter(isPart).length, openingSame = opening?.status === "same";
  const summary = [n("changed") ? `${parts(n("changed"))} changed` : null, n("added") ? `${parts(n("added"))} added` : null, n("removed") ? `${parts(n("removed"))} taken out` : null,
    opening && !openingSame ? "the first lines changed" : null, sameParts ? `${sameParts} stayed the same` : null].filter(Boolean).join(", ");
  const sameLine = `${sameParts} other part${sameParts === 1 ? "" : "s"} didn't change`;
  // The unchanged parts start open on a wide screen (room to spare) and folded on a phone (the change stands alone).
  const sameBox = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (sameBox.current && typeof matchMedia === "function" && !matchMedia("(max-width: 699px)").matches) sameBox.current.open = true; }, []);
  return <div className={d3.compare} aria-label={`${labels[0]} compared with ${labels[1]}`}>
    <p className={d3.summary}><strong>{changed.length ? summary : "Nothing changed in the words"}</strong>
      {changed.length ? <span className={d3.key} aria-label="Key"><i data-k="add" aria-hidden="true" />added <i data-k="del" aria-hidden="true" />taken out</span> : null}</p>
    {changed.map((r) => <article key={r.key} className={d3.clause} data-status={r.status}>
      <h3>{r.name}<span className={d3.tag} data-status={r.status}>{STATUS[r.status]}</span></h3>
      <p>{r.words.map((w, i) => w.kind === "added" ? <ins key={i}>{w.text}</ins> : w.kind === "removed" ? <del key={i}>{w.text}</del> : <span key={i}>{w.text}</span>)}</p>
    </article>)}
    {sameParts ? <details ref={sameBox} className={d3.sameBox}><summary><ChevronDown size={16} aria-hidden="true" />{sameLine}</summary>
      <ul>{same.filter(isPart).map((r) => <li key={r.key}>{r.name}</li>)}</ul></details> : null}
  </div>;
}

/** Drafts proposed through the screen, the API or an AI assistant: first on the page, since they wait for a person. */
export function Proposals({ d, run }: { d: ContractDetail; run: boolean }) {
  const c = d.contract;
  const zone = useOrgZone();
  const router = useRouter();
  const [looking, setLooking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const proposals = d.proposals ?? [];

  async function decide(p: Proposal, use: boolean) {
    setBusy(p.id);
    try {
      await post(`contracts/${c.id}/proposals/${p.id}`, { use });
      if (use) celebrate(null, { id: `agreement-draft-used:${p.id}` });
      toast.success(use ? (c.status === "draft" ? "The new words are in." : "New draft made. The client signs this one with the same link.") : "Dropped. Nothing changed.");
      router.refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(null); }
  }

  if (!run || !proposals.length) return null;
  return <>{proposals.map((p) => <section key={p.id} className={`${css.panel} ${d3.proposal}`} aria-label="A new draft was proposed">
    <h2><Bot size={18} aria-hidden="true" />A new draft was proposed</h2>
    <p className={css.hint}>{[`By ${p.by ?? "someone"} through ${VIA[p.via] ?? "Vitals OS"}`, stamp(p.at, zone), p.baseVersion !== c.version ? `Written on draft ${p.baseVersion}` : null].filter(Boolean).join(" · ")}</p>
    {p.note ? <p className={d3.note}>{`"${p.note}"`}</p> : null}
    <p className={css.hint}>Nothing reaches the client until you use it.</p>
    {looking === p.id ? <Comparison before={c.body} after={p.body} labels={["Now", "The proposed draft"]} /> : null}
    <div className={css.actions}>
      <button type="button" className={css.btn} onClick={() => setLooking(looking === p.id ? null : p.id)}><GitCompare size={16} aria-hidden="true" />{looking === p.id ? "Hide the changes" : "See the changes"}</button>
      <button type="button" className={css.btn} disabled={!!busy} onClick={() => decide(p, true)}>{busy === p.id ? "Saving…" : c.status === "draft" ? "Use these words" : "Use it as the new draft"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => decide(p, false)}>Drop it</button>
    </div>
  </section>)}</>;
}

/** Every kept draft, and Compare between any two. */
export function Drafts({ d }: { d: ContractDetail }) {
  const c = d.contract;
  const zone = useOrgZone();
  const kept = d.versions; // newest first
  const done = c.status === "active" || c.status === "ended";
  const all = useMemo(() => [{ version: c.version, body: c.body, label: done ? "Signed copy" : `Draft ${c.version} (now)` },
    ...kept.map((v) => ({ version: v.version, body: String((v.terms as { body?: string }).body ?? (v.terms as { scope?: string }).scope ?? ""),
      label: `Draft ${v.version}` }))], [c, kept, done]);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<number>(kept[0]?.version ?? c.version);
  const [to, setTo] = useState<number>(c.version);
  const body = (v: number) => all.find((x) => x.version === v)?.body ?? "";
  const label = (v: number) => all.find((x) => x.version === v)?.label ?? `Draft ${v}`;

  if (!kept.length) return null;
  return <Fold title="Drafts" label="Drafts" summary={`${all.length} drafts · last change ${new Date(kept[0].changedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: zone })}`}>
    <div className={css.actions}><button type="button" className={css.btn} onClick={() => setOpen(true)}><GitCompare size={16} aria-hidden="true" />Compare drafts</button>
</div>
    {open ? <Drawer title="Compare drafts" size="md" onClose={() => setOpen(false)}>
      <div className={d3.compareBox}>
        <div className={d3.pickers}>
          <label className={css.field}>From<SelectField value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {all.map((v) => <option key={v.version} value={v.version}>{v.label}</option>)}</SelectField></label>
          <label className={css.field}>To<SelectField value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {all.map((v) => <option key={v.version} value={v.version}>{v.label}</option>)}</SelectField></label>
        </div>
        {from === to ? <p className={css.hint}>Pick two different drafts.</p>
          : <Comparison before={body(Math.min(from, to))} after={body(Math.max(from, to))} labels={[label(Math.min(from, to)), label(Math.max(from, to))]} />}
      </div>
    </Drawer> : null}
  </Fold>;
}
