import { notFound } from "next/navigation";
import { apiV1 } from "../../lib/api";
import { orgZone } from "../../lib/brand-server";
import { Message, Page, PageHeader } from "../../ui";
import type { UpdateDetail } from "../types";
import { UpdateCard } from "../views";
import css from "../updates.module.css";

export default async function Update({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiV1<UpdateDetail>(`/api/v1/updates/${encodeURIComponent(id)}/open`, { method: "POST" });
  if (result.status === 404) notFound();
  if (!result.data) return <Message text={result.error} />;
  return <Page><PageHeader title="Update" back={{ href: "/updates", label: "All updates" }} recent={{ title: result.data.headline }} />
    <div className={css.detail}><UpdateCard update={result.data} zone={await orgZone()} /></div>
  </Page>;
}
