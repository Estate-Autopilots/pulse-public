import { Briefcase, Building2, Calendar, Clapperboard, Code, Folder, GraduationCap, Heart, Megaphone, Package, Rocket, Shield, Sparkles, Users, Wallet, Wrench, type LucideIcon } from "lucide-react";

/** PM-BUILD-3: what the project-management screens share, server and client alike (no hooks, no "use client"). */
export const ICONS: Record<string, LucideIcon> = { folder: Folder, briefcase: Briefcase, rocket: Rocket, wallet: Wallet, users: Users, clapperboard: Clapperboard, code: Code,
  megaphone: Megaphone, building: Building2, heart: Heart, sparkles: Sparkles, shield: Shield, wrench: Wrench, calendar: Calendar, "graduation-cap": GraduationCap, package: Package };
const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
/** "21 Nov". */
export const day = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));
