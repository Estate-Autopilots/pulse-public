import { api, getMe } from "../../../lib/api";
import { HiringCard, type Hiring } from "./hiring";
import { Message, Page, PageHeader } from "../../../ui";
import { STATUS } from "../explain";
import { JobView, type Candidates, type Job } from "./job";

/** R49: one internal job: its skills, every current staff member ranked with each requirement explained, the people a
 *  reviewer picked and the checks they asked for. HR and admins only. */
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // READY (0972): the candidates linked to this job and their stages (HR and admins; empty for anyone else).
  const [job, cands, hiring, me] = await Promise.all([api<Job>(`ats/jobs/${encodeURIComponent(id)}`), api<Candidates>(`ats/jobs/${encodeURIComponent(id)}/candidates`),
    api<Hiring>(`hiring/jobs/${encodeURIComponent(id)}`), getMe()]);
  if (job.error || !job.data) return <Message text={job.status === 403 ? "Internal jobs are for HR and admins." : job.error ?? "Not found"} />;
  if (cands.error || !cands.data) return <Message text={cands.error ?? "Not available"} />;
  const j = job.data, req = j.requirements;
  const picked = j.picks.filter((p) => !p.withdrawn).length;
  return <Page>
    <PageHeader title={j.title} back={{ href: "/people/jobs", label: "Internal jobs" }}
      context={[STATUS[j.status].label, `${req.filter((r) => r.importance === "required").length} required · ${req.filter((r) => r.importance === "preferred").length} preferred`,
        `${picked} picked`, j.weights.accepted ? "Method accepted by HR" : "Method not accepted yet"]} />
    {hiring.data ? <HiringCard jobId={j.id} data={hiring.data} me={me.data?.person ?? null} /> : null}
    <JobView job={j} cands={cands.data} />
  </Page>;
}
