// PRODUCT-MAP: the pure model (manifests, analysis, user types, journeys, telemetry paths, plan, AI checks) and the repo
// scan on a small synthetic app. Names and values are made up.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { aiApply, aiBrief, analyse, autoFeatures, autoJourneys, autoPersonas, mineUsage, normalizeManifest, planSpec, routeKey, sameRoute, screenFor, specMarkdown } from "../dist/product-map-model.js";
import { hrefRoute, routeOf, scanRepo } from "../dist/product-map-scan.js";

const screen = (key, extra = {}) => ({ key, route: key, title: key === "/" ? "Home" : key.split("/").filter(Boolean).at(-1), purpose: "", area: key.split("/")[1] || "Home", access: [], proposed: false, status: "live", ...extra });
function sample() {
  return {
    name: "Synthetic Shop", roles: [{ key: "buyer", name: "Buyer", description: "" }, { key: "staff", name: "Staff", description: "" }], entries: ["/"],
    screens: [screen("/"), screen("/orders", { access: ["buyer", "staff"] }), screen("/orders/:id", { access: ["buyer", "staff"] }), screen("/admin", { access: ["staff"] }), screen("/lonely"), screen("/help")],
    elements: [
      { screen: "/", kind: "link", label: "Orders", target: "/orders", destructive: false, proposed: false },
      { screen: "/orders", kind: "link", label: "Open order", target: "/orders/:id", destructive: false, proposed: false },
      { screen: "/orders", kind: "button", label: "New order", target: "", destructive: false, proposed: false },
      { screen: "/orders", kind: "link", label: "Admin", target: "/admin", destructive: false, proposed: false },
      { screen: "/orders/:id", kind: "link", label: "Old page", target: "/gone", destructive: false, proposed: false },
      { screen: "/help", kind: "button", label: "Ask", target: "", destructive: false, proposed: false, handler: false },
    ],
    edges: [{ from: "/", to: "/orders", kind: "link", label: "Orders" }, { from: "/orders", to: "/orders/:id", kind: "link", label: "Open order" }, { from: "/orders", to: "/admin", kind: "link", label: "Admin" },
      { from: "*", to: "/help", kind: "nav", label: "Help" }],
    features: [], personas: [], journeys: [],
  };
}

test("routes: templates, matching and the screen a link names", () => {
  assert.equal(routeKey("/people/3f2a5b6c-1111-2222-3333-444455556666?tab=ai"), "/people/:id");
  assert.equal(routeKey("orders/42/"), "/orders/:id");
  assert.ok(sameRoute("/people/:id", "/people/:personId"));
  assert.ok(!sameRoute("/people", "/people/:id"));
  assert.equal(screenFor("/orders/77", ["/orders", "/orders/:id"]), "/orders/:id");
  assert.equal(hrefRoute("`/people/${p.id}?tab=ai`".slice(1, -1)), "/people/:id");
  assert.equal(hrefRoute("https://example.test/x"), null);
  assert.equal(routeOf(["(shop)", "people", "[id]"]), "/people/:id");
  assert.equal(routeOf(["@modal", "x"]), null);
});

test("a manifest is bounded and its links resolve to screens", () => {
  const { manifest, warnings } = normalizeManifest({ schema: "pulse-product-map/1", app: { name: "Synthetic", baseUrl: "javascript:alert(1)" },
    screens: [{ key: "/a", title: "A", elements: [{ kind: "weird", label: "Go", target: "/b/12" }] }, { route: "/b/:id", title: "B" }, { key: "/a", title: "dup" }],
    edges: [{ from: "/a", to: "/b/99" }, { from: "/a", to: "/nowhere" }, { from: "*", to: "/a", kind: "nav" }] });
  assert.equal(manifest.app.baseUrl, "");
  assert.equal(manifest.screens.length, 2);
  assert.equal(manifest.screens[0].elements[0].kind, "button");
  assert.deepEqual(manifest.edges.map((e) => `${e.from}>${e.to}`), ["/a>/b/:id", "*>/a"]);
  assert.deepEqual(warnings, []);
  assert.throws(() => normalizeManifest([]), /JSON object/);
});

