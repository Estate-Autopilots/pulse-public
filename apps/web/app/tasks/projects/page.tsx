import { redirect } from "next/navigation";

/** PHONE-QA: /tasks/projects has no page of its own (only /tasks/projects/[id]); the onboarding checklist and older
 * links pointed here and a new company's owner hit "This view could not load". The projects list is a view of Work. */
export default async function ProjectsIndex({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  redirect(q.review ? "/tasks?view=projects&review=1" : "/tasks?view=projects");
}
