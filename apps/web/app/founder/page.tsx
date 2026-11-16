import { api, holdAtGate } from "../lib/api";
import type { FounderData } from "../lib/founder.mjs";
import { Founder } from "./founder";

export const dynamic = "force-dynamic";

/** GAP-FOUNDER-VIEW (MASTER-BACKLOG PW-06): every company this person runs, on one screen, in their own workspace. Each
 *  company is read inside itself, as them (services/api/src/founder.ts); opening one is the organisation switcher's switch. */
export default async function FounderPage() {
  await holdAtGate();
  const r = await api<FounderData>("founder");
  return <Founder data={r.data ?? null} error={r.data ? null : r.error ?? "Your companies could not be read just now."} />;
}
