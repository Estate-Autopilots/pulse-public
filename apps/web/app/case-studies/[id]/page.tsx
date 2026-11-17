import { api } from "../../lib/api";
import { GamePage, PageHeader } from "../../kit/game";
import { CaseListError } from "../list";
import type { CaseFile } from "../model";
import { CaseFileView } from "./case-file";

export const dynamic = "force-dynamic";

/** CASE-STUDIES: one company's case file (services/api/src/case-studies.ts). */
export default async function CaseFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<{ case: CaseFile }>(`case-studies/${encodeURIComponent(id)}`);
  if (!r.data) return <GamePage label="Case study"><PageHeader title="Case study" /><CaseListError text={r.error ?? "This case study did not load."} /></GamePage>;
  return <CaseFileView key={r.data.case.id} initial={r.data.case} />;
}
