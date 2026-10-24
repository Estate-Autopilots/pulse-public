import { redirect } from "next/navigation";

/** AI-EMPLOYEES v2: an AI employee has the same profile as everyone (People -> person); being AI adds its "AI" section.
 *  Old links to /people/ai/:id open that section. */
export default async function AiEmployeeProfile({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/people/${encodeURIComponent(id)}?tab=ai`);
}
