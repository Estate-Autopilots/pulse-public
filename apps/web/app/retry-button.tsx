"use client";
// EST-1197: "Try again" on a page whose data did not load: the page's data is read again, only when the person asks
// (never by itself, so a failing server is never asked in a loop).
import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import styles from "./ui.module.css";

export function RetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={pending} aria-busy={pending} onClick={() => start(() => router.refresh())}>
    <RotateCw size={14} aria-hidden="true" />{pending ? "Trying again…" : "Try again"}
  </button>;
}
