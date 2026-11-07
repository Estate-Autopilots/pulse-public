"use client";

import { useRouter } from "next/navigation";
import { FileCheck2, ListChecks } from "lucide-react";
import { useState } from "react";
import type { DeliveryClaimReview, DesignClaimReview } from "./lib/api";
import { dayYear } from "./lib/format";
import { Badge, Empty, Panel, Skeleton, styles } from "./ui";
import css from "./delivery-claims.module.css";

export type ClaimableItem = { id: string; projectName: string; fileName: string; type: string; day: string; waiting?: boolean };
export type ClaimLabels = {
  title: string;
  action: string;
  loading: string;
  emptyTitle: string;
  emptyText: string;
  unavailable: string;
  conflict: string;
  waiting: string;
  success: string;
  type: string;
  day: string;
};

async function postClaim(endpoint: string, itemId: string, conflictMessage: string) {
  const response = await fetch(`${endpoint}/${encodeURIComponent(itemId)}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (response.status === 409) throw new Error(conflictMessage);
  if (!response.ok) throw new Error(result?.error ?? "This item could not be claimed. Refresh and try again.");
}

async function postDecision(deliveryId: string, body: { decision: "confirmed" | "rejected" }) {
  const response = await fetch(`/api/v1/deliveries/${encodeURIComponent(deliveryId)}/claim/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error ?? "This delivery could not be updated. Refresh and try again.");
}

export function ClaimableDeliveries({ week, items: initialItems, endpoint, labels, keepClaimedRow = false, loading = false, error }: {
  week: string;
  items: ClaimableItem[];
  endpoint: string;
  labels: ClaimLabels;
  keepClaimedRow?: boolean;
  loading?: boolean;
  error?: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");

  async function claim(item: ClaimableItem) {
    setBusy(item.id);
    setFailure("");
    setNotice("");
    try {
      await postClaim(endpoint, item.id, labels.conflict);
      setItems((current) => keepClaimedRow
        ? current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, waiting: true } : currentItem)
        : current.filter((currentItem) => currentItem.id !== item.id));
      setNotice(labels.success);
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "This item could not be claimed.");
    } finally {
      setBusy(null);
    }
  }

  return <Panel title={labels.title} sub={week}>
    {loading ? <div role="status" aria-busy="true" className={styles.stack}>
      <span className={styles.srOnly}>{labels.loading}</span>
      <ul className={css.list} aria-hidden="true">{Array.from({ length: 2 }, (_, index) => <li className={css.row} key={index}>
        <Skeleton width={24} height={24} /><span className={styles.stack}><Skeleton width="52%" /><Skeleton width="78%" height={11} /></span><Skeleton width={94} height={28} />
      </li>)}</ul>
    </div> : error ? <p className={styles.status} role="alert">{labels.unavailable}</p> : items.length === 0
      ? <Empty icon={FileCheck2} title={labels.emptyTitle} text={labels.emptyText} first />
      : <ul className={css.list}>
        {items.map((item) => <li className={css.row} key={item.id}>
          <span className={styles.rowIcon} aria-hidden="true">{item.type.slice(0, 1).toUpperCase()}</span>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{item.fileName}</span>
            <span className={styles.rowMeta}><span>{item.projectName}</span><span>{labels.type}: {item.type}</span><span>{labels.day}: {item.day}</span></span>
          </span>
          {item.waiting ? <span className={styles.badge} role="status">{labels.waiting}</span>
            : <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy !== null} onClick={() => void claim(item)}>
              {busy === item.id ? "Sending…" : labels.action}
            </button>}
        </li>)}
      </ul>}
    {notice ? <p className={styles.panelFoot} role="status">{notice}</p> : null}
    {failure ? <p className={styles.panelFoot} role="alert">{failure}</p> : null}
  </Panel>;
}

type ReviewClaim = DeliveryClaimReview | DesignClaimReview;

function claimItemId(claim: ReviewClaim) {
  return "designId" in claim ? claim.designId : claim.deliveryId;
}

export function ClaimsToConfirm({ claims: initialClaims, error, subject = "editors" }: {
  claims: ReviewClaim[];
  error?: string;
  subject?: "editors" | "designers";
}) {
  const router = useRouter();
  const [claims, setClaims] = useState(initialClaims);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const isDesign = subject === "designers";

  async function decide(claim: ReviewClaim, decision: "confirmed" | "rejected") {
    const itemId = claimItemId(claim);
    setBusy(itemId);
    setFailure("");
    setNotice("");
    try {
      await postDecision(itemId, { decision });
      setClaims((current) => current.filter((item) => item.id !== claim.id));
      setNotice(decision === "confirmed" ? (isDesign
        ? "Design claim confirmed. The designer’s weekly count now includes this confirmed claim."
        : "Delivery confirmed. The editor’s weekly delivered total and gap now include this confirmed claim.") : "Claim rejected.");
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "This claim could not be decided.");
    } finally {
      setBusy(null);
    }
  }

  return <Panel title="Claims to confirm" sub={claims.length ? `${claims.length} pending` : isDesign ? "Design credits" : "Editor delivery credits"} className={css.reviewPanel}>
    {error ? <p className={styles.status} role="alert">Claims could not be loaded. Refresh to try again.</p> : claims.length === 0
      ? <Empty icon={ListChecks} title={isDesign ? "No design claims to review" : "No delivery claims to review"} text={isDesign ? "Pending claims from designers will appear here." : "Pending claims from your editors will appear here."} first />
      : <ul className={css.list}>
        {claims.map((claim) => {
          const isDesignClaim = "designId" in claim;
          const itemId = claimItemId(claim);
          const designType = isDesignClaim ? claim.type.replaceAll("_", " ") : "";
          const type = isDesignClaim ? designType.charAt(0).toUpperCase() + designType.slice(1) : claim.kind === "draft" ? "Draft" : "Final";
          const date = isDesignClaim ? claim.uploadedAt : claim.deliveredAt;
          return <li className={css.row} key={claim.id}>
            <span className={styles.rowIcon} aria-hidden="true">{isDesignClaim ? "D" : claim.kind === "draft" ? "D" : "F"}</span>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{claim.fileName}</span>
              <span className={`${styles.rowMeta} ${css.claimMeta}`}><span>{claim.personName}</span><span>{claim.projectName}</span><span>{type}</span><span>{dayYear(date)}</span></span>
            </span>
            <span className={css.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy !== null} onClick={() => void decide(claim, "confirmed")}>
                {busy === itemId ? "Saving…" : "Confirm"}
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={busy !== null} onClick={() => void decide(claim, "rejected")}>
                Reject
              </button>
            </span>
          </li>;
        })}
      </ul>}
    {notice ? <p className={styles.panelFoot} role="status"><Badge>{notice.includes("confirmed claim") ? "confirmed claim" : "Updated"}</Badge>{notice}</p> : null}
    {failure ? <p className={styles.panelFoot} role="alert">{failure}</p> : null}
  </Panel>;
}
