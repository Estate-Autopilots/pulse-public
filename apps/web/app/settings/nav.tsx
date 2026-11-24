// UX-SETTINGS-CHAT (owner, 5 Nov 2026: "confusing"): a section of Settings says where it is and what it is for.
// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.1): the list beside it now names the area's other sections, so the header is
// the breadcrumbs (Settings › area › section, with Back and Forward), the section's name and one plain line. The row
// of section chips is gone: it repeated the list.
import type { ReactNode } from "react";
import { PageHeader } from "../components/page-kit";
import { AREAS, TAB_TEXT, areaOf, type TabKey } from "./types";
import { Crumbs, type Crumb } from "./crumbs";
import { Say } from "../kit/word";

export function SettingsNav({ current, available, label, actions, part }: { current: TabKey; available: readonly { key: TabKey; label: string }[]; /** The section's own name, when it differs from its tab. */ label?: string; actions?: ReactNode;
  /** A part opened inside the section (Your account › Security): one more step in the breadcrumbs. */ part?: { label: string; lede: string } }) {
  const has = new Map(available.map((t) => [t.key, t]));
  const area = areaOf(current);
  const section = label ?? has.get(current)?.label ?? "Settings";
  const trail: Crumb[] = [{ label: "Settings", href: "/settings" }, { label: area.label },
    ...(part ? [{ label: section, href: `/settings?tab=${current}` }, { label: part.label }] : [{ label: section }])];
  return <>
    <Crumbs trail={trail} />
    <PageHeader title={part?.label ?? section} lede={part ? part.lede : <Say t={TAB_TEXT[current]} />} actions={actions} />
  </>;
}
/** The areas a person has, with the sections they may open, in order (the Settings list's groups). */
export function areasFor(available: readonly { key: TabKey; label: string }[]) {
  const has = new Map(available.map((t) => [t.key, t]));
  return AREAS.map((a) => ({ ...a, sections: a.tabs.filter((k) => has.has(k)).map((k) => has.get(k)!) })).filter((a) => a.sections.length);
}
