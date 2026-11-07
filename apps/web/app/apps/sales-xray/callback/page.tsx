"use client";
// EST-1363: where Sales X-Ray sends the person back after its consent screen. The one-time code and state leave the
// address bar at once and go to Pulse's API in the body; the API checks the state belongs to this person and swaps the
// code on the server. Then back to the app. The page sends no referrer (proxy.ts sets no-referrer for every page).
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, PlugZap } from "lucide-react";
import { Empty, Page, Panel, styles } from "../../../ui";

export default function SalesXrayCallback() {
  const router = useRouter();
  const sent = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const query = new URLSearchParams(window.location.search);
    const body = { state: query.get("state") ?? "", ...(query.get("code") ? { code: query.get("code")! } : {}), ...(query.get("error") ? { error: query.get("error")!.slice(0, 100) } : {}) };
    window.history.replaceState(null, "", "/apps/sales-xray/callback");
    void fetch("/api/v0/sales-xray/callback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t finish connecting Sales X-Ray. Press Connect again.");
        if (data?.connected) router.replace("/apps/sales-xray");
        else setProblem(data?.reason === "cancelled" ? "You cancelled on Sales X-Ray, so nothing was connected." : "Sales X-Ray didn’t connect. Press Connect again.");
      })
      .catch((e: Error) => setProblem(e.message));
  }, [router]);
  return (
    <Page>
      <Panel title="Sales X-Ray">
        {problem ? <Empty icon={CircleAlert} title="Not connected" text={problem} action={{ href: "/apps/sales-xray", label: "Back to Sales X-Ray" }} />
          : <Empty icon={PlugZap} title="Connecting Sales X-Ray…" text="Pulse is finishing the sign-in with Sales X-Ray.">
            <span className={styles.muted} aria-busy="true">One moment</span>
          </Empty>}
      </Panel>
    </Page>
  );
}
