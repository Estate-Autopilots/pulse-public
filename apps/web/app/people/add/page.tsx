import { redirect } from "next/navigation";

export const metadata = { title: "Add people" };

/** FIX-PEOPLE-MONEY C1: Add people is one panel on Team (people/add/add-flow.tsx). This old address opens it, keeping
 *  what was asked for: /people/add?as=accountant opens the panel on CA / accountant. */
export default async function AddPeoplePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  redirect(`/people?add=${encodeURIComponent(q.as || "people")}`);
}
