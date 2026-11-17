import { api } from "../lib/api";
import { GamePage, PageHeader } from "../kit/game";
import { CaseListView, CaseListError } from "./list";
import type { CaseList } from "./model";

export const dynamic = "force-dynamic";

/** CASE-STUDIES: every company on the 45-day journey, by stage (Growth → Case studies). */
export default async function CaseStudiesPage() {
  const r = await api<CaseList>("case-studies");
  if (!r.data) return <GamePage label="Case studies"><PageHeader title="Case studies" /><CaseListError text={r.error ?? "Case studies did not load."} /></GamePage>;
  return <CaseListView data={r.data} />;
}
