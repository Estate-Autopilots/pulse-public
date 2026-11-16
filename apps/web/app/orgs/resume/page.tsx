import { api } from "../../lib/api";
import { Message, Page, PageHeader } from "../../ui";
import type { Portable } from "../profile/view";
import type { Stint } from "../career/view";
import { ResumeBuilder, type ResumeState } from "./view";

// PROFILE-UNIFY (1683): one click from My career to a clean resume: pick the sections, download it as a PDF, and share
// it with a public link you control (off until you make one).
export default async function Resume() {
  const r = await api<{ resume: ResumeState; profile: Portable | null; career: Stint[] }>("account/resume");
  if (r.error || !r.data?.profile) return <Page><PageHeader title="Resume" back={{ href: "/orgs/career", label: "My career" }} /><Message text={r.error ?? "Claim your Pulse handle first, on Organisations."} /></Page>;
  const { profile, career, resume } = r.data;
  // The photo, read once for the preview and the PDF (the public link carries it only when "Photo" is saved).
  const photo = profile.me && profile.hasPhoto ? await api<{ mime: string; data: string }>(`people/${profile.me}/photo`).then((x) => x.data ? `data:${x.data.mime};base64,${x.data.data}` : null) : null;
  return <Page><PageHeader title="Resume" back={{ href: "/orgs/career", label: "My career" }} context={["From your profile and your work in every company"]} />
    <ResumeBuilder initial={resume} profile={profile} career={career} photo={photo} /></Page>;
}