test("the analysis finds unreachable screens, broken links, no-op buttons, permission gaps, slow screens and missing links", () => {
  const m = sample();
  m.usage = { screens: { "/orders": { views: 40, people: 5, sessions: 20, p75Ms: 6100, errors: 0, slowApiMs: null } }, transitions: [{ from: "/help", to: "/orders", count: 9, medianMs: 4000 }], paths: [], roles: {}, days: 30, sessions: 20 };
  m.personas = [{ key: "buyer", name: "Buyer", role: "buyer", permissions: [], features: [], goals: [], evidence: [], origin: "auto" }];
  m.journeys = [{ key: "j1", personaKey: "buyer", title: "Buy", goal: "", status: "planned", steps: [{ screen: "/" }, { screen: "/orders/:id" }, { screen: "/admin" }], evidence: [], acceptance: [] }];
  const kinds = analyse(m).map((i) => `${i.kind}:${i.screenKey}`);
  assert.ok(kinds.includes("orphan:/lonely"), "an unreachable screen");
  assert.ok(!kinds.includes("orphan:/help"), "the shared menu reaches it");
  assert.ok(kinds.includes("no_op:/orders/:id"), "a link to a page that does not exist");
  assert.ok(kinds.includes("no_op:/help"), "a button without a handler");
  assert.ok(kinds.includes("permission:/orders"), "buyers are shown a link to Admin");
  assert.ok(kinds.includes("permission:/admin"), "the journey's buyer cannot open Admin");
  assert.ok(kinds.includes("slow:/orders"));
  assert.ok(kinds.includes("missing_link:/"), "no link from Home to an order");
  assert.ok(kinds.includes("missing_link:/help"), "people go from Help to Orders without a link");
  for (const i of analyse(m)) { assert.ok(i.evidence.length, `${i.fingerprint} has evidence`); assert.ok(i.confidence > 0 && i.confidence <= 1); }
});

test("user types per role, features per area, and journeys from home to each feature", () => {
  const m = sample(); m.features = autoFeatures(m);
  assert.ok(m.features.some((f) => f.key === "orders" && f.screens.includes("/orders/:id")));
  m.usage = { screens: {}, transitions: [], paths: [], roles: { buyer: { people: 3, sessions: 60, phone: 50, desktop: 5, activeDays: 20, days: 30 } }, days: 30, sessions: 60 };
  const people = autoPersonas(m);
  const buyer = people.find((p) => p.role === "buyer");
  assert.equal(buyer.name, "Buyer"); assert.equal(buyer.device, "phone"); assert.equal(buyer.frequency, "daily");
  assert.ok(!buyer.permissions.includes("/admin"));
  assert.ok(buyer.evidence.some((e) => e.kind === "telemetry"));
  m.personas = people;
  const journeys = autoJourneys(m, people);
  const toOrders = journeys.find((x) => x.personaKey === "buyer" && x.key.endsWith("-orders"));
  assert.ok(toOrders, "buyer reaches Orders");
  assert.deepEqual(toOrders.steps.map((s) => s.screen).slice(0, 2), ["/", "/orders"]);
  assert.ok(toOrders.steps.some((s) => s.element === "New order"), "and uses its main action");
});

test("telemetry becomes screen use, moves and the paths people really walk", () => {
  const keys = ["/", "/orders", "/orders/:id", "/help"]; const ev = [];
  for (let s = 0; s < 4; s++) ["/", "/orders", "/orders/3f2a5b6c-1111-2222-3333-44445555666" + s, "/help"].forEach((page, i) =>
    ev.push({ session: `sess-${s}-abcdef`, person: `p${s % 2}`, role: "buyer", device: "phone", at: 1_700_000_000_000 + s * 1e6 + i * 5000, kind: i ? "nav.route" : "nav.load", page, ms: 900 + i * 10, status: null }));
  ev.push({ session: "sess-0-abcdef", person: "p0", role: "buyer", device: "phone", at: 1_700_000_000_999, kind: "error.js", page: "/help", ms: null, status: null });
  const u = mineUsage(ev, keys, { minSessions: 3 });
  assert.equal(u.screens["/orders/:id"].views, 4);
  assert.equal(u.screens["/help"].errors, 1);
  assert.equal(u.sessions, 4);
  assert.deepEqual(u.paths[0].steps, ["/", "/orders", "/orders/:id", "/help"], "the longest common path wins");
  assert.equal(u.paths[0].role, "buyer");
  const m = sample(); m.usage = u; m.personas = autoPersonas(m);
  const seen = autoJourneys(m).filter((x) => x.status === "discovered");
  assert.equal(seen.length, 1); assert.equal(seen[0].usage.sessions, 4);
});

test("the plan for the build team: steps, proposed screens, acceptance criteria, as JSON and Markdown", () => {
  const m = sample(); m.screens.push(screen("/orders/:id/track", { proposed: true, status: "proposed", title: "Track order" }));
  m.personas = [{ key: "buyer", name: "Buyer", role: "buyer", ageGroup: "25-40", skillLevel: "beginner", techComfort: "medium", goals: ["Know where my order is"] }];
  const j = { key: "track", personaKey: "buyer", title: "Track an order", goal: "See where it is", status: "planned", priority: "now", acceptance: [],
    steps: [{ screen: "/orders", action: "Opens an order", element: "Open order", expected: "The order shows" }, { screen: "/orders/:id/track", action: "Taps Track", element: "", expected: "A map with the parcel" }] };
  const spec = planSpec(m, { journeys: [j], ideas: [{ title: "Push when shipped", body: "", kind: "change", priority: "next", status: "planned", screens: ["/orders/:id/track"], votes: 2 }],
    issues: [{ kind: "no_op", severity: "high", title: "Broken link", detail: "", screenKey: "/orders", journeyKey: "", status: "open" }], version: { label: "v2.0", title: "" }, now: new Date("2026-10-25T00:00:00Z") });
  assert.equal(spec.journeys[0].steps[1].proposed, true);
  assert.equal(spec.journeys[0].acceptance.length, 2);
  assert.equal(spec.issues.length, 1);
  const md = specMarkdown(spec);
  for (const want of ["# Synthetic Shop: plan for v2.0", "### Track an order", "_(proposed, to build)_", "- [ ] On Track order", "## To build", "Push when shipped", "[high] Broken link", "age 25-40"]) assert.ok(md.includes(want), want);
});

