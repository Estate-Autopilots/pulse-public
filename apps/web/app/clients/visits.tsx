"use client";
// EST-1414: staff API from EST-2284; contract 1.0.3, revision a6115e31. Submit/media follow in EST-1415.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ClipboardList } from "lucide-react";
import { Badge, Empty, Page, PageHeader, Panel, Skeleton, styles } from "../ui";
import { authResponse, RECONNECT } from "../account/http";
import { apiFailure } from "../lib/load-error.mjs";
import { dayTime } from "../lib/format";
import type { Me } from "../lib/api";

type Field = { key: string; label: string; hint: string | null; state: string; required: boolean; maxPhotos: number; position: number };
type Settings = { visitTypes: { key: string; label: string; state: string; position: number }[]; fields: Field[] };
type Visit = { id: string; customer_id: string; type_key: string; status: string; notes: string; assigned_person_id: string; created_at: string; field_set_version: number; starting_fields: Field[] };
type Detail = { visit: Visit; fieldNotes: { field_key: string; notes: string }[]; history: { id: string; action: string; field_key: string | null; at: string; from_value: string | null; to_value: string | null }[] };
type Customer = { name: string; phone: string | null; siteAddress: string | null; systemSizeKw: number | null; latestQuote: { number: string } | null; salesperson: { name: string } | null };
type Listing = { customer: Customer; visits: Visit[] };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { response, data } = await authResponse<T>(`/api/v0/${path}`, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(response.status === 403 ? init?.method ? "You do not have permission to make this change. Nothing was saved." : "You do not have access to these site visits." : apiFailure(response.status, data));
  return data;
}
const write = (notes: string): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes }) });

