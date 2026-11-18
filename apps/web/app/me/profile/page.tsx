import { redirect } from "next/navigation";
import { getMe } from "../../lib/api";

export const dynamic = "force-dynamic";

/** CHAT-SHELL: "My profile" as one address for everyone (links, Pip, the chat's side panel): the person's own profile,
 *  on its "My info" tab. Anything else in the query (embed=1, go=…) is carried over. */
export default async function MyProfile({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const me = (await getMe()).data;
  const q = new URLSearchParams(await searchParams); q.set("tab", "info");
  redirect(me?.person ? `/people/${encodeURIComponent(me.person)}?${q.toString()}` : "/account");
}
