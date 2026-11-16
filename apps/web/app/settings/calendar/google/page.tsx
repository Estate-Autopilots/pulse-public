import { Page, PageHeader } from "../../../ui";
import { FinishCalendar } from "./finish";

// GAP-FOUNDER-VIEW (PM-08): Google sends the person back here after "Connect Google Calendar" (the redirect URI in the
// Google Cloud console: https://<the Pulse address>/settings/calendar/google). The page hands the one-time code and state
// to the API, which checks they belong to this person's own session before it keeps anything.
export default async function CalendarGoogle({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  return <Page fit>
    <PageHeader title="Settings" context={["Your account"]} back={{ href: "/settings?tab=account", label: "Your account" }} />
    <FinishCalendar code={q.code ?? ""} state={q.state ?? ""} error={q.error ?? ""} />
  </Page>;
}
