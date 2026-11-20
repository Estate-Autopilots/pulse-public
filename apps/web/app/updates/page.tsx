import { apiV1 } from "../lib/api";
import { orgZone } from "../lib/brand-server";
import { Message, Page, PageHeader } from "../ui";
import type { UpdateList } from "./types";
import { UpdatesList } from "./views";

export default async function Updates({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const result = await apiV1<UpdateList>(`/api/v1/updates?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (!result.data) return <Message text={result.error} />;
  return <Page><PageHeader title="Updates" context={["The latest hand-offs, shared with you."]} />
    <UpdatesList data={result.data} zone={await orgZone()} />
  </Page>;
}
