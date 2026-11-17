// AGENT-CHANNELS (1685): /listen — always-on listening with a live transcript; the chosen AI employee follows along.
// Opened from an AI employee's page (?agent=<id>) or directly. SETTINGS-APPLE (T1.4.1): the room draws its own page.
import { ListenRoom } from "./room";

export default async function ListenPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  const initial = typeof agent === "string" && /^[0-9a-f-]{36}$/i.test(agent) ? agent : undefined;
  return <ListenRoom initialAgent={initial} />;
}
