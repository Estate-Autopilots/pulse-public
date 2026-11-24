// PM-UI (dev only): /projects/pm/preview/<screen>?state=<key> renders screens/<screen>.tsx with the state of
// fixtures/<screen>.ts (the first state when none is asked). Found by naming convention: adding a screen edits nothing
// here. A 404 in production (gate.ts), for an unknown screen and for an unknown state.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadScreen, previewEnabled } from "../gate";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PM preview", robots: { index: false, follow: false } };

export default async function PmPreview({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Promise<{ state?: string | string[] }> }) {
  if (!previewEnabled()) notFound();
  const [{ screen }, query] = await Promise.all([params, searchParams]);
  const found = await loadScreen(screen);
  if (!found) notFound();
  const keys = Object.keys(found.states);
  const asked = Array.isArray(query.state) ? query.state[0] : query.state;
  const key = asked ?? keys[0];
  if (!Object.hasOwn(found.states, key)) notFound();
  const { Screen } = found;
  return <Screen vm={found.states[key] as never} />;
}
