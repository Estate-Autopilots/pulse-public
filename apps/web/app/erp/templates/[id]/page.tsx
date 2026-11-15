import { api } from "../../../lib/api";
import { Message, Page, PageHeader } from "../../../ui";
import { ErpNav } from "../../nav";
import type { TemplatesData } from "../../types";
import { TemplateEditor } from "./editor";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<TemplatesData>("erp/templates");
  if (!r.data) return <Message text={r.error ?? "Templates are unavailable"} />;
  const t = r.data.templates.find((x) => x.id === id);
  if (!t) return <Message text="This template is not in the list. It may have been archived." />;
  return <Page>
    <PageHeader title={t.name} back={{ href: "/erp/templates", label: "Templates" }} recent={{ title: t.name }}
      context={["Look, colour and blocks · the preview is the PDF as exported", (t.defaultFor ?? []).length ? `Default for ${(t.defaultFor ?? []).length} kind${(t.defaultFor ?? []).length === 1 ? "" : "s"} of document` : ""]} />
    <ErpNav current="templates" />
    <TemplateEditor key={t.updatedAt} template={t} company={r.data.company} orgLogo={r.data.orgLogo} canWrite={r.data.canWrite} />
  </Page>;
}
