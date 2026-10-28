// UI-POLISH-3: Settings' two rows: the area (Organisation, People & access, Data & devices) and the area's sections.
// An area with one section shows no second row; a person with one area (HR) sees only the sections.
import { Building2, HardDrive, ShieldCheck } from "lucide-react";
import { Tabs } from "@pulse/design-system/ui";
import { QueryTabs } from "../ui";
import { AREAS, type TabKey } from "./types";
import css from "./settings.module.css";

const ICONS = { organisation: <Building2 />, access: <ShieldCheck />, data: <HardDrive /> } as const;

export function SettingsNav({ current, available }: { current: TabKey; available: readonly { key: TabKey; label: string }[] }) {
  const has = new Map(available.map((t) => [t.key, t]));
  const areas = AREAS.map((a) => ({ ...a, tabs: a.tabs.filter((k) => has.has(k)) })).filter((a) => a.tabs.length);
  const area = areas.find((a) => (a.tabs as readonly string[]).includes(current)) ?? areas[0];
  if (!area) return null;
  const sections = area.tabs.map((k) => has.get(k)!);
  return <>
    {areas.length > 1 ? <Tabs label="Settings areas" current={area.key} items={areas.map((a) => ({ key: a.key, label: <><span className={css.areaFull}>{a.label}</span><span className={css.areaShort}>{a.short}</span></>, icon: ICONS[a.key], href: `/settings?tab=${a.tabs[0]}` }))} /> : null}
    {sections.length > 1 ? <QueryTabs base="/settings" pages current={current} items={sections} /> : null}
  </>;
}
