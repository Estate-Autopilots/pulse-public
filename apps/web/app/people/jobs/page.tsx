import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import { JobsView, type JobRow, type Method } from "./method";

/** R49: internal jobs for HR and admins: each job's required and preferred skills, and how matching works (published
 *  weights, their versions and HR's acceptance). Only current staff are matched; external applicants are not in Pulse. */
export default async function JobsPage() {
  const [jobs, method] = await Promise.all([api<{ jobs: JobRow[] }>("ats/jobs"), api<Method>("ats/method")]);
  if (jobs.error) return <Message text={jobs.status === 403 ? "Internal jobs are for HR and admins." : jobs.error} />;
  if (method.error || !method.data) return <Message text={method.error ?? "Not available"} />;
  const m = method.data, list = jobs.data?.jobs ?? [];
  return <Page>
    <PageHeader title="Internal jobs" back={{ href: "/people/skills", label: "Skills list" }}
      context={[`${list.length} job${list.length === 1 ? "" : "s"}`, m.current.default ? "Pulse’s starting weights" : `Weights version ${m.current.version}`,
        m.current.accepted ? "Accepted by HR" : "Not accepted by HR yet: trying out"]} />
    <JobsView jobs={list} method={m} />
  </Page>;
}
