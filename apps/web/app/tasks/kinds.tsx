// TASKS-4A: an icon for each kind of work (pulse.work_category keys), for pickers, cards and table cells. A company's
// own kinds that are not listed get a tag.
import { createElement } from "react";
import { AtSign, Bug, Clapperboard, Code2, DoorOpen, Globe, Handshake, Headset, Lightbulb, Megaphone, Palette, PenLine, Receipt, Search, Tag, Users, Video, Workflow, Wrench, type LucideIcon } from "lucide-react";

export const CATEGORY_ICON: Record<string, LucideIcon> = {
  video_shoot: Video, video_edit: Clapperboard, design: Palette, scripting: PenLine, meta_ads: Megaphone, google_ads: Search, social: AtSign, onboarding: DoorOpen, setup_admin: Wrench,
  client_service: Headset, sales: Handshake, web: Globe, engineering: Code2, qa: Bug, hr: Users, finance: Receipt, operations: Workflow, research: Lightbulb,
};
export const categoryIcon = (key: string | null | undefined): LucideIcon => (key && CATEGORY_ICON[key]) || Tag;
export function CategoryIcon({ category, size = 15 }: { category: string | null | undefined; size?: number }) {
  return createElement(categoryIcon(category), { size, "aria-hidden": true });
}
