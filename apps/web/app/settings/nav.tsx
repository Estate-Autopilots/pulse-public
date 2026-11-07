// UX-SETTINGS-CHAT (owner, 5 Nov 2026: "confusing"): a section of Settings says where it is and what it is for, in the
// My day header (back to Settings, the area, the section's name and one plain line), and one row of chips names the
// area's other sections. It replaces the area tabs, the section tabs and, inside Company, a third row.
import type { ReactNode } from "react";
import { ChipFilter, PageHeader } from "../components/page-kit";
import { AREAS, TAB_TEXT, areaOf, type TabKey } from "./types";
import { Say } from "../kit/word";

export function SettingsNav({ current, available, label, actions }: { current: TabKey; available: readonly { key: TabKey; label: string }[]; /** The section's own name, when it differs from its tab. */ label?: string; actions?: ReactNode }) {
  const has = new Map(available.map((t) => [t.key, t]));
  const area = areaOf(current);
  const sections = area.tabs.filter((k) => has.has(k)).map((k) => has.get(k)!);
  const title = label ?? has.get(current)?.label ?? "Settings";
  return <>
    <PageHeader back={{ href: "/settings", label: "Settings" }} eyebrow={area.label} title={title} lede={<Say t={TAB_TEXT[current]} />}actions={actions} />
    {/* An area has six sections at most: they wrap on a phone, so the open one is always in sight. */}
    {sections.length > 1 ? <ChipFilter wrap label={`${area.label} sections`} current={current}
      items={sections.map((t) => ({ key: t.key, label: t.label, href: `/settings?tab=${t.key}`, stripe: area.hue }))} /> : null}
  </>;
}
/** The areas a person has, with the sections they may open, in order (the Settings home's cards). */
export function areasFor(available: readonly { key: TabKey; label: string }[]) {
  const has = new Map(available.map((t) => [t.key, t]));
  return AREAS.map((a) => ({ ...a, sections: a.tabs.filter((k) => has.has(k)).map((k) => has.get(k)!) })).filter((a) => a.sections.length);
}
