"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Banknote, ChevronLeft, CircleDot, Clapperboard, Crosshair, ExternalLink, FileVideo, Flag, History, IndianRupee, MapPin, RotateCcw, Users } from "lucide-react";
import { catchment, CLIENT_TYPES, distance, FLAGS, monthLabel, placeName, STAGES, type LocationDetail, type Row } from "./geo";
import { inr, type PlaceMoney, type Price, type Shoot } from "./intel";
import { List, Note, PrecisionBadge, Seg, Stat, SubHead } from "./parts";
import css from "./map.module.css";
import { useWords } from "../org-code";

const date = (value: string | null) => value ? new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";
const safeUrl = (value: string) => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) ? u.href : null; } catch { return null; } };
const plural = (value: number, one: string, many = `${one}s`) => `${value.toLocaleString("en-IN")} ${value === 1 ? one : many}`;
type Tab = "overview" | "nearby" | "contacts" | "work" | "pin";

/** The project card: the name and the facts that matter first, large; then the details in tabs. */
export function ProjectPanel({ id, version, row, rows, onRing, onBack, onFix, onRefresh, onSelect, wide, money, prices, shoots, financeVisible }: {
  id: string; version: number; row: Row | undefined; rows: Row[]; onRing: (km: number) => void; wide: boolean;
  onBack: () => void; onFix: () => void; onRefresh: () => Promise<void>; onSelect: (id: string) => void;
  money?: PlaceMoney | null; prices?: Price[]; shoots?: Shoot[]; financeVisible?: boolean;
}) {
  const words = useWords();
  const [state, setState] = useState<{ id: string; data?: LocationDetail; error?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [work, setWork] = useState<"engagements" | "deliveries" | "campaigns">("engagements");
  const [pin, setPin] = useState<"source" | "flags" | "history">("source");
  const [ring, setRing] = useState(5);
  const [resetting, setResetting] = useState(false), [resetError, setResetError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/v0/map/locations/${id}`, { signal: controller.signal, cache: "no-store" }).then(async (res) => { const data = await res.json(); if (!res.ok) throw new Error(data.error ?? "Project details are unavailable."); return data as LocationDetail; }).then((data) => setState({ id, data })).catch((e) => { if (!controller.signal.aborted) setState({ id, error: e.message }); });
    return () => controller.abort();
  }, [id, version]);
  const detail = state?.id === id ? state.data : undefined;
  const near = useMemo(() => row?.loc.lat != null && row.loc.lng != null ? catchment({ lat: row.loc.lat, lng: row.loc.lng }, rows, id) : null, [row, rows, id]);
  const reset = async () => {
    setResetting(true); setResetError("");
    try { const res = await fetch(`/api/v0/map/locations/${id}/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const data = await res.json(); if (!res.ok) throw new Error(data.error); await onRefresh(); }
    catch (e) { setResetError(e instanceof Error ? e.message : "Could not restore the source pin."); } finally { setResetting(false); }
  };
  const name = row?.name ?? "Project";
  const place = detail ? placeName(detail) : row ? placeName(row.loc) : "";

  return <div className={css.project} data-wide={wide ? "" : undefined}>
    {tab === "overview" ? <div className={css.projectHead}>
      <div className={css.projectTop}><button type="button" className={css.textButton} onClick={onBack}><ChevronLeft size={16} aria-hidden="true" />Analysis</button>{row ? <PrecisionBadge precision={row.loc.precision} pinned={row.loc.pinned} /> : null}</div>
      <h2 className={css.projectName} title={name}>{name}</h2>
      <div className={css.projectPlace}><MapPin size={16} aria-hidden="true" /><span>{place}</span>{detail?.canEdit ? <button type="button" className={css.fixBtn} onClick={onFix}><Crosshair size={15} aria-hidden="true" />Fix pin</button> : null}</div>
    </div> : <div className={css.projectHead} data-compact="">
      <div className={css.projectTop}><button type="button" className={css.iconButton} aria-label="Back to analysis" title="Back to analysis" onClick={onBack}><ChevronLeft size={18} aria-hidden="true" /></button><h2 className={css.projectName} title={`${name} · ${place}`}>{name}</h2>{row ? <PrecisionBadge precision={row.loc.precision} pinned={row.loc.pinned} /> : null}</div>
    </div>}
    <Seg variant="sub" label="Project details" value={tab} onChange={(t) => { setTab(t); if (t === "nearby") onRing(ring); }} items={[{ key: "overview", label: "Overview" }, { key: "nearby", label: "Nearby" }, { key: "contacts", label: "Contacts" }, { key: "work", label: "Work" }, { key: "pin", label: "Pin" }]} />
    {state?.id === id && state.error ? <p role="alert" className={css.error}>{state.error}</p> : !detail ? <div className={css.skeleton} role="status" aria-label="Loading project details"><i /><i /><i /><i /></div> : (
      <div className={css.projectBody} role="tabpanel" aria-label={`${name} ${tab}`}>
        {tab === "overview" ? <>
          <div className={css.stats}>
            <Stat label="Engagements" value={detail.engagements.length} note={detail.engagements.length === 1 ? "project folder" : "project folders"} />
            <Stat label="Deliveries" value={detail.deliveries.total.toLocaleString("en-IN")} note={`${detail.deliveries.finals} final · ${detail.deliveries.drafts} draft`} />
            <Stat label="Last delivered" value={detail.deliveries.last ? new Date(detail.deliveries.last).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "—"} note={detail.deliveries.last ? new Date(detail.deliveries.last).getFullYear().toString() : "nothing yet"} />
          </div>
          <div className={css.block}>
            <h3 className={css.sectionTitle}>{detail.clients.length === 1 ? "Client" : "Clients"}</h3>
            {detail.clients.length ? detail.clients.slice(0, wide ? 4 : 2).map((c) => <Link key={c.id} href={`/clients/${c.id}`} className={css.clientRow}><Users size={18} aria-hidden="true" /><span><b>{c.name}</b><small>{CLIENT_TYPES[c.type] ?? "Client"} · {plural(c.engagements, "engagement")} across Pulse</small></span><ExternalLink size={15} aria-hidden="true" /></Link>)
              : <p className={css.lead}>{detail.clientLabel ?? "No client linked yet"}</p>}
          </div>
          {near ? <button type="button" className={css.ringStrip} onClick={() => { setTab("nearby"); onRing(ring); }} title="Projects around this one">
            {near.rings.map((r) => <span key={r.km}><b>{r.projects}</b><small>within {r.km} km</small></span>)}
          </button> : null}
          {financeVisible ? money ? <div className={css.moneyStrip} title="Invoices placed at this project, before GST. Paid and overdue follow the bank lines FIN-LIVE read; after the last statement nothing can be confirmed.">
              <span><b>{inr(money.invoiced)}</b><small>{plural(money.invoices, "invoice")}</small></span><span><b>{inr(money.paid)}</b><small>paid</small></span>
              <span data-tone={money.overdue ? "risk" : undefined}><b>{inr(money.overdue)}</b><small>overdue</small></span><span><b>{inr(money.unconfirmed)}</b><small>not yet confirmed</small></span>
            </div> : <p className={css.moneyHint}><Banknote size={16} aria-hidden="true" />No invoice is linked to this project. Link its invoice party under Money.</p> : null}
          {prices?.length ? <p className={css.moneyHint} title={prices.map((x) => `${x.fileName ?? "Document"}: ₹${x.price.toLocaleString("en-IN")}/sq ft (${x.kind})`).join("\n")}><IndianRupee size={16} aria-hidden="true" />Its documents quote {[...new Set(prices.map((x) => `₹${x.price.toLocaleString("en-IN")}/sq ft${x.kind === "plot" ? " (plot)" : x.kind === "commercial" ? " (commercial)" : ""}`))].slice(0, 3).join(", ")}</p> : null}
          {shoots?.length ? <p className={css.moneyHint}><Clapperboard size={16} aria-hidden="true" />{plural(shoots.length, "shoot")} · {[...new Set(shoots.map((x) => x.model).filter(Boolean))].slice(0, 3).join(", ")}{shoots[0]?.day ? ` · last ${date(shoots[0].day)}` : ""}</p> : null}
        </> : null}
        {tab === "nearby" ? near ? <>
          <SubHead how="Straight-line distance between stored points, for the projects that pass the filters. Approximate pins count where they are stored (a locality or city centre), so read the rings as a guide. Turn the rings on or off under Layers.">
            <Seg variant="sub" label="Distance" value={String(ring)} onChange={(v) => { setRing(Number(v)); onRing(Number(v)); }} items={near.rings.map((r) => ({ key: String(r.km), label: `${r.km} km`, count: r.projects, title: `${plural(r.projects, "project")} in ${plural(r.markets, "market")}, ${r.repeat} with a repeat client` }))} />
          </SubHead>
          <List resetKey={`near${ring}`} items={near.near.filter((x) => x.km <= ring)} unit="nearby projects" columns={wide} keyOf={(x) => x.row.loc.id} empty={<Note icon={CircleDot} title={`Nothing within ${ring} km`}>No other visible project has a stored point this close.</Note>} render={(x) => (
            <button type="button" className={css.rank} onClick={() => onSelect(x.row.loc.id)} title={`Open ${x.row.name}`}>
              <span className={css.rankText}><b>{x.row.name}</b><small>{placeName(x.row.loc)}{x.row.repeat ? " · repeat client" : ""}</small></span>
              <span className={css.rankValue}>{x.km < 0.05 ? <small>same point</small> : distance(x.km)}</span>
            </button>)} />
        </> : <Note icon={MapPin} title="No point yet">This project has no stored point, so there is nothing to measure from. Fix pin places it.</Note> : null}
        {tab === "contacts" ? <List resetKey="contacts" items={detail.contacts} unit="contacts" columns={wide} keyOf={(c) => c.id} empty={<Note icon={Users} title="No contacts linked">Add contacts on the client or project record.</Note>} render={(c) => (
          <div className={css.contactRow}><Link href={`/contacts/${c.id}`}><b>{c.name}</b></Link><small>{[c.designation, c.via].filter(Boolean).join(" · ")}</small><div>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : null}{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : null}</div></div>)} /> : null}
        {tab === "work" ? <>
          <SubHead how="A development can have several project folders. Deliveries are the latest eight indexed draft and final files across its linked folders. Campaigns come from connected ads records; no performance or money is inferred.">
            <Seg variant="seg" label="Work" value={work} onChange={setWork} items={[{ key: "engagements", label: "Engagements", count: detail.engagements.length }, { key: "deliveries", label: "Files", count: detail.deliveries.latest.length }, { key: "campaigns", label: "Ads", count: detail.campaigns.length }]} />
          </SubHead>
          {work === "engagements" ? <List resetKey="eng" items={detail.engagements} unit="engagements" columns={wide} keyOf={(e) => e.projectId} empty={<Note icon={MapPin} title="Engagements not linked yet">This development came from the research export. Its source folders have not been matched to Pulse projects.</Note>} render={(e) => (
            <Link href={`/projects/${e.projectId}`} className={css.projectRow}><span><b>{e.title}</b><small>{e.month ? monthLabel(e.month) : "Month not set"} · {e.pod ?? `${words.team} unassigned`} · {STAGES[e.stage] ?? e.stage}</small></span><b className={css.rankValue}>{e.deliveries}<small> files</small></b></Link>)} /> : null}
          {work === "deliveries" ? <List resetKey="files" items={detail.deliveries.latest} unit="files" columns={wide} keyOf={(d) => d.fileId} empty={<Note icon={FileVideo} title="No deliveries yet">Indexed deliveries will appear here.</Note>} render={(d) => (
            <a href={`https://drive.google.com/file/d/${encodeURIComponent(d.fileId)}/view`} target="_blank" rel="noreferrer" className={css.projectRow}><span><b>{d.fileName}</b><small>{date(d.deliveredAt)} · {d.kind} · {d.projectName}</small></span><ExternalLink size={15} aria-hidden="true" /></a>)} /> : null}
          {work === "campaigns" ? detail.campaigns.length ? <List resetKey="ads" items={detail.campaigns} unit="campaigns" keyOf={(c) => c.id} render={(c) => <div className={css.projectRow}><span><b>{c.name}</b><small>{[c.platform, c.objective].filter(Boolean).join(" · ")}</small></span></div>} /> : <Note icon={FileVideo} title="No campaigns linked">{detail.campaignsDetail}</Note> : null}
        </> : null}
        {tab === "pin" ? <>
          <SubHead how="Coordinates retain source precision. Even “exact” may be a sales office or a Maps camera centre. RERA numbers are document mentions that need identity confirmation. History keeps the latest 20 changes; restoring the seed is also recorded.">
            <Seg variant="seg" label="Pin" value={pin} onChange={setPin} items={[{ key: "source", label: "Source" }, { key: "flags", label: "Flags", count: detail.flags.length }, { key: "history", label: "History", count: detail.history.length }]} />
          </SubHead>
          {pin === "source" ? <>
            <dl className={css.sourceMeta}><div><dt>Stored point</dt><dd>{detail.lat !== null ? `${detail.lat.toFixed(7)}, ${detail.lng!.toFixed(7)}` : "No accepted coordinates"}</dd></div><div><dt>Seed precision</dt><dd>{detail.seedPrecision ?? "Unlocated"}</dd></div><div><dt>Imported</dt><dd>{detail.importFile} · {date(detail.importBuiltAt)}</dd></div><div><dt>Source</dt><dd className={css.sourceText} title={detail.source ?? ""}>{detail.source ?? "Not located"}</dd></div>{detail.pinnedAt ? <div><dt>Placed in Pulse</dt><dd>{detail.pinnedBy} · {date(detail.pinnedAt)}</dd></div> : null}</dl>
            {detail.addresses?.map((a,i)=><p key={i} className={css.lead}>{a.address} · edited by {a.editedBy??"Pulse"}</p>)}
            {detail.mapsLinks.length || detail.reraNumbers.length ? <div className={css.evidence}>{detail.mapsLinks.slice(0, 3).map((url) => safeUrl(url) ? <a key={url} href={safeUrl(url)!} target="_blank" rel="noreferrer">Open Maps evidence <ExternalLink size={14} aria-hidden="true" /></a> : null)}{detail.reraNumbers.length ? <span title={detail.reraNumbers.join(" · ")}>{plural(detail.reraNumbers.length, "RERA candidate")}: {detail.reraNumbers.slice(0, 2).join(" · ")}{detail.reraNumbers.length > 2 ? " …" : ""}</span> : null}</div> : null}
          </> : null}
          {pin === "flags" ? <List resetKey="flags" items={detail.flags} unit="flags" keyOf={(f) => f} empty={<Note icon={Flag} title="No review flags">The research export raised nothing to check for this project.</Note>} render={(flag) => <p className={css.flag}>{FLAGS[flag] ?? flag.replaceAll("_", " ")}</p>} /> : null}
          {pin === "history" ? <>
            <List resetKey="history" items={detail.history} unit="changes" keyOf={(h) => h.at} empty={<Note icon={History} title="No pin corrections yet">The imported point is still in use. Fix pin keeps the old point, your name and timestamp.</Note>} render={(h) => <div className={css.historyRow}><b>{h.action === "reset" ? "Restored source point" : h.newPrecision === "exact" ? "Placed an exact pin" : "Moved to a locality centre"} · {h.by ?? "Recorded editor"}</b><small>{new Date(h.at).toLocaleString("en-IN")}</small><span>{h.oldLat === null ? "Unlocated" : `${h.oldLat.toFixed(5)}, ${h.oldLng!.toFixed(5)}`} → {h.newLat === null ? "Unlocated" : `${h.newLat.toFixed(5)}, ${h.newLng!.toFixed(5)}`}</span>{h.note ? <p title={h.note}>{h.note}</p> : null}</div>} />
            {detail.canEdit && detail.pinnedAt ? <button type="button" className={css.textButton} disabled={resetting} onClick={() => void reset()}><RotateCcw size={16} aria-hidden="true" />{resetting ? "Restoring…" : "Restore the imported point"}</button> : null}{resetError ? <p className={css.error} role="alert">{resetError}</p> : null}
          </> : null}
        </> : null}
      </div>
    )}
  </div>;
}