function Notes({ label, value, max, disabled, readOnly, inset = true, save }: { label: string; value: string; max: number; disabled: boolean; readOnly: boolean; inset?: boolean; save: (notes: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try { await save(draft); setSaved(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form className={`${styles.stack}${inset ? ` ${styles.panelBody}` : ""}`} onSubmit={submit}>
    <label className={styles.field}>{label}<textarea value={draft} maxLength={max} disabled={disabled || busy} onChange={e => { setDraft(e.target.value); setSaved(false); }} /></label>
    {readOnly ? null : <button className={styles.btn} disabled={disabled || busy || draft === value}>{busy ? "Saving…" : `Save ${label.toLowerCase()}`}</button>}
    {error ? <p role="alert">{error} Your draft is still here.</p> : saved ? <p role="status">Notes saved.</p> : null}
  </form>;
}

export function SiteVisits({ customerId, visitId }: { customerId: string; visitId?: string }) {
  const router = useRouter(), base = `/clients/${encodeURIComponent(customerId)}/visits`;
  const [data, setData] = useState<{ listing: Listing; settings: Settings; me: Me; detail?: Detail } | null>(null);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0), [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false), [createError, setCreateError] = useState("");
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine); update();
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), init = { signal: controller.signal };
    void Promise.all([request<Listing>(`customers/${encodeURIComponent(customerId)}/site-visits`, init), request<Settings>("settings/site-visit", init), request<Me>("me", init),
      visitId ? request<Detail>(`site-visits/${encodeURIComponent(visitId)}`, init) : Promise.resolve(undefined)])
      .then(([listing, settings, me, detail]) => {
        if (detail && detail.visit.customer_id !== customerId) throw new Error("This visit is not available for this customer.");
        if (!controller.signal.aborted) setData({ listing, settings, me, detail });
      }).catch(e => { if (!controller.signal.aborted) setError(e.message || RECONNECT); });
    return () => controller.abort();
  }, [customerId, visitId, attempt]);
  function retry() { setData(null); setError(""); setAttempt(n => n + 1); }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setCreateError("");
    try {
      const result = await request<Detail>(`customers/${encodeURIComponent(customerId)}/site-visits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ typeKey: form.get("typeKey"), notes: form.get("notes") }) });
      router.push(`${base}/${encodeURIComponent(result.visit.id)}`);
    } catch (e) { setCreateError((e as Error).message); } finally { setBusy(false); }
  }
  const detail = data?.detail, visit = detail?.visit, customer = data?.listing.customer;
  const canEdit = !!data?.me.person && (["admin", "leadership"].includes(data.me.role) || (visit?.status === "open" && visit.assigned_person_id === data.me.person));
  const label = (key: string) => data?.settings.visitTypes.find(t => t.key === key)?.label ?? key;
  const activeTypes = data?.settings.visitTypes.filter(t => t.state === "active").sort((a, b) => a.position - b.position) ?? [];
  const fields = (visit?.starting_fields ?? []).map(f => {
    const current = data?.settings.fields.find(c => c.key === f.key);
    return { ...f, label: current?.label ?? f.label, state: current?.state ?? f.state, required: f.required && (current?.state ?? f.state) === "active" };
  }).sort((a, b) => a.position - b.position);
  async function save(path: string, notes: string) {
    const next = await request<Detail>(path, write(notes));
    setData(d => d ? { ...d, detail: next } : d);
  }
  return <Page>
    <PageHeader title={visit ? label(visit.type_key) : "Site visits"} back={{ href: visitId ? base : `/clients/${encodeURIComponent(customerId)}`, label: visitId ? "Site visits" : "Customer" }} context={customer ? [customer.name, visit ? dayTime(visit.created_at) : null] : []} />
    {offline ? <p role="status" className={styles.banner}>You are offline. Reconnect before saving. Unsaved notes stay here while this page is open.</p> : null}
    {error ? <Panel title="Site visits unavailable"><div className={styles.panelBody}><p role="alert">{error}</p><button className={styles.btn} onClick={retry}>Try again</button></div></Panel> : !data ?
      <div role="status" aria-label="Loading site visits"><Skeleton /><Skeleton /><Skeleton /></div> : <>
      <Panel title="Customer summary" sub="Read-only · from Pulse">
        <dl className={styles.facts}><dt>Name</dt><dd>{customer!.name}</dd><dt>Phone</dt><dd>{customer!.phone ?? "Not recorded"}</dd>
          <dt>Site address</dt><dd>{customer!.siteAddress ?? "Not recorded"}</dd><dt>System size</dt><dd>{customer!.systemSizeKw == null ? "Not recorded" : `${customer!.systemSizeKw} kW`}</dd>
          <dt>Latest quotation</dt><dd>{customer!.latestQuote?.number ?? "Not recorded"}</dd><dt>Salesperson</dt><dd>{customer!.salesperson?.name ?? "Not recorded"}</dd></dl>
      </Panel>
      {!visit ? <>
        <Panel title="Visits" sub="Newest first">
          {data.listing.visits.length ? <ul className={styles.list}>{[...data.listing.visits].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(v =>
            <li className={styles.row} key={v.id}><Link className={styles.rowMain} href={`${base}/${encodeURIComponent(v.id)}`}><span className={styles.rowTitle}>{label(v.type_key)}</span><span className={styles.rowMeta}>{dayTime(v.created_at)}</span></Link><Badge>{v.status === "submitted" ? "Submitted" : "Open"}</Badge></li>)}</ul> :
            <Empty icon={ClipboardList} title="No site visits yet" text="Start a visit to record site notes using your organisation’s configured fields." />}
        </Panel>
        <Panel title="New visit">{!activeTypes.length ? <Empty icon={ClipboardList} title="No visit types are set up yet" text="Ask an admin to add one." /> : <form className={`${styles.stack} ${styles.panelBody}`} onSubmit={create}>
          <label className={styles.field}>Visit type<select name="typeKey" required disabled={busy || offline} defaultValue=""><option value="" disabled>Choose a visit type</option>{activeTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
          <label className={styles.field}>Starting notes<textarea name="notes" maxLength={4000} disabled={busy || offline} /></label>
          {!data.me.person ? <p className={styles.muted}>Your sign-in is not linked to a staff profile. Ask an admin to link it before starting a visit.</p> : null}
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || offline || !data.me.person}>{busy ? "Creating…" : "Start visit"}</button>
          {createError ? <p role="alert">{createError}</p> : null}
        </form>}</Panel>
      </> : <>
        <Panel title="Visit notes" sub={<Badge>{visit.status === "submitted" ? "Submitted" : "Open"}</Badge>}>
          <p className={`${styles.muted} ${styles.panelBody}`}>Started with field set {visit.field_set_version}.{canEdit ? "" : " Read-only: only the assigned employee, an admin or the organisation owner can edit an open visit. After submission, an admin or owner can edit."}</p>
          <Notes key={visit.id} label="Visit notes" value={visit.notes} max={4000} disabled={!canEdit || offline} readOnly={!canEdit} save={n => save(`site-visits/${encodeURIComponent(visit.id)}/notes`, n)} />
        </Panel>
        {[false, true].map(archived => { const shown = fields.filter(f => archived ? f.state !== "active" && detail!.fieldNotes.some(n => n.field_key === f.key && n.notes.length > 0) : f.state === "active"); return <Panel key={String(archived)} title={archived ? "Archived fields" : "Starting fields"}>
          {shown.length ? shown.map(f => <section key={f.key} className={`${styles.stack} ${styles.panelBody}`}>
            <h4 className={styles.panelTitle}>{f.label} <Badge>{f.required ? "Required" : "Optional"}</Badge></h4><p className={styles.muted}>{[f.hint, `Up to ${f.maxPhotos} photos`].filter(Boolean).join(" · ")}</p>
            <Notes key={`${visit.id}:${f.key}`} label={`${f.label} notes`} value={detail!.fieldNotes.find(n => n.field_key === f.key)?.notes ?? ""} max={2000} disabled={!canEdit || offline} readOnly={!canEdit} inset={false} save={n => save(`site-visits/${encodeURIComponent(visit.id)}/fields/${encodeURIComponent(f.key)}/notes`, n)} />
          </section>) : <p className={`${styles.muted} ${styles.panelBody}`}>{archived ? "No archived starting fields." : "No starting fields were configured for this visit type."}</p>}
        </Panel>; })}
        <Panel title="Visit history"><ul className={styles.list}>{detail!.history.map(h => <li className={styles.row} key={h.id}><div className={styles.rowMain}><span>{h.action.replaceAll("_", " ")}{h.field_key ? ` · ${fields.find(f => f.key === h.field_key)?.label ?? h.field_key}` : ""}</span><time dateTime={h.at} className={styles.rowMeta}>{dayTime(h.at)}</time>{h.from_value !== null || h.to_value !== null ? <span>{h.from_value || "Empty"} → {h.to_value || "Empty"}</span> : null}</div></li>)}</ul>{detail!.history.length ? null : <p className={`${styles.muted} ${styles.panelBody}`}>No history is available for your access to this visit.</p>}</Panel>
      </>}
    </>}
  </Page>;
}
