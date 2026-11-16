import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getMe } from "../lib/api";

export const metadata = { title: "Case studies" };

/** CASE-STUDIES (owner, 10 Nov 2026): the case-study journey, an organisation-only module (modules.ts ORG_ONLY, on in the
 *  Vitals organisation). Nobody elsewhere can switch it on, so an off module never draws a dead page: it goes home. */
export default async function CaseStudiesLayout({ children }: { children: ReactNode }) {
  const me = (await getMe()).data;
  if (me?.modules?.off?.includes("case_studies")) redirect("/dashboard");
  return children;
}
