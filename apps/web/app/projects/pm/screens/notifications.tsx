// PM-UI: 16 Notifications, the "Activity" feed (sheets/notifications.md; picks b4-16-notifications-*-R). What happened on
// my work, newest first, grouped by day; each row with the project's solid colour tile, one event chip and one button
// (only "Start" is filled). Phone: one card per row. From 600 px: one card per day with one-line rows whose chip and
// button columns line up. From 960 px: the whole feed sits in one page card. Preview: /projects/pm/preview/notifications?state=…
import type { ActivityGroup, NotificationsVM } from "../contract/notifications";
import type { ScreenProps } from "../contract/shared";
import { PmPage } from "../kit";
import { ActivityFeed } from "./notifications-client";
import css from "./notifications.module.css";

/** Skeleton rows while loading: the real row's parts with placeholder words as long as the real ones, so on the phone
 *  the cards that wrap to two lines (1, 2 and 5) wrap in the skeleton too and nothing jumps when content arrives. */
const GHOST: [title: string, project: string, detail: string][][] = [
  [["Loading the step that is up for you", "Project name loading", "due date, time here"],
   ["Loading the newest client approval", "Project name here", "round here"],
   ["Loading a late step now", "Project name", "due date here"]],
  [["Loading a moved date here", "Project name loading", "reason: here"],
   ["Loading a review request for you to see now", "Project name loads", "due day, date"]],
];
const ghost = (n: number, day: string, g: number): ActivityGroup["items"] => Array.from({ length: n }, (_, i) => {
  const [title, name, detail] = GHOST[g]?.[i] ?? ["Loading the latest activity row", "Project name here", "one detail"];
  return {
  id: `ghost-${day}-${g}-${i}`, kind: "your_turn", project: { id: "ghost", name, client: null, hue: "slate", icon: "building" },
  title, detail, at: `${day}T10:00:00+05:30`,
  chip: { word: "Loading", tone: "waiting" }, action: { kind: "open", label: "Open", href: "#" }, unread: false, href: "#",
  };
});

export default function Notifications({ vm }: ScreenProps<NotificationsVM>) {
  const groups: ActivityGroup[] = vm.loading
    ? [{ key: "today", title: "Today", items: ghost(3, vm.today, 0) }, { key: "yesterday", title: "Yesterday", items: ghost(2, vm.today, 1) }]
    : vm.groups;
  // Local "read" marks reset when another fixture (or a fresh read) arrives.
  const key = `${vm.loading ? "l" : ""}${vm.unread}:${vm.groups.map((g) => g.items.map((i) => i.id + (i.unread ? "*" : "")).join(",")).join("|")}`;
  return <PmPage>
    <div className={css.wrap}>
      <ActivityFeed key={key} groups={groups} loading={!!vm.loading} myDayHref={vm.myDayHref} />
    </div>
  </PmPage>;
}
