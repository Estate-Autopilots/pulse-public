/**
 * The admin site's navigation (PULSE-ADMIN), after the Sales X-Ray admin console's: grouped sections, the phone bar
 * from `phone`. Everyone who reaches the console is a platform admin (checked by the API on every read and command);
 * nothing here grants access.
 */
export type NavIcon =
  | "home" | "bugs" | "feedback" | "organisations" | "people" | "usage" | "spend" | "telemetry" | "health"
  | "releases" | "updates" | "audit" | "integrations" | "settings" | "setup";

export type NavItem = Readonly<{ href: string; label: string; icon: NavIcon; phone?: boolean; also?: readonly string[] }>;
export type NavGroup = Readonly<{ label: string; items: readonly NavItem[] }>;

export const NAVIGATION: readonly NavGroup[] = [
  {
    label: "",
    items: [
      { href: "/", label: "Home", icon: "home", phone: true },
      { href: "/bugs", label: "Bugs", icon: "bugs", phone: true },
      { href: "/feedback", label: "Feedback", icon: "feedback" },
    ],
  },
  {
    label: "Accounts",
    items: [
      { href: "/organisations", label: "Organisations", icon: "organisations", phone: true },
      { href: "/people", label: "People", icon: "people", phone: true },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/usage", label: "Usage", icon: "usage" },
      { href: "/ai-spend", label: "AI spend", icon: "spend" },
      { href: "/telemetry", label: "Product telemetry", icon: "telemetry" },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/health", label: "System health", icon: "health" },
      { href: "/releases", label: "Releases & status", icon: "releases" },
      { href: "/updates", label: "Announcements", icon: "updates" },
      { href: "/integrations", label: "Integrations", icon: "integrations" },
      { href: "/audit", label: "Audit log", icon: "audit" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

export function visibleNavigation(): NavGroup[] {
  return NAVIGATION.map((group) => ({ label: group.label, items: [...group.items] }));
}

function matches(href: string, pathname: string, search: URLSearchParams): boolean {
  const [path = "/", query = ""] = href.split("?");
  if (query) {
    if (pathname !== path) return false;
    for (const [key, value] of new URLSearchParams(query)) if (search.get(key) !== value) return false;
    return true;
  }
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
}

/** The item a location belongs to: the most specific matching href wins. */
export function activeHref(pathname: string, groups: readonly NavGroup[], search = ""): string | null {
  const params = new URLSearchParams(search);
  let best: string | null = null;
  let bestLength = 0;
  for (const group of groups)
    for (const item of group.items)
      for (const href of [item.href, ...(item.also ?? [])])
        if (matches(href, pathname, params) && href.length > bestLength) {
          best = item.href;
          bestLength = href.length;
        }
  return best;
}
