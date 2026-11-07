"use client";

import { Link2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { Badge, Empty, Fit, Panel, styles } from "../ui";
import css from "./panels.module.css";

export type ClaimableUploaderAccount = {
  id: string;
  handle: string;
  deliveryCount: number;
  lastDelivery: string;
};

export type UploaderAccountClaim = {
  id: string;
  accountId: string;
  handle: string;
  personId: string;
  personName?: string;
  status: "pending" | "confirmed" | "rejected" | "reverted";
  createdAt: string;
  reason?: string | null;
};

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Date unavailable" : date.toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });
}

function claimStatus(status: UploaderAccountClaim["status"]) {
  return status === "pending" ? "Waiting for confirmation"
    : status === "confirmed" ? "Confirmed"
      : status === "rejected" ? "Not confirmed" : "Unlinked";
}

function useClaimAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  async function run(path: string, body: unknown, done: string, id: string) {
    setBusy(id);
    setProblem("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not update this claim.");
      window.dispatchEvent(new Event("pulse:data-changed"));
      notify({ id: "account-claims", tone: "success", title: done, timeout: 2500 });
      router.refresh();
    } catch (error) {
      setProblem(!navigator.onLine
        ? "You are offline. Reconnect, then try again."
        : error instanceof TypeError
          ? "The data service could not be reached. Refresh to try again."
          : error instanceof Error ? error.message : "Could not update this claim.");
    } finally {
      setBusy(null);
    }
  }
  return { busy, problem, run, clearProblem: () => setProblem("") };
}

/** The signed-in person sees only accounts in their work projects and their own claim history. */
export function MyUploadAccounts({ accounts, claims, accountError, claimsError }: {
  accounts: ClaimableUploaderAccount[];
  claims: UploaderAccountClaim[];
  accountError?: string;
  claimsError?: string;
}) {
  const { busy, problem, run, clearProblem } = useClaimAction();
  return (
    <Fit className={css.grid}>
      <Panel fill title="Accounts to claim" sub="Personal uploader accounts from your projects">
        {accountError ? <div role="alert" className={styles.empty}>
          <p className={styles.emptyTitle}>Accounts could not load</p>
          <p className={styles.emptyText}>{accountError}</p>
          <button type="button" className={styles.btn} onClick={() => window.location.reload()}>Try again</button>
        </div> : accounts.length ? <ul className={styles.list}>
          {accounts.map((account) => <li key={account.id} className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{account.handle}</span>
              <span className={styles.rowMeta}>{account.deliveryCount} {account.deliveryCount === 1 ? "delivery" : "deliveries"} · latest {dateLabel(account.lastDelivery)}</span>
            </span>
            <span className={styles.rowEnd}>
              <button type="button" className={styles.btn + " " + styles.btnSmall} disabled={busy !== null}
                onClick={() => run("/api/v1/accounts/" + encodeURIComponent(account.id) + "/claim", {}, "Claim sent for review", account.id)}>
                {busy === account.id ? "Sending…" : "Claim account"}
              </button>
            </span>
          </li>)}
        </ul> : <Empty icon={Link2} title="No accounts to claim" text="Personal uploader accounts used in your projects appear here when they are not linked to anyone. Shared logins and client accounts are excluded." />}
        {problem ? <p role="alert" className={styles.panelFoot}>{problem} <button type="button" className={styles.btn} onClick={clearProblem}>Dismiss</button></p> : null}
      </Panel>
      <Panel fill title="Your account claims" sub={claims.length + " recorded"}>
        {claimsError ? <div role="alert" className={styles.empty}>
          <p className={styles.emptyTitle}>Claim history could not load</p>
          <p className={styles.emptyText}>{claimsError}</p>
          <button type="button" className={styles.btn} onClick={() => window.location.reload()}>Try again</button>
        </div> : claims.length ? <ul className={styles.list}>
          {claims.map((claim) => <li key={claim.id} className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{claim.handle}</span>
              <span className={styles.rowMeta}>Sent {dateLabel(claim.createdAt)}{claim.reason ? " · " + claim.reason : ""}</span>
            </span>
            <Badge tone={claim.status === "pending" ? "warning" : "neutral"}>{claimStatus(claim.status)}</Badge>
          </li>)}
        </ul> : <Empty icon={Link2} title="No claims yet" text="Claim an account above. A manager or HR will confirm it before its deliveries are credited to you." />}
      </Panel>
    </Fit>
  );
}

/** The API returns only claims this reviewer may see; own claims are filtered by the server page. */
export function AccountClaimsReview({ claims, error }: { claims: UploaderAccountClaim[]; error?: string }) {
  const { busy, problem, run, clearProblem } = useClaimAction();
  return (
    <Panel fill title="Account claims to confirm" sub={error ? "Unavailable" : claims.length + " waiting"}>
      {error ? <div role="alert" className={styles.empty}>
        <p className={styles.emptyTitle}>Claims could not load</p>
        <p className={styles.emptyText}>{error}</p>
        <button type="button" className={styles.btn} onClick={() => window.location.reload()}>Try again</button>
      </div> : claims.length ? <ul className={styles.list}>
        {claims.map((claim) => <li key={claim.id} className={styles.row + " " + css.claimRow}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{claim.handle}</span>
            <span className={styles.rowMeta}>{claim.personName ?? "A team member"} · {dateLabel(claim.createdAt)}</span>
          </span>
          <span className={styles.rowEnd + " " + css.claimActions}>
            <button type="button" className={styles.btn + " " + styles.btnSmall} disabled={busy !== null}
              onClick={() => run("/api/v1/accounts/" + encodeURIComponent(claim.accountId) + "/claim/decide", { decision: "confirmed" }, "Account claim confirmed", claim.id)}>
              {busy === claim.id ? "Saving…" : "Confirm"}
            </button>
            <button type="button" className={styles.btn + " " + styles.btnSmall} disabled={busy !== null}
              onClick={() => run("/api/v1/accounts/" + encodeURIComponent(claim.accountId) + "/claim/decide", { decision: "rejected" }, "Account claim rejected", claim.id)}>
              Reject
            </button>
          </span>
        </li>)}
      </ul> : <Empty icon={ShieldCheck} title="No claims to confirm" text="Pending claims from people you are allowed to review will appear here. Each person sees only their own claim history." />}
      {problem ? <p role="alert" className={styles.panelFoot}>{problem} <button type="button" className={styles.btn} onClick={clearProblem}>Dismiss</button></p> : null}
    </Panel>
  );
}
