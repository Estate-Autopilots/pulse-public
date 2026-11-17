// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.1): the Settings list lives in the layout, so it stays on screen (and keeps
// its scroll) while a section opens beside it. Moving between sections renders the section only: no page reload.
import type { ReactNode } from "react";
import { getMe } from "../lib/api";
import { SettingsFrame, type FrameArea } from "./frame";
import { areasFor } from "./nav";
import { getAccess, getHrSetup, settingsAvailable } from "./data";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = (await getMe()).data;
  if (!me) return children;
  const role = me.role;
  const hrSetup = role === "hr" ? await getHrSetup() : null;
  const available = settingsAvailable(role, !!hrSetup?.managed);
  const access = role === "admin" || role === "hr" ? (await getAccess()).data : null;
  const pending = (access?.requests ?? []).filter((r) => r.status === "pending").length;
  const areas: FrameArea[] = areasFor(available).map((a) => ({ key: a.key, label: a.label, hue: a.hue, sections: a.sections.map((s) => ({ key: s.key, label: s.label })) }));
  // The username alone ("qogi.ramis.aliga · Pulse pass…" was cut off in the list); how you sign in is under Your account.
  const line = me.username ?? (me.via === "password" ? "Pulse password" : "Company Google account");
  return <SettingsFrame areas={areas} person={{ name: me.name ?? "Your account", id: me.person, photoAt: me.photoAt, line }} badges={pending ? { "sign-in": String(pending) } : {}}>{children}</SettingsFrame>;
}
