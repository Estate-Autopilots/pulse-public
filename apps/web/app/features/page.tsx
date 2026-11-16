import { pathSwitchedOff } from "@pulse/ui-shell";
import { Message } from "../ui";
import { Catalogue } from "../hq/catalogue";
import { HqFrame } from "../hq/frame";
import { api, getMe } from "../lib/api";
import { navFor, roleLabelFor } from "../lib/nav";
import type { Feature } from "../hq/model";

export const dynamic = "force-dynamic";
export const metadata = { title: "What Pulse can do" };

/** PULSE-HQ (owner, 23 Oct 2026): what Pulse can do, for every organisation: the catalogue the Pulse organisation keeps
 *  (0947), read only. Home → What Pulse can do.
 *  VISUAL-QA (10 Nov 2026): a feature switched off in this company (or on this Pulse) keeps its line but loses its
 *  "Open" link, which led to "This module is not switched on" (Creative Strategy, Network, Hiring, Skills in EA). */
export default async function WhatPulseCanDo() {
  const [r, me] = await Promise.all([api<{ features: Feature[] }>("features"), getMe()]);
  if (r.error || !r.data) return <Message text={r.error ?? "The catalogue is unavailable."} />;
  const modulesOff = me.data?.modules?.off;
  const nav = me.data ? navFor(me.data) : null;
  // Bases this person's menu leaves out (switched off, hidden from the role, refused): no link to them either.
  const companyOff = Object.entries(nav?.rename ?? {}).filter(([href, label]) => label === null && !href.includes("?")).map(([href]) => href);
  const hidden = nav?.hiddenPaths ?? [];
  const under = (href: string, base: string) => { const p = href.split(/[?#]/)[0]; return p === base || p.startsWith(base + "/"); };
  // VISUAL-QA (D131, 13 Nov 2026): addresses that are not pages: Search everything is the Ctrl+K palette, and /search is a 404.
  const NO_PAGE = ["/search"];
  const opens = (href: string) => !NO_PAGE.some((b) => under(href, b)) && !pathSwitchedOff(href, modulesOff) && !companyOff.some((b) => under(href, b)) && !hidden.some((b) => under(href, b));
  const features = r.data.features.map((f) => f.href && !opens(f.href) ? { ...f, href: null } : f);
  return <HqFrame><Catalogue features={features} base="/features" title="What Pulse can do" menuFor={me.data ? { role: roleLabelFor(me.data), off: modulesOff, rename: nav?.rename } : undefined} /></HqFrame>;
}
