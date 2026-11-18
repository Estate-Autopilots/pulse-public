import { NotebookPen } from "lucide-react";
import { api } from "../../lib/api";
import { Empty, Page, PageHeader } from "../../ui";
import { MeetingView, type Meeting } from "../meeting-view";

/** KAZUK-REST slice 4: one meeting: its consent, audio, transcript (or notes) and the action items to confirm as tasks. */
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await api<{ meeting: Meeting }>(`meetings/${encodeURIComponent(id)}`);
  if (!r.data) return <Page><PageHeader title="Meeting" back={{ href: "/meetings", label: "Meetings" }} />
    <Empty icon={NotebookPen} title="This meeting is not available" text={r.status === 404 ? "It was deleted, or it is not one you were in." : r.error ?? "Try again in a moment."} action={{ href: "/meetings", label: "All meetings" }} /></Page>;
  return <Page><PageHeader title={r.data.meeting.title} back={{ href: "/meetings", label: "Meetings" }} /><MeetingView initial={r.data.meeting} /></Page>;
}
