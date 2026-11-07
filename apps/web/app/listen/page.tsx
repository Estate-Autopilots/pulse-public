// AGENT-CHANNELS (1685): /listen — always-on listening with a live transcript; the chosen AI employee follows along.
// Opened from an AI employee's page (?agent=<id>) or directly.
import { Page, PageHeader } from "../ui";
import { ListenRoom } from "./room";

export default async function ListenPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  const initial = typeof agent === "string" && /^[0-9a-f-]{36}$/i.test(agent) ? agent : undefined;
  return <Page>
    <PageHeader title="Listening" context={["An AI employee follows a conversation and acts on it"]} />
    <ListenRoom initialAgent={initial} />
  </Page>;
}
