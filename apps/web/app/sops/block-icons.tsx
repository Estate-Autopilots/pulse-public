// Owner workbench (21 Oct 2026): every block has its own icon and its group's hue, the same in the library, on the canvas
// and in the block panel, so a workflow reads at a glance (sales sky, billing green, field amber, apps pink).
import { ArrowDownToLine, AudioLines, BadgeCheck, Bell, ClipboardList, Flag, Forward, GitBranch, ListChecks, Magnet, MapPin, MessageCircleReply, ReceiptText, ScrollText, Timer, Webhook, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { Hue } from "@pulse/design-system/ui";

const ICON: Record<string, (size: number) => ReactNode> = {
  lead_capture: (s) => <Magnet size={s} />, handoff_in: (s) => <ArrowDownToLine size={s} />, sales_xray: (s) => <AudioLines size={s} />,
  quotation: (s) => <ScrollText size={s} />, follow_up: (s) => <MessageCircleReply size={s} />, approval: (s) => <BadgeCheck size={s} />,
  decision: (s) => <GitBranch size={s} />, site_visit: (s) => <MapPin size={s} />, data_capture: (s) => <ClipboardList size={s} />,
  checklist: (s) => <ListChecks size={s} />, handoff: (s) => <Forward size={s} />, wait: (s) => <Timer size={s} />, notify: (s) => <Bell size={s} />,
  tax_invoice: (s) => <ReceiptText size={s} />, webhook: (s) => <Webhook size={s} />, end: (s) => <Flag size={s} />,
};
export const blockIcon = (module: string | null | undefined, size = 16): ReactNode => (ICON[module ?? ""] ?? ((s: number) => <Workflow size={s} />))(size);
export const GROUP_HUE: Record<string, Hue> = { Start: "indigo", Sales: "sky", Billing: "green", Field: "amber", Flow: "slate", Apps: "pink" };
export const ENGINE_LABEL = { live: "Live", auto: "Automatic", partial: "Partly built", stub: "Coming soon" } as const;
