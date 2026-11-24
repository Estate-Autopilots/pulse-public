import { api, getMe, holdAtGate } from "../lib/api";
import type { DayData } from "../lib/my-day.mjs";
import { Message, Page } from "../ui";
import { MyDay } from "./my-day";
import { MyStepCards } from "./step-cards";
import { Suspense } from "react";
import { QuoteFollowUps } from "../quote-follow-ups";
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
  return <Page><FirstRunCard />{/* QUOTE-FIXES: the person's quotes not sent yet and their next follow-ups, above the day */}<Suspense fallback={null}><QuoteFollowUps /></Suspense><Suspense fallback={null}><MyStepCards /></Suspense><MyDay initial={r.data} name={me.data?.name ?? null} />{me.data?.side === "staff" ? <MyGoals data={goals.data ?? null} /> : null}<MyContracts mine={contracts.data?.mine ?? null} /></Page>;
}
