import type { PeriodParams } from "../lib/format";
import { getMe } from "../lib/api";
import { Message } from "../ui";
import { WeeklyView } from "../weekly-views";
import { PersonalMyWeek } from "./personal-my-week";

export default async function MyWeek({ searchParams }: { searchParams: Promise<PeriodParams> }) {
  const params = await searchParams;
  const viewer = await getMe();
  if (viewer.data === undefined) return <Message text={viewer.error ?? "This view is unavailable."} />;

  if (viewer.data.role === "admin" || viewer.data.role === "leadership") {
    return <WeeklyView section="leadership" params={params} />;
  }
  if (viewer.data.role !== "person" || !viewer.data.person) {
    return <Message text="Your personal week is unavailable for this account." />;
  }

  return <PersonalMyWeek personId={viewer.data.person} week={params.week} />;
}
