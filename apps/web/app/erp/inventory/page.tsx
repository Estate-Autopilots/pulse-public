import Link from "next/link";
import { AlertTriangle, Boxes, PackagePlus, ScanBarcode } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Message, Page, PageHeader, styles } from "../../ui";
import { Calm, CalmGrid, Card, EmptyState, PRIMARY, SectionHeader, StartWith, StatTile, StatTiles, StripeList, StripeRow, Quiet, type Pick } from "../../components/calm";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import type { CatalogItem } from "../types";

export const metadata = { title: "Stock · Billing" };

/** ERP-INVOICE: stock of physical and consumable items (brochures, standees, printed material). Off for a service-only
 *  company; each movement (in, out, adjustment) is kept as recorded and a low-stock level raises an alert.
 *  UX-BILLING (owner, 5 Nov 2026: Work → My day is the standard): four figures, a numbered "Start with" of what to
 *  reorder, every stocked item a row with a stripe (amber when low), and one main action, Stock in, on the item that
 *  needs it most. Stock off, or nothing stocked yet, says what to do and has the button for it. */
export default async function Inventory() {
  const r = await api<{ items: CatalogItem[]; inventoryEnabled: boolean; canWrite: boolean }>("erp/items");
  if (!r.data) return <Message text={r.error ?? "Inventory is unavailable"} />;
  const tracked = r.data.items.filter((i) => i.trackStock && i.status !== "archived");
  const isLow = (i: CatalogItem) => i.reorderLevel !== null && (i.onHand ?? 0) <= i.reorderLevel;
  const low = tracked.filter(isLow).sort((a, b) => (a.onHand ?? 0) - (b.onHand ?? 0));
  const out = tracked.filter((i) => (i.onHand ?? 0) <= 0);
  const serialised = tracked.filter((i) => (i as CatalogItem & { serialised?: boolean }).serialised);
  const first = low[0] ?? tracked[0];
  const w = r.data.canWrite;
  const picks: Pick[] = low.slice(0, 5).map((i) => ({ key: i.id, href: `/erp/catalog/${i.id}`, tone: (i.onHand ?? 0) <= 0 ? "danger" : "warning", icon: <AlertTriangle size={14} aria-hidden="true" />,
    title: `Reorder ${i.name}`, sub: `${i.onHand ?? 0} ${i.unit} left · low at ${i.reorderLevel} ${i.unit}` }));
  const main = !w ? undefined : !r.data.inventoryEnabled ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/settings#taxes" {...PRIMARY}>Turn stock on</Link>
    : first ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/erp/catalog/${first.id}#stock`} {...PRIMARY}><ScanBarcode size={14} aria-hidden="true" />Stock in{low.length ? `: ${first.name}` : ""}</Link>
    : <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/erp/catalog" {...PRIMARY}><PackagePlus size={14} aria-hidden="true" />Add a product</Link>;
  return <Page>
    <PageHeader title="Stock" context={[ERP_CONTEXT, r.data.inventoryEnabled ? `${tracked.length} stocked item${tracked.length === 1 ? "" : "s"} · ${low.length} low` : "Off"]} actions={main} />
    <ErpNav current="inventory" inventory />
    <Calm>
      {!r.data.inventoryEnabled ? <EmptyState icon={<Boxes size={18} aria-hidden="true" />} title="This company keeps no stock"
        text="A service company sells time and work, not goods. Turn stock on in Billing settings when you sell or use physical items: brochures, standees, site boards, equipment."
        action={<Link className={styles.btn} href="/erp/settings#taxes">Turn stock on in settings</Link>} />
      : !tracked.length ? <EmptyState icon={<Boxes size={18} aria-hidden="true" />} title="No stocked items yet"
        text="Open a product or consumable in the Catalogue, then tick “Keep stock of it” under More details. Its stock in, out and serial numbers are kept from then on."
        action={<Link className={styles.btn} href="/erp/catalog">Open the catalogue</Link>} />
      : <>
        <StatTiles label="Stock at a glance">
          <StatTile label="Stocked items" value={tracked.length} />
          <StatTile label="Low" value={low.length} tone={low.length ? "warn" : "good"} sub={low.length ? "to reorder" : "all above their level"} />
          <StatTile label="Out of stock" value={out.length} tone={out.length ? "bad" : undefined} />
          <StatTile label="Serial-numbered" value={serialised.length} sub="each unit named" />
        </StatTiles>
        <CalmGrid railLabel="How stock moves" rail={<Card label="How stock moves">
          <SectionHeader icon={<ScanBarcode size={15} aria-hidden="true" />} title="How stock moves" />
          <Quiet>Open an item to record <b>stock in</b> (scan the serial numbers of each unit) or to <b>set the current stock</b> after a count. An approved tax invoice takes its units out by itself; a cancelled one puts them back.</Quiet>
        </Card>}>
          <StartWith picks={picks} icon={<AlertTriangle size={15} aria-hidden="true" />} title="Reorder first" empty="Nothing is low. An item shows here when it reaches its low-stock level." />
          <Card label="Stocked items" flat>
            <SectionHeader icon={<Boxes size={15} aria-hidden="true" />} title="Stocked items" count={tracked.length} />
            <StripeList label="Stocked items">{tracked.map((i) => {
              const l = isLow(i), none = (i.onHand ?? 0) <= 0;
              return <StripeRow key={i.id} href={`/erp/catalog/${i.id}`} tone={none ? "danger" : l ? "warning" : "success"} title={i.name}
                sub={[i.kind === "consumable" ? "Consumable" : "Product", i.reorderLevel !== null ? `low at ${i.reorderLevel} ${i.unit}` : "no low-stock level"].join(" · ")}
                amount={`${i.onHand ?? 0} ${i.unit}`} badge={<Badge tone={none ? "danger" : l ? "warning" : "success"}>{none ? "Out" : l ? "Low" : "OK"}</Badge>} />;
            })}</StripeList>
          </Card>
        </CalmGrid>
      </>}
    </Calm>
  </Page>;
}
