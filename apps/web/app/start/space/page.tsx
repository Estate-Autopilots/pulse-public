import { redirect } from "next/navigation";
import { getMe } from "../../lib/api";
import { StartSpace } from "./start-space";

export const metadata = { title: "Start another space" };
export const dynamic = "force-dynamic";

/** SELF-SERVE (owner, 4 Nov 2026: one person holds several types and several organisations): signed in, a new space set
 *  up for its kind, from the sign-up's second question. Signed out, the sign-up asks both questions. */
export default async function StartSpacePage() {
  const me = (await getMe()).data;
  if (!me?.person) redirect("/signup");
  return <StartSpace you={me.name ?? ""} />;
}
