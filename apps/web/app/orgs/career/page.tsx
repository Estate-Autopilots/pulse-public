import Link from "next/link";
import { api } from "../../lib/api";
import { Page, PageHeader, styles } from "../../ui";
import { CareerView, type Career } from "./view";

// PROFILE-UNIFY (1683): My career: every company the person works or worked with, from their own Pulse account. Only
// the person sees it whole; a company sees roles and dates only, and only when the person publishes them to it.
export default async function MyCareer() {
  const r = await api<Career>("account/career");
  return <Page><PageHeader title="My career" back={{ href: "/orgs/profile", label: "Your profile" }} context={["Every company you work or worked with, in one place. Only you see this page."]}
      actions={<Link className={`${styles.btn} ${styles.btnPrimary}`} href="/orgs/resume">Build my resume</Link>} />
    <CareerView data={r.data ?? null} error={r.error ?? null} /></Page>;
}
