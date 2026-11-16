import type { PeriodParams } from "../lib/format";
import { getMe } from "../lib/api";
import { Message } from "../ui";
import { WeeklyView } from "../weekly-views";
import { PersonalMyWeek } from "./personal-my-week";

export default async function MyWeek({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const params = await searchParams;
  const viewer = await getMe();
  if (viewer.data === undefined) return <Message text={viewer.error ?? "This view is unavailable."} />;

  // VISUAL-QA (10 Nov 2026): "My week" is the person's own week for every staff seat with a person (the API's own-week
  // rule: /v1/editors/:person/week). Admins and leadership got the team's week titled "Leadership" under a "My week"
  // menu entry, and managers, HR and Finance got "Your personal week is unavailable". The team's week is Leadership.
  if (viewer.data.person && viewer.data.side !== "client") return <PersonalMyWeek personId={viewer.data.person} week={params.week} />;
  if (viewer.data.role === "admin" || viewer.data.role === "leadership") return <WeeklyView section="leadership" params={params} />;
  return <Message text="Your personal week is unavailable for this account." />;
}
