import { read } from "@/app/lib/api";
import type { AuditRow } from "@/app/lib/types";
import { Page, PageHeader, Panel, QueryTabs, Unavailable } from "@/app/ui/kit";
import { AuditTable } from "@/app/ui/parts";

// PULSE-ADMIN: the platform audit log: every look into an organisation and every change, with who and why. Append-only;
// each entry about an organisation is also in that organisation's own Audit.
export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const raw = (await searchParams).action ?? "";
  const action = ["org", "person", "flag", "announcement", "people", "accounts"].includes(raw) ? raw : "";
  const r = await read<{ entries: AuditRow[] }>(`platform/audit${action ? `?action=${action}.` : ""}`);
  return (
    <Page wide>
      <PageHeader title="Audit log" context={["Append-only", "Also in each organisation’s own Audit"]} />
      <QueryTabs base="/audit" param="action" current={action || "all"}
        items={[{ key: "all", label: "All" }, { key: "org", label: "Organisations" }, { key: "person", label: "People" }, { key: "flag", label: "Switches" }, { key: "announcement", label: "Announcements" }, { key: "people", label: "Searches" }]} />
      <Panel title="Platform audit log">
        {r.error || !r.data ? <Unavailable title="The audit log" reason={r.error ?? "No answer"} /> : <AuditTable rows={r.data.entries} />}
      </Panel>
    </Page>
  );
}
