import Link from "next/link";
import { api, getMe } from "../../lib/api";
import { Message, Page, PageHeader, styles } from "../../ui";
import { SkillsSetup, type SetupData } from "./setup";

/** R48: the company's skills list for HR and admins: where the taxonomy came from (version, hash, licences,
 *  attribution, approval), HR's local skills and local names, and the proficiency scale. Imports are the operator's. */
export default async function SkillsListPage() {
  const [r, me] = await Promise.all([api<SetupData>("skills/setup"), getMe()]);
  const jobs = !me.data?.modules?.off?.includes("jobs");  // RELEASE-5: internal jobs has its own switch
  if (r.error) return <Message text={r.status === 403 ? "HR and admins look after the skills list." : r.error} />;
  const d = r.data!;
  const current = d.sources.filter((s) => !s.supersededAt);
  return <Page>
    <PageHeader title="Skills list" back={{ href: "/people", label: "Team" }} actions={jobs ? <Link className={`${styles.btn} ${styles.btnGhost}`} href="/people/jobs">Internal jobs</Link> : undefined}
      context={[current.length ? current.map((s) => `${s.family === "esco" ? "ESCO" : "O*NET"} ${s.version}`).join(" · ") : "No taxonomy imported (owner errand E16)",
        `${d.local.length} local skill${d.local.length === 1 ? "" : "s"}`, d.rubric.confirmed ? "Scale confirmed by HR" : "Starting scale, not confirmed"]} />
    <SkillsSetup data={d} />
  </Page>;
}
