import { api, getMe, holdAtGate } from "../lib/api";
import type { DayData } from "../lib/my-day.mjs";
import { Message, Page } from "../ui";
import { MyDay } from "./my-day";
import { PhoneNewButton } from "../tasks/phone-new";
import { FirstRunCard } from "../start/first-run-card";
import { MyGoals } from "../goals/my-goals";
import type { GoalsData } from "../goals/parts";
import { MyContracts } from "../contracts/my-contracts";
import type { Contract } from "../contracts/parts";

export const dynamic = "force-dynamic";

/** TASKUX (owner, 2 Nov 2026): one day across every organisation of the account. Each organisation is read inside itself
 *  (services/api/src/my-day.ts); opening an item moves into its organisation first. */
export default async function MyDayPage() {
  await holdAtGate();
  // CONNECTORS-CONTRACTS: the contracts naming this person, in any company (the shared part).
  const [r, me, goals, contracts] = await Promise.all([api<DayData>("tasks/my-day"), getMe(), api<GoalsData>("goals?who=me&status=active"), api<{ mine: Contract[] }>("contracts/mine")]);
  if (!r.data) return <Message text={r.error ?? "Your day is unavailable."} />;
  // PROJECTS-CREATE: a phone gets a visible "+ New" here too (the open company's Create dialog); C and N are desktop keys.
  // SELF-SERVE (1520): a personal space opens here, with its getting-started cards above the day.
  return <Page><FirstRunCard /><MyDay initial={r.data} name={me.data?.name ?? null} />{me.data?.side === "staff" ? <MyGoals data={goals.data ?? null} /> : null}<MyContracts mine={contracts.data?.mine ?? null} />{me.data?.side === "staff" ? <PhoneNewButton /> : null}</Page>;
}
