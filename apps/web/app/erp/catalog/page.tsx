import type { BillingSetup } from "../settings/fields";
import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import type { CatalogItem, Part } from "../types";
import { CatalogList } from "./list";
import type { Milestone, PackageInfo } from "./model";
import { NewItem } from "./table";
import css from "./catalog.module.css";

export const metadata = { title: "Catalogue · Billing" };

// BILLING (18 Oct 2026): every package's parts load with the page (a handful of packages, four at a time), so a package
// folds open at once and each service shows how many packages use it.
async function packageInfo(ids: string[]) {
  const out: Record<string, PackageInfo | null> = {};
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(ids.slice(i, i + 4).map(async (id) => {
      const r = await api<{ item: { milestones?: Milestone[] | null }; parts: Part[] }>(`erp/items/${encodeURIComponent(id)}`);
      out[id] = r.data ? { parts: r.data.parts, milestones: r.data.item.milestones ?? [] } : null;
    }));
  }
  return out;
}

const VIEWS = ["all", "package", "item", "draft", "archived"] as const;

export default async function Catalog({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view;
  const [r, setup] = await Promise.all([api<{ items: CatalogItem[]; inventoryEnabled: boolean; canWrite: boolean }>("erp/items"), api<BillingSetup>("erp/setup")]);
  if (!setup.data && setup.status !== 404) return <Message text={setup.error ?? "Billing setup is unavailable"} />;
  if (!r.data) return <Message text={r.error ?? "The catalog is unavailable"} />;
  const items = r.data.items;
  const packages = await packageInfo(items.filter((i) => i.kind === "package").map((i) => i.id));
  const n = (kind: "package" | "other") => items.filter((i) => i.status !== "archived" && (kind === "package") === (i.kind === "package")).length;
  return <Page>
    <PageHeader title="Catalogue" context={["Billing", `${n("package")} packages · ${n("other")} services and products`]} actions={r.data.canWrite ? <NewItem setup={setup.data} /> : undefined} />
    <ErpNav current="catalog" inventory={r.data.inventoryEnabled} />
    <div className={css.body}>
      <CatalogList initialFilter={VIEWS.find((v) => v === view) ?? "all"} items={items} packages={packages} inventory={r.data.inventoryEnabled} canWrite={r.data.canWrite} setup={setup.data} />
    </div>
  </Page>;
}
