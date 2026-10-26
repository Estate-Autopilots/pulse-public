import type { BillingSetup } from "../../settings/fields";
import type { ComponentProps } from "react";
import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { ErpNav } from "../../nav";
import type { TemplatesData } from "../../types";
import { ItemEditor } from "./item";

type Data = ComponentProps<typeof ItemEditor>["data"];

export default async function CatalogItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [r, t, setup] = await Promise.all([api<Data>(`erp/items/${encodeURIComponent(id)}`), api<TemplatesData>("erp/templates"), api<BillingSetup>("erp/setup")]);
  if (!setup.data && setup.status !== 404) return <Message text={setup.error ?? "Billing setup is unavailable"} />;
  if (!r.data) return <Message text={r.error ?? "This item is unavailable"} />;
  const i = r.data.item;
  // BILLING: the customer's copy is drawn with the company's quotation template (its default, else the first one).
  const live = t.data?.templates.filter((x) => !x.archived) ?? [];
  const template = live.find((x) => x.defaultFor?.includes("quotation")) ?? live.find((x) => x.docTypes.includes("quotation")) ?? live[0] ?? null;
  const preview = t.data ? { design: template?.design ?? {}, logoId: template?.logoId ?? (t.data.orgLogo ? "org-logo" : null), signatureId: template?.signatureId ?? null, sample: t.data.sample, template: template?.name ?? null } : null;
  return <Page>
    <PageHeader title={i.name} back={{ href: "/erp/catalog", label: "Catalogue" }} recent={{ title: i.name }}
      context={[i.kind === "package" ? `Package · ${r.data.parts.length} parts` : i.kind[0].toUpperCase() + i.kind.slice(1), i.sac ? `SAC ${i.sac}` : "", `v${i.version}`]} />
    <ErpNav current="catalog" inventory={r.data.inventoryEnabled} />
    <ItemEditor key={`${i.id}:${i.version}:${i.updatedAt}`} data={r.data} preview={preview} setup={setup.data} />
  </Page>;
}
