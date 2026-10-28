import { api } from "../lib/api";
import { Page, PageHeader } from "../ui";
import { ConnectApproval, type PairRequest } from "./approval";

// "Sign in with your Pulse account" from the desktop, phone or Chrome app lands here with the app's code.
// The person checks that the code matches the app and approves; the app then collects its own device credential.
export default async function Connect({ searchParams }: { searchParams: Promise<{ code?: string; expected?:string }> }) {
  const { code,expected } = await searchParams;
  const clean = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const r = clean.length === 8 ? await api<PairRequest>(`native/pair/${clean.slice(0, 4)}-${clean.slice(4)}`) : null;
  return (
    <Page fit>
      <PageHeader title="Connect a Pulse app" context={["Desktop, phone and Chrome", "Your account"]} />
      <ConnectApproval expected={expected??null} initial={r?.data ?? null} error={r?.error ?? null} code={clean ? `${clean.slice(0, 4)}${clean.length > 4 ? "-" + clean.slice(4, 8) : ""}` : ""} />
    </Page>
  );
}
