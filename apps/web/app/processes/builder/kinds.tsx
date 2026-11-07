// FLOW-B: what the builder draws for kinds and module icons. A kind has one colour in both themes (the categorical set
// the SOP area uses, plus three more checked for contrast on light and dark cards); "anything" is grey. Module icons are
// named in the module's manifest (a lucide name, "file-text" or "FileText"); the names modules use are mapped here, and
// anything else draws a square.
import {
  ArrowDownToLine, AudioLines, BadgeCheck, Bell, Blocks, BookA, Bot, CalendarClock, CalendarPlus, Camera, CircleHelp, Clapperboard, ClipboardCheck, ClipboardList, Crosshair, FileAudio, FilePen,
  FilePenLine, FileSignature, FileSpreadsheet, FileText, Film, Flag, FolderPlus, Forward, Gauge, Gavel, Gem, GitBranch, GitFork, Hourglass, Inbox, Library, Lightbulb, ListChecks, ListOrdered,
  ListPlus, ListTodo, LogIn, Magnet, MapPin, MessageCircleReply, MessageSquareText, MessagesSquare, Mic, Package, PenLine, PhoneForwarded, Play, Receipt, ReceiptText, Repeat, ScanSearch, Scissors, ScrollText,
  Send, ShieldCheck, Sparkles, Square, SquareCheck, Stamp, Star, Sun, Swords, Table, Tag, Timer, Upload, UserCheck, UserPlus, UserRound, Users, Video, Webhook, Workflow, type LucideIcon,
} from "lucide-react";
import type { Engine, Kind } from "../flow-types";

export const KIND_SLOT: Record<Kind, number> = { contact: 1, talk: 2, doc: 3, media: 4, answers: 5, money: 6, verdict: 7, slot: 8, list: 9, any: 0 };
export const KIND_WORD: Record<Kind, string> = { contact: "Contact", talk: "Talk", doc: "Document", media: "Media", answers: "Answers", money: "Money", verdict: "Verdict", slot: "Time slot", list: "List", any: "Anything" };
export const ENGINE_BADGE: Record<Engine, { label: string; title: string }> = {
  live: { label: "Live", title: "Built and working end to end" },
  partial: { label: "Partly built", title: "Works; part of it opens another page or is typed in by hand" },
  stub: { label: "Coming soon", title: "Holds its place in a process; its screen is not built yet" },
};

const ICONS: Record<string, LucideIcon> = {
  ArrowDownToLine, AudioLines, BadgeCheck, Bell, Blocks, BookA, Bot, CalendarClock, CalendarPlus, Camera, CircleHelp, Clapperboard, ClipboardCheck, ClipboardList, Crosshair, FileAudio, FilePen,
  FilePenLine, FileSignature, FileSpreadsheet, FileText, Film, Flag, FolderPlus, Forward, Gauge, Gavel, Gem, GitBranch, GitFork, Hourglass, Inbox, Library, Lightbulb, ListChecks, ListOrdered,
  ListPlus, ListTodo, LogIn, Magnet, MapPin, MessageCircleReply, MessageSquareText, MessagesSquare, Mic, Package, PenLine, PhoneForwarded, Play, Receipt, ReceiptText, Repeat, ScanSearch, Scissors, ScrollText,
  Send, ShieldCheck, Sparkles, Square, SquareCheck, Stamp, Star, Sun, Swords, Table, Tag, Timer, Upload, UserCheck, UserPlus, UserRound, Users, Video, Webhook, Workflow,
};
const pascal = (name: string) => name.includes("-") ? name.split("-").map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join("") : name.charAt(0).toUpperCase() + name.slice(1);
export function ModuleIcon({ name, size = 16 }: { name: string | undefined; size?: number }) {
  const Icon = (name && ICONS[pascal(name)]) || Square;
  return <Icon size={size} aria-hidden="true" />;
}
