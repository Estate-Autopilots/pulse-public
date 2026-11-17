import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { ErpNav } from "../nav";
import { ERP_CONTEXT } from "../parts";
import type { TemplatesData } from "../types";
import { TemplateList } from "./list";
import css from "../erp.module.css";

export default async function Templates() {
  const r = await api<TemplatesData>("erp/templates");
  if (!r.data) return <Message text={r.error ?? "Templates are unavailable"} />;
  return <Page>
    <PageHeader title="Templates" context={[ERP_CONTEXT, `${r.data.templates.filter((t) => !t.archived).length} templates`]} />
    <ErpNav current="templates" />
    <div className={css.body}>
      <TemplateList templates={r.data.templates} sample={r.data.sample} orgLogo={r.data.orgLogo} canWrite={r.data.canWrite} />
    </div>
  </Page>;
}
