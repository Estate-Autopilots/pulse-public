import { api, type Me } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { STEPS, type StepKey } from "../steps";
import { Wizard } from "../wizard";
import type { Setup } from "../types";

// UX-TENANT: one company's setup, step by step (?step=company|brand|admin|people|structure|settings|open).
export default async function CompanySetup({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const me = await api<Me>("me");
  if (me.error || !me.data) return <Message text={me.error ?? "Sign in to Pulse"} />;
  if (!me.data.operator) return <Message text="Companies are set up by an admin of this install's own company." />;
  if (!/^[0-9a-f-]{36}$/.test(id)) return <Message text="Setup not found" />;
  const r = await api<Setup>(`tenants/${id}`);
  if (r.error || !r.data) return <Message text={r.error ?? "Setup not found"} />;
  const step = (STEPS.find((s) => s.key === q.step)?.key ?? (r.data.org ? "open" : "company")) as StepKey;
  return <Page>
    <PageHeader title={r.data.org?.name ?? r.data.name} context={["Company setup", STEPS.find((s) => s.key === step)?.label ?? ""]} back={{ href: "/companies", label: "Companies" }} recent={false} />
    <Wizard key={`${r.data.id}:${step}`} initial={r.data} step={step} />
  </Page>;
}
