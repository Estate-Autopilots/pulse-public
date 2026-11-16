import Link from "next/link";
import { Download } from "lucide-react";

/** PULSE-APPS: the account menu's way to the Vitals OS installers (Android, Windows, iPhone). */
export function GetAppMenuItem() {
  return <Link role="menuitem" href="/apps/get"><Download size={16} aria-hidden="true" />Get Vitals OS</Link>;
}
