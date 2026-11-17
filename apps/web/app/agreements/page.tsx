// AGREEMENTS (owner, 13 Nov 2026, P1.2: "a new module which clicks or agreement module"): the person's policies and
// agreements in one place. Mine: the current version of each company policy, accepted or waiting (accepted term by term
// in the acceptance view), earlier versions accepted, and the agreements naming them. Team (managers, HR, leadership,
// admins): who has not accepted the current versions yet. Concepts: reports/agreements-shots/concepts/hub (2 for Mine,
// 1 for Team).
import { api } from "../lib/api";
import type { Contract } from "../contracts/parts";
import type { MyPolicies } from "./accept-view";
import { AgreementsHub, type TeamStatus } from "./hub";

export const metadata = { title: "Agreements" };

export default async function AgreementsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const q = await searchParams;
  const [mine, contracts] = await Promise.all([api<MyPolicies>("agreements/policies"), api<{ mine: Contract[] }>("contracts/mine")]);
  const team = mine.data?.team ? await api<TeamStatus>("agreements/team") : null;
  return <AgreementsHub initial={mine.data ?? null} error={mine.data ? null : mine.error ?? "Agreements are not available right now"} contracts={contracts.data?.mine ?? []}
    team={team?.data ?? null} tab={q.tab === "team" && mine.data?.team ? "team" : "mine"} />;
}
