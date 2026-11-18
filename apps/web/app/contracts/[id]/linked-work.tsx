"use client";
// CONTRACTS-3 (owner, 8 Nov: "linked projects and tasks must show on the contract"): an agreement's project, tasks and
// quotation or invoice, each a link; who runs the agreement adds one by searching (its project's tasks come first) or
// takes one off. The project and task pages show the agreement back (agreements-for-work.tsx).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FolderKanban, Link2, ListChecks, ReceiptText, Search, Target, X } from "lucide-react";
import { post } from "../../orgs/client";
import { getJson } from "../fetch";
import { money } from "../../lib/contracts.mjs";
import { useWords } from "../../org-code";
import { toast, useConfirm } from "../../kit/dialogs";
import type { ContractDetail } from "../parts";
import css from "../contracts.module.css";
import d3 from "./drafts.module.css";
import { Fold } from "./fold";

type Options = { projects: { id: string; title: string; status: string }[]; tasks: { id: string; title: string; status: string; project: string | null }[];
  invoices: { id: string; number: string | null; docType: string; status: string; total: number; client: string | null }[] };
const DOC = { quotation: "Quotation", proforma: "Proforma", invoice: "Invoice" } as Record<string, string>;
const hrefOf = (kind: string, id: string) => kind === "project" ? `/projects/${id}` : kind === "task" ? `/tasks/${id}` : kind === "goal" ? `/goals/${id}` : `/erp/documents/${id}`;
const ICON = { project: FolderKanban, task: ListChecks, invoice: ReceiptText, goal: Target } as const;

export function LinkedWork({ d, run }: { d: ContractDetail; run: boolean }) {
  const c = d.contract;
  const words = useWords();
  const router = useRouter();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!adding) return;
    let live = true;
    const t = setTimeout(async () => {
      try { const r = await getJson<Options>(`contracts/${c.id}/link-options?q=${encodeURIComponent(q)}`); if (live) { setOpts(r); setError(null); } }
      catch (e) { if (live) setError(e instanceof Error ? e.message : "Could not search. Try again."); }
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [adding, q, c.id]);

  async function link(key: string, body: Record<string, string>, what: string) {
    setBusy(key);
    try { await post(`contracts/${c.id}/links`, body); toast.success(`Linked: ${what}`); setOpts(null); setQ(""); router.refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(null); }
  }
  async function unlink(id: string, title: string) {
    if (!(await confirm({ title: `Take "${title}" off this agreement?`, body: "It stays where it is; only the link goes.", confirmLabel: "Take it off" }))) return;
    setBusy(id);
    try { await post(`contracts/${c.id}/links/${id}/remove`, {}); router.refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(null); }
  }
  if (!run && !d.links.length) return null;
  const none = opts && !opts.projects.length && !opts.tasks.length && !opts.invoices.length;
  return <Fold title={`${words.project}, tasks and invoice`} label="Linked work" summary={d.links.length ? `${d.links.length} linked` : "Nothing linked yet"}>
    {d.links.length ? <ul className={css.list}>{d.links.map((l) => { const Icon = ICON[l.kind] ?? Link2; return <li key={l.id}>
      <Icon size={18} aria-hidden="true" />
      <span className={css.itemText}>
        <Link href={hrefOf(l.kind, l.refId)}><strong>{l.title}</strong></Link>
        <span>{[l.kind === "project" ? words.project : l.kind === "task" ? "Task" : l.kind === "goal" ? "Goal" : "Quotation or invoice", l.status].filter(Boolean).join(" · ")}</span>
      </span>
      {run ? <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} aria-label={`Take off ${l.title}`} onClick={() => unlink(l.id, l.title)}><X size={16} aria-hidden="true" /></button> : null}
    </li>; })}</ul> : <p className={css.empty}>{`Nothing linked yet. Link the ${words.project.toLowerCase()}, its tasks and the invoice, so everyone finds the agreement from them.`}</p>}
    {run ? adding ? <div className={css.panel}>
      <label className={css.field}>Find work to link
        <span className={d3.searchBox}><Search size={16} aria-hidden="true" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${words.project}, task, quotation or invoice number`} maxLength={120} /></span>
      </label>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      {opts ? <div className={d3.options}>
        {opts.projects.length ? <Group title={words.projects}>{opts.projects.map((p) => <Pick key={p.id} icon={FolderKanban} title={p.title} sub={p.status} busy={busy === p.id}
          onPick={() => link(p.id, { projectId: p.id }, p.title)} />)}</Group> : null}
        {opts.tasks.length ? <Group title="Tasks">{opts.tasks.map((t) => <Pick key={t.id} icon={ListChecks} title={t.title} sub={[t.project, t.status].filter(Boolean).join(" · ")} busy={busy === t.id}
          onPick={() => link(t.id, { taskId: t.id }, t.title)} />)}</Group> : null}
        {opts.invoices.length ? <Group title="Quotations and invoices">{opts.invoices.map((i) => <Pick key={i.id} icon={ReceiptText} title={`${DOC[i.docType] ?? i.docType} ${i.number ?? ""}`.trim()}
          sub={[i.client, money(Number(i.total), "INR")].filter(Boolean).join(" · ")} busy={busy === i.id} onPick={() => link(i.id, { invoiceId: i.id }, `${DOC[i.docType] ?? ""} ${i.number ?? ""}`.trim())} />)}</Group> : null}
        {none ? <p className={css.hint}>{q ? "Nothing found. Try other words." : `Type to find a ${words.project.toLowerCase()}, a task or an invoice.`}</p> : null}
      </div> : <p className={css.hint}>Looking…</p>}
      <div className={css.actions}><button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => { setAdding(false); setQ(""); setOpts(null); }}>Done</button></div>
    </div> : <div className={css.actions}><button type="button" className={css.btn} onClick={() => setAdding(true)}><Link2 size={16} aria-hidden="true" />Link work</button></div> : null}
  </Fold>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div className={d3.group}><span>{title}</span><ul className={css.list}>{children}</ul></div>;
}
function Pick({ icon: Icon, title, sub, busy, onPick }: { icon: typeof Link2; title: string; sub: string; busy: boolean; onPick: () => void }) {
  return <li><Icon size={16} aria-hidden="true" /><span className={css.itemText}><strong>{title}</strong>{sub ? <span>{sub}</span> : null}</span>
    <button type="button" className={css.btn} disabled={busy} onClick={onPick}>{busy ? "Linking…" : "Link"}</button></li>;
}
