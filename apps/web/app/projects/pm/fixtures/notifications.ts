// PM-UI: fixtures of 16 Notifications / Activity (sheets/notifications.md), all from canon. Signed in: Rifob Das (Video
// editor). Today Sat, 21 Nov 2026. Rows 1, 3 and 5 are the same steps as on Rifob's My day.
import type { ActivityGroup, ActivityItem, NotificationsVM } from "../contract/notifications";
import { TODAY, projects, viewer } from "./canon";

const STEP = "/projects/pm/preview/step-detail";
const REVIEW = "/projects/pm/preview/approvals";
const PLAN = "/projects/pm/preview/timeline";
const at = (day: string, time: string) => `${day}T${time}:00+05:30`;
const YESTERDAY = "2026-11-20";

const today: ActivityItem[] = [
  { id: "ev-walk", kind: "your_turn", project: projects.orchid, title: "You're up: Shoot site walkthrough", detail: "due today, 5:00 PM",
    at: at(TODAY, "10:42"), chip: { word: "To do", tone: "neutral" }, action: { kind: "start", label: "Start", href: STEP }, unread: true, href: STEP },
  { id: "ev-approved", kind: "client_approved", project: projects.palm, title: "Client approved Walkthrough video v2", detail: "round 2 of 3",
    at: at(TODAY, "09:15"), chip: { word: "Approved", tone: "done" }, action: { kind: "view", label: "View", href: REVIEW }, unread: true, href: REVIEW },
  { id: "ev-reel-late", kind: "late", project: projects.bluewater, title: "Site visit reel is late", detail: "due yesterday",
    at: at(TODAY, "08:00"), chip: { word: "Late · 1 day", tone: "problem" }, action: { kind: "open", label: "Open", href: STEP }, unread: true, href: STEP },
];
const yesterday: ActivityItem[] = [
  { id: "ev-moved", kind: "date_moved", project: projects.orchid, title: "Kavya moved Shoot +3 days", detail: "reason: rain",
    at: at(YESTERDAY, "17:20"), chip: { word: "Date moved", tone: "info" }, action: { kind: "view_plan", label: "View plan", href: PLAN }, unread: false, href: PLAN },
  { id: "ev-review", kind: "review_asked", project: projects.sunpeak, title: "Ira sent Walkthrough reel v1 for your review", detail: "due Mon, 23 Nov",
    at: at(YESTERDAY, "15:05"), chip: { word: "Your turn", tone: "action" }, action: { kind: "review", label: "Review", href: REVIEW }, unread: false, href: REVIEW },
];

const groups = (read = false): ActivityGroup[] => [
  { key: "today", title: "Today", items: today.map((i) => (read ? { ...i, unread: false } : i)) },
  { key: "yesterday", title: "Yesterday", items: yesterday },
];

const base: NotificationsVM = {
  today: TODAY,
  viewer: viewer("rifob"),
  unread: 3,
  groups: groups(),
  myDayHref: "/projects/pm/preview/my-day",
};

export const states: Record<string, NotificationsVM> = {
  /** Five rows, the three of Today unread. */
  default: base,
  /** After "Mark all read": no dots, no count, the link greyed; rows, chips and buttons unchanged. */
  "all-read": { ...base, unread: 0, groups: groups(true) },
  /** Nothing new: one quiet card and a way to My day. */
  empty: { ...base, unread: 0, groups: [] },
  /** First read in flight: skeleton rows under Today (3) and Yesterday (2). */
  loading: { ...base, unread: 0, groups: [], loading: true },
};
