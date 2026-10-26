import { Boxes } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Empty, Message, Page, PageHeader, Panel } from "../../ui";
import { LineList, LineRow } from "../../kit/line-row";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import type { CatalogItem } from "../types";
import css from "../erp.module.css";

/** ERP-INVOICE: stock of physical and consumable items (brochures, standees, printed material). Off for a service-only
 *  company; each movement (in, out, adjustment) is kept as recorded and a low-stock level raises an alert. */
export default async function Inventory() {
  const r = await api<{ items: CatalogItem[]; inventoryEnabled: boolean; canWrite: boolean }>("erp/items");
  if (!r.data) return <Message text={r.error ?? "Inventory is unavailable"} />;
  const tracked = r.data.items.filter((i) => i.trackStock && i.status !== "archived");
  const low = tracked.filter((i) => i.reorderLevel !== null && (i.onHand ?? 0) <= i.reorderLevel);
  return <Page>
    <PageHeader title="Stock" context={[ERP_CONTEXT, r.data.inventoryEnabled ? `${tracked.length} items in stock · ${low.length} low` : "Off"]} />
    <ErpNav current="inventory" inventory />
    <div className={css.body}>
      {!r.data.inventoryEnabled ? <Panel title="Stock is off">
        <Empty icon={Boxes} first title="This company keeps no stock" text="A service company sells time and work, not goods. Turn stock on in Billing settings when you sell or use physical or consumable items: brochures, standees, printed site boards, equipment."
          action={r.data.canWrite ? { href: "/erp/settings", label: "Open settings" } : undefined} />
      </Panel> : <Panel title="Stock" sub="Open an item to record stock in or out">
        {tracked.length ? <LineList label="Stocked items">{tracked.map((i) => {
          const isLow = i.reorderLevel !== null && (i.onHand ?? 0) <= i.reorderLevel;
          return <LineRow key={i.id} href={`/erp/catalog/${i.id}`} stack title={i.name} tone={isLow ? "needed" : undefined}
            sub={`${i.kind}${i.reorderLevel !== null ? ` · reorder at ${i.reorderLevel} ${i.unit}` : " · no low-stock level"}`}
            amount={`${i.onHand ?? 0} ${i.unit}`} end={isLow ? <Badge tone="warning">Low stock</Badge> : <Badge tone="success">OK</Badge>} />;
        })}</LineList> : <Empty icon={Boxes} compact title="No stocked items yet" text="Create a product or consumable in the Catalogue and tick “Keep stock of it”." action={{ href: "/erp/catalog", label: "Catalogue" }} />}
      </Panel>}
    </div>
  </Page>;
}
