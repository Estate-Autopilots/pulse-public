"use client";
// CONNECTORS-CONTRACTS: where a connected app sends its admin back after signing in. The code and state are taken out of
// the address bar at once and posted to the API (once, same admin, 10 minutes); then back to Settings → Connectors.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "../../../orgs/client";

export default function ConnectorCallback() {
  const router = useRouter();
  const [text, setText] = useState("Finishing the sign-in…");
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const q = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    post("mcp-connectors/callback", { code: q.get("code") ?? undefined, state: q.get("state") ?? undefined, error: q.get("error") ?? undefined })
      .then(() => router.replace("/settings?tab=connectors"))
      .catch((e: unknown) => setText(e instanceof Error ? e.message : "The sign-in did not finish. Start again from Settings → Connectors."));
  }, [router]);
  return <main style={{ padding: 24, maxWidth: 560, margin: "0 auto" }}><p role="status">{text}</p></main>;
}
