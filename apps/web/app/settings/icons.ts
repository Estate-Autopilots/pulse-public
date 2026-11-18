// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.1): one icon per Settings section and area, shared by the list pane (a client
// component) and the overview. Icons are components, so they never cross from a server component into a client one.
import type { LucideIcon } from "lucide-react";
import { Activity, Bell, Briefcase, Building2, Cable, HardDrive, KeyRound, LayoutGrid, ListChecks, Lock, LogIn, Mail, MessagesSquare, Monitor, Palette, Plug, RefreshCw, Server, ShieldCheck, Smartphone, Sparkles, Terminal, UserRound, Users } from "lucide-react";
import type { TabKey } from "./types";

export const TAB_ICON: Record<TabKey, LucideIcon> = {
  account: UserRound, notifications: Bell, appearance: Palette, privacy: Lock, devices: Smartphone, "connected-apps": KeyRound, "api-keys": Terminal, "connect-ai": Sparkles,
  organisation: Building2, industry: Briefcase, "sign-in": LogIn, "work-rules": ListChecks, roles: ShieldCheck, team: Users, chats: MessagesSquare,
  apps: LayoutGrid, connectors: Cable, ai: Sparkles, servers: Server, mail: Mail, connected: RefreshCw, "data-health": Activity, "desktop-app": Monitor,
};
export const AREA_ICON: Record<string, LucideIcon> = { you: UserRound, organisation: Building2, access: ShieldCheck, connections: Plug, ai: Sparkles, data: HardDrive };
