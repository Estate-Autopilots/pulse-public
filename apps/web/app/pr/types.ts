// PR-STUDIO: the shapes services/api/src/pr-studio.ts answers with.
import type { ImageSpec } from "./pr-image";

export type Kind = "release" | "feature" | "bug" | "task" | "goal" | "meeting" | "note";
export type Channel = "whatsapp" | "telegram" | "email" | "linkedin" | "x";
export type Tone = "warm" | "formal" | "bold" | "plain";
export type Ratio = "1:1" | "4:5" | "9:16" | "16:9";
export type Entry = { id: string; happenedOn: string; kind: Kind; title: string; body: string; edited: boolean; hidden: boolean; toldAt: string | null; collected: boolean; createdAt: string };
export type Brief = { id: string; kind: "morning" | "evening" | "update" | "weekly"; personId: string | null; day: string; title: string; body: string; entryIds: string[];
  writtenBy: "auto" | "ai" | "person"; author: string | null; createdAt: string };
export type Audience = { id: string; name: string; tone: Tone; channel: Channel; ratio: Ratio; note: string; archived: boolean };
export type Draft = { id: string; audienceId: string; audience: string; channel: Channel; tone: Tone; ratio: Ratio; briefId: string | null; entryIds: string[]; headline: string;
  copy: string; longPost: string; images: ImageSpec[]; status: "draft" | "planned" | "posted" | "skipped"; planOn: string | null; taskId: string | null; postedAt: string | null;
  writtenBy: "auto" | "ai" | "person"; createdAt: string; updatedAt: string };
export type Agent = { key: string; name: string; title: string; lane: "quick" | "thinking"; duty: string };
export type Dashboard = { today: string; company: string; month: string; briefs: Brief[]; waiting: Draft[]; calendar: Draft[]; untold: Entry[]; untoldCount: number;
  audiences: Audience[]; streak: number; toldLast30: number; activeDaysLast30: number; toldToday: boolean; agents: Agent[]; hired: string[]; me: string | null; voice: "on" | "off" };
export type Week = { startsOn: string; title: string; summary: string; edited: boolean; days: { day: string; entries: Entry[] }[] };
export type Month = { startsOn: string; title: string; summary: string; edited: boolean; weeks: Week[] };
export type StoryData = { from: string; to: string; months: Month[]; count: number };
