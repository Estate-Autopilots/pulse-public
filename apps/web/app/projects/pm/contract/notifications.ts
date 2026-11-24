// PM-UI: view model of 16 Notifications, the "Activity" feed (sheets/notifications.md). One read for the signed-in
// person: what happened on their work, newest first, already grouped by day by the server. Every item is the viewer's own
// (a step they own or review, a date move on their project); a lead's jobs (drafted reminders) never reach a team member.
import type { IsoDate, IsoDateTime, ProjectRef, Viewer } from "./shared";

/** What happened. Decides nothing on screen by itself (the words, chip and action come with the item); kept for icons,
 *  analytics and the bell's grouping. */
export type ActivityKind = "your_turn" | "client_approved" | "late" | "date_moved" | "review_asked";

/** Tone of the event chip: the design system's work tones (`neutral` = outlined grey, as "To do"). */
export type ActivityTone = "done" | "info" | "action" | "waiting" | "problem" | "neutral";

/** The one button of a row. Described as data; the screen draws it. `start` is the only filled (primary) button on the
 *  page; every other kind is an outline. All are links (the step, the file, the plan). */
export type ActivityAction = {
  kind: "start" | "view" | "open" | "view_plan" | "review";
  /** "Start", "View", "Open", "View plan", "Review". */ label: string;
  href: string;
};

/** One event row. */
export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  /** The project it happened on (every row has one): solid colour tile + icon, and the first words of the second line. */
  project: ProjectRef;
  /** The event in words, strong: "You're up: Shoot site walkthrough", "Kavya moved Shoot +3 days". */
  title: string;
  /** One detail after the project name on the second line: "due today, 5:00 PM", "round 2 of 3", "reason: rain". */
  detail: string;
  /** When it happened; shown as a 24-hour time ("10:42") in Asia/Kolkata. */
  at: IsoDateTime;
  /** The one event chip, a word: "To do", "Approved", "Late · 1 day", "Date moved", "Your turn". */
  chip: { word: string; tone: ActivityTone };
  action: ActivityAction;
  /** Not yet seen by the viewer (violet dot at the row's left edge). */
  unread: boolean;
  /** Where tapping the row goes (the step, file or plan); the same place as the button unless the button acts. */
  href: string;
};

/** A day of activity. Newest first inside the group. */
export type ActivityGroup = {
  key: "today" | "yesterday" | "earlier";
  /** "Today", "Yesterday", or a day ("Thu, 19 Nov"). */
  title: string;
  items: ActivityItem[];
};

export type NotificationsVM = {
  /** Today (Sat, 21 Nov 2026 in fixtures). */
  today: IsoDate;
  /** The signed-in person (whose activity this is). */
  viewer: Viewer;
  /** Count of unread items (= items with `unread`): "3 unread" beside the title; 0 hides it and greys "Mark all read". */
  unread: number;
  /** The groups, newest day first; empty = nothing new (the screen shows one quiet card). */
  groups: ActivityGroup[];
  /** While the first read is in flight: the screen draws skeleton rows under "Today" and "Yesterday". */
  loading?: boolean;
  /** "Open My day" (empty state). */
  myDayHref: string;
};
