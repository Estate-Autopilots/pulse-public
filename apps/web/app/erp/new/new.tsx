"use client";

// Billing redesign (18 Oct 2026): start a document in two taps. Choose what you are making and for whom (a project or
// client); Pulse brings the client, the billing profile (or what FIN-LIVE's past invoices say: the GSTIN and billed name),
// the contacts and the packages sold on it with their milestones. One press makes the draft and opens the composer.
// Nothing is retyped: the billing details wait behind "Billing details" for the rare correction.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Building2, FilePlus2, FolderOpen, PackagePlus, Save, UserRound } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { addDays, formatDate, STATES, stateFromGstin, toPaise, validGstin, formatAmount, type DocType } from "@pulse/invoice-doc/browser";
import { post } from "../../records";
import { Badge, initials, styles } from "../../ui";
import { Segmented } from "../../kit/segmented";
import { Disclosure } from "../../kit/disclosure";
import { LineList, LineRow } from "../../kit/line-row";
import { NextStep } from "../../kit/next-step";
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from "../nav";
import type { Doc, Engagement, Person } from "../types";
import { inr } from "../documents/chain";
import css from "../documents/documents.module.css";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

type ProjectRow = { id: string; title: string; location: string | null; month: string | null; clientId: string | null; client: string | null; engagements: number; documents: number; billing: boolean };
type Context = {
  project: { id: string; title: string; folder: string; location: string | null; month: string | null; clientId: string | null };
  client: { id: string; name: string; companyName: string | null; email: string | null; phone: string | null; city: string | null } | null;
  party: { legalName: string; gstin: string | null; stateCode: string | null; address: string[]; email: string | null; phone: string | null; contactPersonId: string | null; contactName: string | null; notes: string } | null;
  hints: { name: string; gstin: string; number: string; date: string }[];
  contacts: { id: string; name: string; designation: string | null; email: string | null; phone: string | null; primary: boolean; via: string }[];
  engagements: Engagement[]; documents: Doc[]; canWrite: boolean;
  packages: { id: string; name: string; price: number; gstRate: number; milestones: { label: string; percent: number; offsetDays: number }[]; status: string; version: number }[];
};
type Party = { name: string; gstin: string; stateCode: string; address: string; contactPersonId: string | null; contactName: string; email: string; phone: string; hint: string | null };
const message = (e: unknown) => (e instanceof Error ? e.message : "Could not save");
const KINDS: DocType[] = ["quotation", "proforma", "invoice", "credit_note"];
const KIND_LABEL: Record<string, string> = { quotation: "Quotation", proforma: "Proforma", invoice: "Tax invoice", credit_note: "Credit note" };
const STATE_OPTIONS = Object.entries(STATES).sort((a, b) => a[1].name.localeCompare(b[1].name));

