// Types for registry.mjs (UX-5B destinations registry).

/** The shell's access words (packages/ui-shell rail): all = everyone, work = staff work pages, hr = HR desk, admin =
 *  leadership, finance and admins. */
export type Access = "all" | "work" | "hr" | "admin";
export type DestKind = "page" | "tab" | "section" | "control";
/** How a task's completion can be proven by an event: the event type, an optional exact condition on the event's
 *  declared data, and whether to count different people (subjects) rather than events. */
export type SignalTemplate = {
  event: EventType;
  label: string;
  /** What the task's text must say for Pip to propose this signal: every group, each by any of its words. A signal with
   *  two or more groups is specific enough to be proposed for any task; one with a single group only for a task sent to
   *  its destination (or a place beside it). */
  when?: readonly (readonly string[])[];
  where?: Readonly<Record<string, { gte?: number; eq?: string | number | boolean }>>;
  distinct?: "subject";
};
export type Destination = {
  id: string;
  label: string;
  /** Breadcrumb names, as people write them: ["HR", "Policies", "Office presence"]. */
  path: readonly string[];
  href: string;
  kind: DestKind;
  parent?: string;
  synonyms?: readonly string[];
  events?: readonly EventType[];
  access: Access;
  /** The switchable module (packages/ui-shell modules.ts) the page belongs to. */
  module?: string;
  /** A lucide icon name, for lists such as Ctrl+K. */
  icon?: string;
  /** The coach mark shown beside the spotlight: "Add the office Wi-Fi here". */
  coach?: string;
  /** What must exist first when this is not on the page yet (an office before its Wi-Fi): the spotlight goes there. */
  needs?: string;
  /** Signals Pip can propose for a task that sends people here. */
  signals?: readonly SignalTemplate[];
};

export declare const EVENTS: {
  readonly "office.added": string; readonly "office.network.saved": string; readonly "attendance.checked_in": string;
  readonly "attendance.office.arrived": string; readonly "checkin.arrival.saved": string; readonly "checkin.reminders.saved": string;
  readonly "payroll.cutoff.saved": string; readonly "presence.auto.saved": string; readonly "policy.published": string;
  readonly "holiday.added": string; readonly "leave.decided": string; readonly "project.added": string; readonly "client.added": string;
};
export type EventType = keyof typeof EVENTS;
export declare function said(event: string, data?: Record<string, unknown> | null): string;
export declare const DESTINATIONS: readonly Destination[];
export declare function destination(id: string | null | undefined): Destination | undefined;
export declare function dest(id: string): { "data-dest": string };
export declare function goHref(d: Destination | string, task?: string | null): string;
export declare function destForHref(href: string): Destination | undefined;
export declare function canSee(d: Destination, who: { role?: string | null; modulesOff?: readonly string[] | null }): boolean;
export declare function norm(s: string): string;
export declare function matchDestinations(text: string, limit?: number): { dest: Destination; score: number; matched: string }[];
export declare function placesIn(text: string): { label: string; dest: Destination }[];
