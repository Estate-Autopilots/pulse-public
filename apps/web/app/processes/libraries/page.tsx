import { apiV1 } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { FlowRecord } from "../flow-types";
import { Libraries } from "./libraries";

/** FLOW-C: the company's libraries: references any step points to (swipe files, reference videos kept in Drive, a
 *  testimonial library) and the word list every check reads. Records without a run; leadership keeps them. */
export default async function LibrariesPage({ searchParams }: { searchParams: Promise<{ library?: string; q?: string }> }) {
  const q = await searchParams;
  const [items, words, procs] = await Promise.all([
    apiV1<{ records: FlowRecord[] }>("/v1/flow/records?type=library_item&library=1"),
    apiV1<{ records: FlowRecord[] }>("/v1/flow/records?type=word&library=1"),
    apiV1<{ canEdit: boolean }>("/v1/flow/processes"),
  ]);
  if (!items.data) return <Message text={items.error ?? "The libraries did not load."} />;
  const all = items.data.records, list = words.data?.records ?? [];
  return <Page>
    <PageHeader title="Libraries" back={{ href: "/processes", label: "Processes" }} recent={{ title: "Libraries" }}
      context={[`${all.length} reference${all.length === 1 ? "" : "s"}`, list.length ? `${list.length} words` : null]} />
    <Libraries items={all} words={list} canEdit={!!procs.data?.canEdit} initial={q.library ?? null} query={q.q ?? ""} />
  </Page>;
}
