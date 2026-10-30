import { Page, PageHeader } from "../../../ui";
import { FinishMailbox } from "./finish";

// MAILBOX: Google sends the admin back here after "Connect Google Workspace mailbox" (the redirect URI registered in the
// Google Cloud console: https://<the company's Pulse address>/settings/mailbox/google). The page hands the one-time code
// and state to the API, which checks they belong to this admin's own session before it keeps anything.
export default async function MailboxGoogle({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  return <Page fit>
    <PageHeader title="Settings" context={["Mail"]} back={{ href: "/settings?tab=mail", label: "Mail" }} />
    <FinishMailbox code={q.code ?? ""} state={q.state ?? ""} error={q.error ?? ""} />
  </Page>;
}
