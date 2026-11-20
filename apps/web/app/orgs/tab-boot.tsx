import { headers } from "next/headers";
import { TAB_SHIM } from "../lib/tab-org.mjs";

/** ORG-PER-TAB: the tab's company before the app starts (lib/tab-org.mjs): which company this page was drawn in
 *  (data-org), so the tab keeps its own; every call of the page then says which company it is for. Carries the
 *  request's CSP nonce like the e-mail guard (email-guard.tsx). */
export async function TabBoot({ org }: { org: string | null }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script id="pulse-tab-org" nonce={nonce} data-org={org ?? ""} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: TAB_SHIM }} />;
}
