"use client";
// MAILBOX: finish the company mailbox's Google sign-in (posts Google's one-time code and state once), then back to
// Settings → Mail. Google's "access_denied" (the admin pressed Cancel) is said plainly; nothing was connected.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, MailCheck } from "lucide-react";
import { post } from "../../../records";
import { Empty, Panel, styles } from "../../../ui";
import { connectMailbox } from "../../mailbox";

export function FinishMailbox({ code, state, error }: { code: string; state: string; error: string }) {
  const router = useRouter(), started = useRef(false);
  const [problem, setProblem] = useState(error ? (error === "access_denied" ? "Google sign-in was cancelled, so nothing was connected." : `Google did not connect the mailbox (${error.slice(0, 60)}).`)
    : !code || !state ? "Google did not send Pulse back a sign-in. Press Connect again." : "");
  useEffect(() => {
    if (started.current || error || !code || !state) return;
    started.current = true;
    // The code is used once; take it out of the address bar and history straight away.
    window.history.replaceState(null, "", "/settings/mailbox/google");
    post("mailbox/google/finish", { code, state })
      .then(() => router.replace("/settings?tab=mail&mailbox=connected"))
      .catch((e) => setProblem(e instanceof Error ? e.message : "The mailbox was not connected."));
  }, [code, state, error, router]);
  return <Panel title="Connecting the company mailbox">
    {problem ? <Empty icon={CircleAlert} title="The mailbox was not connected" text={problem}>
      <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void connectMailbox()}><MailCheck size={14} aria-hidden="true" />Connect again</button>
    </Empty> : <Empty icon={MailCheck} title="Connecting…" text="Pulse is checking the Google sign-in. This takes a few seconds." />}
  </Panel>;
}