export function NewDocument({ initialProject, initialType, assignees }: { initialProject: string | null; initialType: DocType; assignees: Person[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<DocType>(initialType);
  const [q, setQ] = useState(""), [projects, setProjects] = useState<ProjectRow[] | null>(null), [projectId, setProjectId] = useState<string | null>(initialProject);
  const [ctx, setCtx] = useState<Context | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(!!initialProject);
  const [party, setParty] = useState<Party | null>(null);
  const [sell, setSell] = useState<{ packageId: string; price: number; startsOn: string } | null>(null);
  const noun = KIND_LABEL[kind].toLowerCase();

  useEffect(() => {
    let gone = false;
    const t = setTimeout(() => { fetch(`/api/v0/erp/projects?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((d) => { if (!gone) setProjects(d.projects ?? []); }).catch(() => { if (!gone) setProjects([]); }); }, 200);
    return () => { gone = true; clearTimeout(t); };
  }, [q]);
  const load = (id: string) =>
    fetch(`/api/v0/erp/projects/${id}`).then((r) => r.json()).then((d: Context) => {
      setCtx(d);
      const hint = d.hints[0];
      const primary = d.contacts.find((c) => c.id === d.party?.contactPersonId) ?? d.contacts.find((c) => c.primary) ?? d.contacts[0];
      setParty(d.party ? { name: d.party.legalName, gstin: d.party.gstin ?? "", stateCode: d.party.stateCode ?? "", address: d.party.address.join("\n"), contactPersonId: d.party.contactPersonId, contactName: d.party.contactName ?? "", email: d.party.email ?? "", phone: d.party.phone ?? "", hint: null }
        : { name: hint?.name ?? d.client?.companyName ?? d.client?.name ?? "", gstin: hint?.gstin ?? "", stateCode: hint ? stateFromGstin(hint.gstin) ?? "" : "", address: d.client?.city ?? "", contactPersonId: primary?.id ?? null,
          contactName: primary?.name ?? "", email: primary?.email ?? d.client?.email ?? "", phone: primary?.phone ?? d.client?.phone ?? "", hint: hint ? `From Zoho invoice ${hint.number} (${formatDate(hint.date)})` : null });
    }).finally(() => setLoading(false));
  useEffect(() => { if (projectId) void load(projectId); }, [projectId]);

  const partyBody = (p: Party) => ({ name: p.name, gstin: p.gstin || null, stateCode: p.stateCode || null, address: p.address.split("\n"), contactPersonId: p.contactPersonId, contactName: p.contactName, email: p.email, phone: p.phone, hint: p.hint ? "finance-live" : null });
  async function saveParty() {
    if (!ctx?.client || !party) return;
    setBusy(true);
    try {
      await post(`erp/parties/${ctx.client.id}`, partyBody(party));
      notify({ id: "erp-party", tone: "success", title: "Billing details saved", message: "Every new document for this client starts from them.", timeout: 3000 });
      await load(ctx.project.id);
    } catch (e) { notify({ id: "erp-party", tone: "error", title: "Not saved", message: message(e) }); } finally { setBusy(false); }
  }
  async function create(body: Record<string, unknown>) {
    setBusy(true);
    try {
      if (ctx?.client && party && !ctx.party && party.name) await post(`erp/parties/${ctx.client.id}`, partyBody(party));
      const r = await post<{ id: string }>("erp/documents", body);
      router.push(`/erp/documents/${r.id}`);
    } catch (e) { notify({ id: "erp-new", tone: "error", title: "Not created", message: message(e) }); setBusy(false); }
  }
  async function invoiceMilestone(id: string, assigneeId?: string, dueOn?: string | null) {
    setBusy(true);
    try {
      if (ctx?.client && party && !ctx.party && party.name) await post(`erp/parties/${ctx.client.id}`, partyBody(party));
      const r = await post<{ id: string; taskId: string | null }>(`erp/milestones/${id}/invoice`, assigneeId ? { assigneeId, dueOn } : {});
      if (assigneeId) { notify({ id: "erp-new", tone: "success", title: "Task created with the draft attached", timeout: 3500 }); await load(ctx!.project.id); setBusy(false); }
      else router.push(`/erp/documents/${r.id}`);
    } catch (e) { notify({ id: "erp-new", tone: "error", title: "Not created", message: message(e) }); setBusy(false); }
  }
  async function sellPackage() {
    if (!sell || !ctx) return;
    setBusy(true);
    try { await post("erp/engagements", { projectId: ctx.project.id, packageId: sell.packageId, price: sell.price, startsOn: sell.startsOn }); setSell(null); notify({ id: "erp-sell", tone: "success", title: "Client package added with its milestones", timeout: 3000 }); await load(ctx.project.id); }
    catch (e) { notify({ id: "erp-sell", tone: "error", title: "Not added", message: message(e) }); } finally { setBusy(false); }
  }
  const invoices = useMemo(() => (ctx?.documents ?? []).filter((x) => x.docType === "invoice" && !["draft", "cancelled"].includes(x.status)), [ctx]);
  const gstinBad = !!party?.gstin && !validGstin(party.gstin);
  const pkg = ctx?.packages.find((p) => p.id === sell?.packageId);
  const clear = () => { setProjectId(null); setCtx(null); setParty(null); };

  const main = kind === "credit_note" ? null
    : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || loading} onClick={() => void create(ctx ? { docType: kind, projectId: ctx.project.id } : { docType: kind })}>
      <FilePlus2 size={15} aria-hidden="true" />Start the {noun}</button>;
  const status = kind === "credit_note" ? (ctx ? "Choose the invoice it corrects." : "Choose the project, then the invoice it corrects.")
    : ctx ? `${ctx.client ? ctx.party ? "Client and billing details" : "Client" : "The project"} carried over; you add the lines.` : `Or start a blank ${noun} and choose the client in it.`;

  return <div className={css.composer}>
    <div className={css.write}>
      <div className={css.block}>
        <p className={css.label}>What are you making?</p>
        <Segmented label="Kind of document" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </div>

      <div className={css.block}>
        <p className={css.label}>For whom?</p>
        {ctx ? <LineList label="Chosen project">
          <LineRow lead={<span className={css.avatar} aria-hidden="true">{initials(ctx.client?.name ?? ctx.project.title)}</span>} title={ctx.client?.name ?? "No client linked"}
            sub={[ctx.project.title, ctx.project.location, ctx.party ? "billing details on file" : party?.hint].filter(Boolean).join(" · ")}
            end={<button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={clear}>Change</button>} />
        </LineList> : <>
          <label className={css.search} style={{ maxWidth: "none" }}><span className={styles.srOnly}>Search projects and clients</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Project, client or company" autoFocus /></label>
          <div style={{ marginTop: 8 }}><LineList label="Projects">
            {projects === null ? <LineRow title="Looking…" tone="muted" /> : projects.slice(0, 12).map((p) => <LineRow key={p.id} lead={<FolderOpen size={16} aria-hidden="true" />} title={p.title}
              sub={[p.client ?? "No client linked", p.location, p.month].filter(Boolean).join(" · ")} amountSub={[p.engagements ? `${p.engagements} package${p.engagements === 1 ? "" : "s"}` : null, p.billing ? "billing ✓" : null].filter(Boolean).join(" · ") || undefined}
              amount={p.engagements || p.billing ? "" : undefined} onOpen={() => { setLoading(true); setProjectId(p.id); }} label={`Choose ${p.title}`} />)}
            {projects?.length === 0 ? <LineRow title="No project matches" sub="Try the client's or company's name" tone="muted" /> : null}
          </LineList></div>
        </>}
        {loading ? <p className={css.note} aria-live="polite">Fetching the client, contacts and packages…</p> : null}
        {ctx && !ctx.client ? <p className={css.note}>This project has no client linked: choose the client in the {noun}, or link one in Clients.</p> : null}
      </div>

      {ctx && party ? <Disclosure summary="Billing details" hint={[party.name, party.gstin || "unregistered", ctx.party ? "on file" : party.hint ? "from a past invoice" : "from the client record"].filter(Boolean).join(" · ")}>
        <div className={css.fields}>
          <label className={`${styles.field} ${css.wide}`}>Legal name<input value={party.name} onChange={(e) => setParty({ ...party, name: e.target.value })} /></label>
          <label className={styles.field}>GSTIN<input value={party.gstin} maxLength={15} onChange={(e) => { const g = e.target.value.toUpperCase(); setParty({ ...party, gstin: g, stateCode: validGstin(g) ? stateFromGstin(g)! : party.stateCode }); }} />
            <span className={`${css.hint} ${gstinBad ? css.bad : party.gstin ? css.good : ""}`}>{gstinBad ? "Not a valid GSTIN" : party.gstin ? "Valid" : "Unregistered: leave empty"}</span></label>
          <label className={styles.field}>State<SelectField value={party.stateCode} disabled={!!party.gstin && !gstinBad} onChange={(e) => setParty({ ...party, stateCode: e.target.value })}><option value="">Choose…</option>{STATE_OPTIONS.map(([code, s]) => <option key={code} value={code}>{s.name}</option>)}</SelectField></label>
          <label className={`${styles.field} ${css.wide}`}>Address<textarea rows={2} value={party.address} onChange={(e) => setParty({ ...party, address: e.target.value })} /></label>
        </div>
        {ctx.hints.length > 1 ? <p className={css.note}>Other GSTINs on past invoices: {ctx.hints.slice(1).map((h) => <button key={h.gstin} type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setParty({ ...party, name: h.name, gstin: h.gstin, stateCode: stateFromGstin(h.gstin) ?? "", hint: `From Zoho invoice ${h.number}` })}>{h.gstin} · {h.name}</button>)}</p> : null}
        {ctx.contacts.length ? <LineList label="Billing contact">{ctx.contacts.map((c) => <LineRow key={c.id} lead={<UserRound size={16} aria-hidden="true" />} selected={party.contactPersonId === c.id}
          title={`${c.name}${c.designation ? ` · ${c.designation}` : ""}`} sub={[c.email, c.phone].filter(Boolean).join(" · ") || "No e-mail or phone on record"} amountSub={c.primary ? "primary" : c.via}
          onOpen={() => setParty({ ...party, contactPersonId: c.id, contactName: c.name, email: c.email ?? party.email, phone: c.phone ?? party.phone })} label={`Bill to ${c.name}`} />)}</LineList>
          : <p className={css.note}>No contacts are linked to this client yet.</p>}
        <div className={css.fields}>
          <label className={styles.field}>Contact name<input value={party.contactName} onChange={(e) => setParty({ ...party, contactName: e.target.value })} /></label>
          <label className={styles.field}>E-mail<input type="email" value={party.email} onChange={(e) => setParty({ ...party, email: e.target.value })} /></label>
          <label className={styles.field}>Phone<input value={party.phone} onChange={(e) => setParty({ ...party, phone: e.target.value })} /></label>
        </div>
        {ctx.client && ctx.canWrite ? <div><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || gstinBad || !party.name} onClick={() => void saveParty()}><Save size={13} aria-hidden="true" />Save for every document</button></div> : null}
      </Disclosure> : null}

      {ctx ? <div className={css.block}>
        <p className={css.label}>{kind === "credit_note" ? "Which invoice?" : "Packages on this project"}</p>
        {kind === "credit_note" ? <LineList label="Invoices">{invoices.map((inv) => <LineRow key={inv.id} title={inv.number ?? "Invoice"} sub={formatDate(inv.issueDate)} amount={inr(inv.total)}
          end={<button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => void create({ docType: "credit_note", againstId: inv.id })}>Credit note</button>} />)}
          {!invoices.length ? <LineRow title="No approved invoice on this project yet" tone="muted" /> : null}</LineList>
        : <>
          {ctx.engagements.map((e) => <div key={e.id} style={{ marginBottom: 10 }}><LineList label={e.name}>
            <LineRow lead={<PackagePlus size={16} aria-hidden="true" />} title={e.name} sub={`${inr(e.price)} + GST ${e.gstRate}% · from ${formatDate(e.startsOn)}`} end={<Badge tone={e.status === "active" ? "accent" : "neutral"}>{e.status}</Badge>} />
            {e.milestones.map((m) => <MilestoneRow key={m.id} m={m} kind={kind} busy={busy} assignees={assignees} onInvoice={invoiceMilestone} onDraft={(id) => router.push(`/erp/documents/${id}`)} onOther={() => void create({ docType: kind, projectId: ctx.project.id })} />)}
          </LineList></div>)}
          {!ctx.engagements.length ? <p className={css.note}>No package is sold on this project. Start the {noun} and pick from the catalogue, or sell a package to bill it by milestones.</p> : null}
          {ctx.canWrite ? sell ? <div className={styles.panel} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className={css.fields}>
              <label className={styles.field}>Package<SelectField value={sell.packageId} onChange={(e) => { const p = ctx.packages.find((x) => x.id === e.target.value); setSell({ ...sell, packageId: e.target.value, price: p?.price ?? 0 }); }}>
                {ctx.packages.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === "draft" ? " (draft)" : ""}</option>)}</SelectField></label>
              <label className={styles.field}>Price ₹ (before GST)<input inputMode="decimal" defaultValue={formatAmount(sell.price).replace(/,/g, "")} key={sell.packageId} onChange={(e) => { const p = toPaise(e.target.value); if (p !== null) setSell({ ...sell, price: p }); }} /></label>
              <label className={styles.field}>Starts on<DateField value={sell.startsOn} onChange={(e) => setSell({ ...sell, startsOn: e.target.value })} /></label>
            </div>
            {pkg ? <p className={css.note}>Milestones: {(pkg.milestones.length ? pkg.milestones : [{ label: "Full amount", percent: 100, offsetDays: 0 }]).map((m) => `${m.label} ${m.percent}% (${formatDate(addDays(sell.startsOn, m.offsetDays))})`).join(" · ")}</p> : null}
            <div className={styles.inline}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !sell.packageId} onClick={() => void sellPackage()}>Add client package</button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setSell(null)}>Cancel</button></div>
          </div> : ctx.packages.length ? <button type="button" className={css.chip} data-tone="quiet" onClick={() => setSell({ packageId: ctx.packages[0].id, price: ctx.packages[0].price, startsOn: new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10) })}>
            <PackagePlus size={13} aria-hidden="true" /><span>Sell a package on this project</span></button> : null : null}
        </>}
      </div> : null}

      <NextStep status={status} primary={main} />
    </div>
    <aside className={css.view} aria-label="What is filled in for you">
      <LineList label="Filled in for you">
        <LineRow lead={<Building2 size={16} aria-hidden="true" />} title="Client, GSTIN and place of supply" sub="From the billing details, else the client and their past invoices" />
        <LineRow lead={<UserRound size={16} aria-hidden="true" />} title="Billing contact" sub="The client's primary contact" />
        <LineRow lead={<PackagePlus size={16} aria-hidden="true" />} title="Lines and prices" sub="From the catalogue or a package's milestone" />
        <LineRow lead={<FilePlus2 size={16} aria-hidden="true" />} title="Dates, number and template" sub="Numbered when approved; the default template" />
      </LineList>
    </aside>
  </div>;
}

function MilestoneRow({ m, kind, busy, assignees, onInvoice, onDraft, onOther }: { m: Engagement["milestones"][number]; kind: DocType; busy: boolean; assignees: Person[]; onInvoice: (id: string, assigneeId?: string, dueOn?: string | null) => void; onDraft: (id: string) => void; onOther: () => void }) {
  const [who, setWho] = useState("");
  const done = m.documentId && m.documentStatus && !["draft", "cancelled"].includes(m.documentStatus);
  return <LineRow title={`${m.position + 1}. ${m.label}`} sub={[m.dueOn ? `due ${formatDate(m.dueOn)}` : "no date", m.assignee ? `${m.assignee} has the task` : null].filter(Boolean).join(" · ")} amount={inr(m.amount)}
    end={done ? <><Badge tone={STATUS_TONE[m.documentStatus!]}>{m.number} · {STATUS_LABEL[m.documentStatus!]}</Badge><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onDraft(m.documentId!)}>Open</button></>
      : kind !== "invoice" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={onOther}>{TYPE_LABEL[kind]}</button>
      : m.documentId ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => onDraft(m.documentId!)}>Open draft</button>
      : <>
        {assignees.length ? <><SelectField className={styles.input} value={who} onChange={(e) => setWho(e.target.value)} aria-label={`Who generates milestone ${m.position + 1}`} style={{ width: 130 }}><option value="">Assign to…</option>{assignees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField>
          {who ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => onInvoice(m.id, who, m.dueOn)}>Assign</button> : null}</> : null}
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => onInvoice(m.id)}>Invoice it</button>
      </>} />;
}
