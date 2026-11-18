"use client";
// EST-1363: where Sales X-Ray sends the person back after its consent screen. The one-time code and state leave the
// address bar at once and go to Pulse's API in the body; the API checks the state belongs to this person and swaps the
// code on the server. The page sends no referrer (proxy.ts sets no-referrer for every page).
// NAV-CONNECT (owner, 17 Nov 2026): then a clear result, as app stores do it: "Sales X-Ray is connected" with the company
// and the Sales X-Ray organisation side by side and the one next step; or, when Sales X-Ray gave an organisation that is
// not named like this company (or a Personal workspace), "Is this the right company?" (nothing is read until the
// person says yes or picks another).
import { useEffect, useRef, useState } from "react";
import { CircleAlert, PlugZap } from "lucide-react";
import { Empty, Page, PageHeader, Panel, styles } from "../../../ui";
import { CheckPanel, Connected } from "../connect";

type Account = { workspace?: string | null; kind?: "personal" | "organisation"; company?: string };
type Result = { connected: boolean; reason?: string; account?: Account; company?: { name: string };
  check?: { company: string; workspace: string | null; kind: "personal" | "organisation"; match: string } };

export default function SalesXrayCallback() {
  const sent = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const query = new URLSearchParams(window.location.search);
    const body = { state: query.get("state") ?? "", ...(query.get("code") ? { code: query.get("code")! } : {}), ...(query.get("error") ? { error: query.get("error")!.slice(0, 100) } : {}) };
    window.history.replaceState(null, "", "/apps/sales-xray/callback");
    void fetch("/api/v0/sales-xray/callback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => {
        const data = await r.json().catch(() => null) as (Result & { error?: string }) | null;
        if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t finish connecting Sales X-Ray. Press Connect again.");
        if (data?.connected || data?.check) setResult(data);
        else setProblem(data?.reason === "cancelled" ? "You cancelled on Sales X-Ray, so nothing was connected." : "Sales X-Ray didn’t connect. Press Connect again.");
      })
      .catch((e: Error) => setProblem(e.message));
  }, []);
  const check = result?.check;
  const company = check?.company ?? result?.company?.name ?? result?.account?.company ?? "this company";
  return (
    <Page>
      <PageHeader title="Sales X-Ray" back={{ href: "/apps", label: "Apps" }} context={result?.check ? [`For ${company}`] : undefined} />
      {problem ? <Panel title="Sales X-Ray"><Empty icon={CircleAlert} title="Not connected" text={problem} action={{ href: "/apps/sales-xray", label: "Back to Sales X-Ray" }} /></Panel>
        : check ? <CheckPanel company={company} workspace={check.workspace} personal={check.kind === "personal"}
            onDone={() => setResult({ connected: true, company: { name: company }, account: { workspace: check.workspace, kind: check.kind } })} />
        : result?.connected ? <Connected company={company} workspace={result.account?.workspace ?? null} personal={result.account?.kind === "personal"} />
        : <Panel title="Sales X-Ray"><Empty icon={PlugZap} title="Connecting Sales X-Ray…" text="Pulse is finishing the sign-in with Sales X-Ray.">
            <span className={styles.muted} aria-busy="true">One moment</span>
          </Empty></Panel>}
    </Page>
  );
}
