"use client";
// BILLING (18 Oct 2026): the catalogue. One row per package, service or product. A package folds open to its parts, one
// line each (name, quantity, price, cost); pressing a part opens it in the Drawer, where it is edited and saved as a new
// version of the package. Milestones read "25% at start · 25% after 30 days".
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, ChevronRight, PackageOpen, Plus, Search, SearchX } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { score } from "../../lib/forgiving-search.mjs";
import { Badge, styles } from "../../ui";
import { Card, EmptyState, Notice, StatTile, StatTiles, StripeList, StripeRow } from "../../components/calm";
import { ChipFilter } from "../../components/chip-filter";
import { LineList, LineRow } from "../../kit/line-row";
import { showField, type BillingSetup } from "../settings/fields";
import type { ApprovalMode, CatalogItem, Part } from "../types";
import { EMPTY_PART, PartDrawer } from "./part-drawer";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE, marginPercent, milestoneText, partTotals, qtyText, rupees, teamText, type CatalogOption, type PackageInfo } from "./model";
import css from "./catalog.module.css";

export type Filter = "all" | "package" | "item" | "draft" | "archived";
type Editing = { pkg: string; index: number | null };

export function CatalogList({ initialFilter = "all", items, packages, inventory, canWrite, setup, approvalMode = "approver", startClean = 0, ownOnly = false }: { initialFilter?: Filter; items: CatalogItem[];
  packages: Record<string, PackageInfo | null>; inventory: boolean; canWrite: boolean; setup?: BillingSetup;
  /** KAZUK-FLOW (G4): with no approval a drafted item is "Drafted", never "To approve"; the owner's "Start clean" archives
   *  the items drafted for the company (startClean counts them); a salesperson's seat changes only what they added. */
  approvalMode?: ApprovalMode; startClean?: number; ownOnly?: boolean }) {
  const free = approvalMode === "none";
  const statusLabel = (st: CatalogItem["status"]) => (free && st === "draft" ? "Drafted" : STATUS_LABEL[st]);
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(initialFilter), [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing | null>(null), [busy, setBusy] = useState(false);
  const options: CatalogOption[] = useMemo(() => items.filter((i) => i.kind !== "package" && i.status !== "archived").map((i) => ({ id: i.id, name: i.name, kind: i.kind, unit: i.unit, price: i.price, sac: i.sac })), [items]);
  // How many packages use each service, from the parts the page loaded.
  const usedIn = useMemo(() => {
    const n = new Map<string, number>();
    for (const info of Object.values(packages)) for (const id of new Set((info?.parts ?? []).map((p) => p.itemId).filter((x): x is string => !!x))) n.set(id, (n.get(id) ?? 0) + 1);
    return n;
  }, [packages]);
  const q = query.trim().toLowerCase();
  // BILLING-WL (Akabod, 4 Nov 2026): "purepower 5" finds Pure Power 5.0: case, spaces and punctuation never matter.
  const partHit = (i: CatalogItem) => !!q && i.kind === "package" && !!packages[i.id]?.parts.some((p) => score(query, [p.label]) > 0);
  const shown = items.filter((i) => (filter === "all" ? i.status !== "archived" : filter === "package" ? i.kind === "package" && i.status !== "archived" : filter === "item" ? i.kind !== "package" && i.status !== "archived" : i.status === filter)
    && (!q || score(query, [i.name, i.code, i.sac]) > 0 || partHit(i)))
    .map((i, at) => ({ i, at, s: q ? score(query, [i.name, i.code, i.sac]) : 0 })).sort((a, b) => b.s - a.s || a.at - b.at).map((x) => x.i);
  const count = (f: Filter) => items.filter((i) => (f === "all" ? i.status !== "archived" : f === "package" ? i.kind === "package" && i.status !== "archived" : f === "item" ? i.kind !== "package" && i.status !== "archived" : i.status === f)).length;
  const drafts = count("draft");
  const lowStock = items.filter((i) => i.trackStock && i.status !== "archived" && i.reorderLevel !== null && (i.onHand ?? 0) <= i.reorderLevel).length;
  const pkgs = shown.filter((i) => i.kind === "package"), rest = shown.filter((i) => i.kind !== "package");
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function cleanStart() {
    if (!window.confirm(`Archive the ${startClean} item${startClean === 1 ? "" : "s"} drafted for you from the cost sheet and past invoices? Each one is kept, with its history, under Archived; you add your own items after.`)) return;
    setBusy(true);
    try {
      const r = await post<{ archived: number }>("erp/catalog/start-clean", {});
      notify({ id: "erp-clean", tone: "success", title: `${r.archived} item${r.archived === 1 ? "" : "s"} archived`, message: "The catalogue starts clean: add what you sell with New item.", timeout: 4000 });
      router.refresh();
    } catch (e) { notify({ id: "erp-clean", tone: "error", title: "Not done", message: e instanceof Error ? e.message : "Could not archive" }); }
    finally { setBusy(false); }
  }
  async function saveParts(pkgId: string, parts: Part[], what: string) {
    setBusy(true);
    try {
      await post(`erp/items/${pkgId}/parts`, { parts });
      notify({ id: "erp-part", tone: "success", title: what, message: "Saved as a new version of the package", timeout: 3000 });
      setEditing(null); router.refresh();
    } catch (e) { notify({ id: "erp-part", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Could not save" }); }
    finally { setBusy(false); }
  }
  const edited = editing ? items.find((i) => i.id === editing.pkg) : null;
  const editedParts = editing ? packages[editing.pkg]?.parts ?? [] : [];

  return <>
    <StatTiles label="Catalogue at a glance">
      <StatTile label="Packages" value={count("package")} />
      <StatTile label="Services and products" value={count("item")} />
      <StatTile label={free ? "Drafted for you" : "To approve"} value={drafts} tone={drafts ? "warn" : undefined} sub={drafts ? free ? "not offered until you use them" : "drafted for you" : "none"} />
      <StatTile label={inventory ? "Low stock" : "Archived"} value={inventory ? lowStock : count("archived")} tone={inventory && lowStock ? "warn" : undefined} />
    </StatTiles>
    {free && startClean ? <Notice tone="warning" action={<button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void cleanStart()}>Start clean</button>}>
      <b>{startClean} {startClean === 1 ? "item was" : "items were"} drafted for you</b> from the package cost sheet and past invoices. Start clean archives them (each is kept, with its history) so you and your salespeople add the final items by hand.</Notice>
      : !free && drafts && canWrite && filter !== "draft" ? <Notice tone="warning" action={<button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setFilter("draft")}>Show them</button>}>
      <b>{drafts} {drafts === 1 ? "item waits" : "items wait"} for approval.</b> Drafted from the package cost sheet and past invoices: open each, check its price and SAC, then approve it.</Notice> : null}
    <div className={css.toolbar}>
      <ChipFilter label="Show" value={filter} onChange={setFilter} hideEmpty chips={[{ value: "all", label: "All", count: count("all") }, { value: "package", label: "Packages", count: count("package") },
        { value: "item", label: "Services & products", count: count("item") }, { value: "draft", label: free ? "Drafted" : "To approve", count: drafts, tone: "warning", dot: true }, { value: "archived", label: "Archived", count: count("archived") }]} />
      <label className={css.search}><Search size={15} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, codes, SAC, parts" aria-label="Search the catalogue" /></label>
    </div>
    {!shown.length ? q ? <EmptyState icon={<SearchX size={18} aria-hidden="true" />} title={`Nothing matches “${query}”`} text="Case, spaces and punctuation never matter: try part of the name, the code or the SAC."
        action={<button type="button" className={styles.btn} onClick={() => { setQuery(""); setFilter("all"); }}>Clear the search</button>} />
      : <EmptyState icon={<PackageOpen size={18} aria-hidden="true" />} title={filter === "all" ? "Nothing in the catalogue yet" : "Nothing here"}
        text={filter === "all" ? "Add what you sell: a service, a product or a package of them. Quotations then pick from it, with the price and SAC filled in." : "Choose All to see the rest of the catalogue."}
        action={filter !== "all" ? <button type="button" className={styles.btn} onClick={() => setFilter("all")}>Show all</button> : undefined} /> : null}
    {pkgs.length ? <section className={css.group} aria-label="Packages">
      {filter === "all" || filter === "draft" ? <h3 className={css.groupHead}>Packages <span>{pkgs.length}</span></h3> : null}
      {/* UX-BILLING (review): packages are stripe rows too, as services and products are; a package folds open to its parts. */}
      <Card label="Packages" flat><StripeList label="Packages">{pkgs.map((i) => {
        const info = packages[i.id], expanded = open.has(i.id) || partHit(i), m = show("costMargin") ? marginPercent(i.price, i.cost) : null;
        return <PackageRow setup={setup} key={i.id} item={i} info={info} expanded={expanded} margin={m} canWrite={canWrite && (!ownOnly || !!i.mine)} statusLabel={statusLabel} onToggle={() => toggle(i.id)}
          onPart={(index) => setEditing({ pkg: i.id, index })} />;
      })}</StripeList></Card>
    </section> : null}
    {rest.length ? <section className={css.group} aria-label="Services and products">
      {filter === "all" || filter === "draft" ? <h3 className={css.groupHead}>Services & products <span>{rest.length}</span></h3> : null}
      <Card label="Services and products" flat><StripeList label="Services and products">{rest.map((i) => {
        const n = usedIn.get(i.id) ?? 0;
        const low = inventory && i.trackStock && i.reorderLevel !== null && (i.onHand ?? 0) <= i.reorderLevel;
        return <StripeRow key={i.id} href={`/erp/catalog/${i.id}`} title={i.name} tone={i.status === "draft" || low ? "warning" : i.status === "archived" ? "neutral" : "accent"}
          sub={[KIND_LABEL[i.kind], n ? `in ${n} package${n === 1 ? "" : "s"}` : null, i.sac ? `SAC ${i.sac}` : null, inventory && i.trackStock ? `${i.onHand ?? 0} ${i.unit} on hand` : null].filter(Boolean).join(" · ")}
          amount={i.price ? `${rupees(i.price)}${i.unit !== "nos" ? ` / ${i.unit}` : ""}` : "No price"}
          badge={i.status !== "active" ? <Badge tone={STATUS_TONE[i.status]}>{statusLabel(i.status)}</Badge> : low ? <Badge tone="warning">Low stock</Badge> : undefined} />;
      })}</StripeList></Card>
    </section> : null}
    {editing && edited ? <PartDrawer setup={setup} key={`${editing.pkg}:${editing.index}`} packageName={edited.name} options={options} readOnly={!canWrite} busy={busy}
      part={editing.index === null ? EMPTY_PART : editedParts[editing.index]} isNew={editing.index === null} doneLabel={editing.index === null ? "Add part" : "Save part"}
      onClose={() => setEditing(null)}
      onDone={(p) => saveParts(editing.pkg, editing.index === null ? [...editedParts, p] : editedParts.map((x, n) => (n === editing.index ? p : x)), editing.index === null ? "Part added" : "Part saved")}
      onRemove={editing.index === null ? undefined : () => saveParts(editing.pkg, editedParts.filter((_, n) => n !== editing.index), "Part removed")} /> : null}
  </>;
}

function PackageRow({ setup, item: i, info, expanded, margin, canWrite, statusLabel = (st) => STATUS_LABEL[st], onToggle, onPart }: { setup?: BillingSetup; item: CatalogItem; info: PackageInfo | null | undefined; expanded: boolean; margin: number | null; canWrite: boolean;
  statusLabel?: (st: CatalogItem["status"]) => string; onToggle: () => void; onPart: (index: number | null) => void }) {
  const show = (key: Parameters<typeof showField>[1]) => showField(setup, key);
  const id = `pkg-${i.id}`;
  const parts = info?.parts ?? [], t = partTotals(parts);
  return <>
    <StripeRow onClick={onToggle} expanded={expanded} controls={id} tone={i.status === "draft" ? "warning" : i.status === "archived" ? "neutral" : "accent"}
      lead={<ChevronRight size={16} className={css.chev} data-open={expanded ? "" : undefined} aria-hidden="true" />} label={`${i.name}: ${expanded ? "fold the parts away" : "show the parts"}`}
      title={i.name} sub={[`${i.parts ?? parts.length} part${(i.parts ?? parts.length) === 1 ? "" : "s"}`, `+${i.gstRate}% GST`, margin !== null ? `margin ${margin}%` : null, i.sac ? `SAC ${i.sac}` : null, `v${i.version}`].filter(Boolean).join(" · ")}
      amount={rupees(i.price)} badge={i.status !== "active" ? <Badge tone={STATUS_TONE[i.status]}>{statusLabel(i.status)}</Badge> : undefined} />
    {expanded ? <li id={id} className={css.pkgParts}>
      {info ? <>
        <LineList label={`Parts of ${i.name}`} className={css.partList}>{parts.map((p, n) => {
          const team = show("partSetup") ? teamText(p.setup) : "", qty = qtyText(p);
          return <LineRow key={p.id ?? n} onOpen={() => onPart(n)} title={p.label} tone={p.price === null ? "muted" : undefined}
            sub={[qty, p.price === null ? "free part" : null, team || null, show("partSetup") && p.price === null && p.derives ? p.derives : null].filter(Boolean).join(" · ") || undefined}
            amount={p.price === null ? "—" : rupees(p.price)} amountSub={show("costMargin") && p.cost !== null ? `cost ${rupees(p.cost)}` : undefined} />;
        })}</LineList>
        {show("months") ? info.milestones.length ? <p className={css.milestones} aria-label="Billing plan">{info.milestones.map((m, n) => <span key={n} className={css.chip}>{milestoneText(m)}</span>)}</p>
          : <p className={css.hint}>No billing plan: a sale is billed in full when it starts.</p> : null}
        <div className={css.pkgFoot}>
          <span className={css.hint}>{parts.length ? <>Parts add up to <b>{rupees(t.price)}</b>{show("costMargin") && t.cost ? <> (cost {rupees(t.cost)})</> : null}; the package sells for <b>{rupees(i.price)}</b>.</> : "No parts yet."}</span>
          {canWrite ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onPart(null)}><Plus size={13} aria-hidden="true" />Part</button> : null}
          <Link className={`${styles.btn} ${styles.btnSmall}`} href={`/erp/catalog/${i.id}`}>Open package<ArrowRight size={13} aria-hidden="true" /></Link>
        </div>
      </> : <p className={css.hint}>The parts could not be loaded. <Link href={`/erp/catalog/${i.id}`}>Open the package</Link>.</p>}
    </li> : null}
  </>;
}