test("the AI pass: a bounded brief, and an answer checked against the map", () => {
  const m = sample();
  const brief = aiBrief(m, 2000);
  assert.ok(brief.length <= 2000 && brief.includes("/orders | orders | buyer,staff"));
  const r = aiApply({ personas: [{ key: "busy-buyer", name: "Busy buyer", role: "buyer", ageGroup: "30-45", skillLevel: "beginner", confidence: 3, features: ["orders", "nope"] }],
    journeys: [{ title: "Reorder", personaKey: "busy-buyer", steps: [{ screen: "/" }, { screen: "/orders" }] }, { title: "Ghost", steps: [{ screen: "/x" }, { screen: "/y" }] }],
    issues: [{ kind: "missing_link", title: "No way back home", screenKey: "/orders/:id", confidence: 0.7 }], ideas: [{ title: "Quick reorder", screens: ["/orders", "/nope"] }] }, { ...m, features: [{ key: "orders", name: "Orders", screens: ["/orders"] }] });
  assert.equal(r.personas[0].key, "ai-busy-buyer"); assert.equal(r.personas[0].confidence, 1); assert.deepEqual(r.personas[0].features, ["orders"]);
  assert.equal(r.journeys.length, 1); assert.equal(r.journeys[0].personaKey, "ai-busy-buyer"); assert.equal(r.dropped, 1);
  assert.equal(r.issues[0].screenKey, "/orders/:id"); assert.deepEqual(r.ideas[0].screens, ["/orders"]);
});

test("the repo scan reads a Next.js app: routes, titles, elements, links, the shared menu and access", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-scan-"));
  const put = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
  put(".pulse-product-map.json", JSON.stringify({ roles: [{ key: "member", name: "Member" }, { key: "owner", name: "Owner" }], access: { all: ["member", "owner"], admin: ["owner"] }, navFiles: ["web/nav.tsx"] }));
  put("web/nav.tsx", `export const NAV = [{ label: "Home", href: "/", access: "all" }, { label: "Projects", href: "/projects", access: "all" }, { label: "Billing", href: "/billing", access: "admin" }];`);
  put("web/app/page.tsx", `export const metadata = { title: "Welcome" }; export default function P() { return <main><Link href="/projects">See projects</Link></main>; }`);
  put("web/app/projects/page.tsx", `import { List } from "./list"; export default function P() { return <><h1>Projects</h1><List /></>; }`);
  put("web/app/projects/list.tsx", `export function List({ items }) { return <div>{items.map((p) => <Link key={p.id} href={\`/projects/\${p.id}\`}>{p.name}</Link>)}<button type="button" onClick={() => add()}>New project</button><form onSubmit={save}><input aria-label="Project name" /><button type="submit">Save</button></form><Tabs items={[{ key: "open", label: "Open" }, { key: "done", label: "Done" }]} /></div>; }`);
  put("web/app/projects/[id]/page.tsx", `export default function P() { return <PageHeader title="Project" />; }`);
  put("web/app/help/page.tsx", `export default function P() { return <section><h1>Help</h1><button>Does nothing</button></section>; }`);
  put("web/app/billing/page.tsx", `export default function P() { return <button onClick={() => pay()}>Pay invoice</button>; }`);
  const r = scanRepo(root, "web");
  assert.deepEqual(r.screens.map((s) => s.key), ["/", "/billing", "/help", "/projects", "/projects/:id"]);
  const projects = r.screens.find((s) => s.key === "/projects");
  assert.equal(projects.title, "Projects"); assert.deepEqual(projects.access, ["member", "owner"]);
  const labels = projects.elements.map((e) => `${e.kind}:${e.label}`);
  for (const want of ["button:New project", "form:Save", "field:Project name", "tab:Open", "tab:Done"]) assert.ok(labels.includes(want), want);
  assert.equal(r.screens.find((s) => s.key === "/help").elements.find((e) => e.label === "Does nothing").handler, false);
  assert.equal(projects.elements.find((e) => e.label === "Save").handler, true);
  assert.equal(r.screens.find((s) => s.key === "/billing").elements[0].destructive, true);
  assert.deepEqual(r.screens.find((s) => s.key === "/billing").access, ["owner"]);
  assert.equal(r.screens.find((s) => s.key === "/").title, "Welcome");
  const edges = r.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);
  for (const want of ["/>/projects:link", "/projects>/projects/:id:link", "*>/billing:nav"]) assert.ok(edges.includes(want), want);
  assert.deepEqual(r.roles.map((x) => x.key), ["member", "owner"]);
});
