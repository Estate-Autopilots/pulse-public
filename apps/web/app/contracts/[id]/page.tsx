import { api } from "../../lib/api";
import { Message, Page } from "../../ui";
import type { ContractDetail } from "../parts";
import { ContractView } from "./contract-view";

export const dynamic = "force-dynamic";

/** CONNECTORS-CONTRACTS: one contract: its terms, parties and who accepted, versions, money under it, and (managers) its
 *  links and notes. A contract held by another company opens by its shared key (the shared part only). */
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return <Message text="Contract not found." />;
  const r = await api<ContractDetail>(`contracts/${id}`);
  if (!r.data) return <Message text={r.error ?? "This contract is unavailable."} />;
  return <Page><ContractView initial={r.data} /></Page>;
}
