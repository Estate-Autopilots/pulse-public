import { apiV1 } from "../../../../lib/api";
import { Badge, Message, Page, PageHeader } from "../../../../ui";
import type { RunDetail } from "../../../flow-types";
import { TryIt } from "../../try";

/** FLOW-D "Try it": the draft running as a test project with sample data. You act as each person in turn; who would
 *  have heard what, the alerts and the due dates show as they happen; then the test is thrown away. */
export default async function TryPage({ params }: { params: Promise<{ id: string; run: string }> }) {
  const { id, run } = await params;
  const r = await apiV1<RunDetail>(`/v1/flow/runs/${encodeURIComponent(run)}`);
  if (r.error) return <Message text={r.status === 404 ? "This try was thrown away. Press Try it in the builder to start another." : r.error} />;
  return <Page>
    <PageHeader title={`Trying: ${r.data!.process}`} back={{ href: `/processes/${encodeURIComponent(id)}`, label: "The builder" }} recent={false}
      context={["A test with sample data: nobody is told, no Work task is made"]} meta={<Badge tone="accent">Try</Badge>} />
    <TryIt processId={id} initial={r.data!} />
  </Page>;
}
