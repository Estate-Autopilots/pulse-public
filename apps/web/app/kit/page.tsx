import { Page, PageHeader } from "../ui";
import { KitGallery } from "./gallery";
import { DsGallery } from "./ds-gallery";
import { orgZone } from "../lib/brand-server";
import { zoneDay } from "../lib/zone.mjs";

// TASKS-4A: the shared controls on one page, with made-up people (nothing here reads or writes data).
export const metadata = { title: "Controls · Pulse" };

export default async function KitPage() {
  return <Page>
    <PageHeader title="AC design system" context={["Theme, primitives and components shared by every AC app, then the controls kit"]} />
    <DsGallery />
    <KitGallery today={zoneDay(await orgZone())} />
  </Page>;
}
