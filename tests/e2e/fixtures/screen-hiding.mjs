// EST-1803: isolated synthetic tenants, matching services/api/src/screens.ts's wire contract.
// Real authorization/schema/registry persistence is exercised by tests/core/test_screen_visibility.py.
const registry = [
  ["dashboard", ["/dashboard"], true], ["work", ["/tasks", "/my-week", "/delivery", "/portal"]],
  ["chats", ["/chats", "/communication", "/inbox", "/groups"], true],
  ["clients", ["/clients", "/projects", "/stewardship/client", "/stewardship/project", "/deliveries"]],
  ["acquisition", ["/acquisition"]], ["contacts", ["/contacts", "/stewardship/contact", "/relationships"]],
  ["map", ["/map"]], ["sops", ["/sops"]], ["network", ["/network"]],
  ["team", ["/people", "/activity", "/stewardship/person", "/designers"]],
  ["me", ["/me", "/attendance", "/leave", "/notifications", "/welcome"], true],
  ["hr", ["/hr", "/hr-history", "/shifts"], true], ["leadership", ["/leadership", "/pod", "/pods"]],
  ["finance", ["/finance"]], ["erp", ["/erp"]], ["review", ["/review-data", "/opshub"]], ["audit", ["/audit"]],
].map(([key, paths, fixed = false]) => ({ key, paths, fixed }));
const roles = ["admin", "leadership", "finance", "hr", "manager", "pgs", "person"];
const tenants = new Map();
export function screenTenant(identity) {
  const domain = identity.split("@")[1];
  if (!/^screen-[a-z-]+\.example$/.test(domain ?? "")) return null;
  if (!tenants.has(domain)) {
    const screens = registry.filter((s) => domain !== "screen-future.example" || s.key !== "contacts");
    tenants.set(domain, { screens, known: screens.map((s) => s.key), hidden: {}, newScreensHidden: false });
  }
  return tenants.get(domain);
}
const keysFor = (t, role) => t.screens.filter((s) => !s.fixed && ((t.hidden[role] ?? []).includes(s.key)
  || (t.newScreensHidden && !t.known.includes(s.key)))).map((s) => s.key);
export function screenHidden(t, role) {
  const keys = keysFor(t, role);
  return { keys, paths: t.screens.filter((s) => keys.includes(s.key)).flatMap((s) => s.paths) };
}
export function screenAnswer(t, url, method, me, body) {
  const path = url.pathname, admin = me.role === "admin";
  const shape = () => ({ screens: t.screens.map((s) => ({ key: s.key, href: s.paths[0], fixed: s.fixed })), roles,
    newScreensHidden: t.newScreensHidden, hidden: Object.fromEntries(roles.map((r) => [r, keysFor(t, r)])), canEdit: admin });
  if (path === "/api/v0/settings/screens") {
    if (!admin) return [403, { error: "Organisation admins choose the screens each role sees" }];
    if (method === "POST") {
      const valid = typeof body.newScreensHidden === "boolean" && body.hidden && typeof body.hidden === "object"
        && Object.keys(body).every((k) => ["newScreensHidden", "hidden"].includes(k))
        && Object.entries(body.hidden).every(([role, keys]) => roles.includes(role) && Array.isArray(keys)
          && new Set(keys).size === keys.length && keys.every((key) => t.screens.some((s) => s.key === key && !s.fixed)));
      if (!valid) return [400, { error: "Choose non-fixed screens and roles from the list" }];
      Object.assign(t, body, { known: t.screens.map((s) => s.key) });
    }
    return [200, shape()];
  }
  // Simulate the next API registry release, after the admin saved the current known keys.
  if (path === "/api/v0/__test/screens/add" && method === "POST" && admin) {
    if (!t.screens.some((s) => s.key === "contacts")) t.screens.push(registry.find((s) => s.key === "contacts"));
    return [200, shape()];
  }
  if (path === "/api/v0/settings/modules") return [200, { modules: { tasks: true, chats: true, finance: true, attendance: true }, canEdit: admin }];
  if (path === "/api/v0/settings") return [200, { org: { name: "Synthetic Studio" }, roles: [], people: [], permissions: [], canEdit: admin, canGrant: false }];
  const person = { id: "synthetic-colleague", name: "Synthetic Colleague", role: "Designer", status: "active", pod: "Studio" };
  if (path === "/api/v0/people") return [200, { people: [person], pods: [], canEdit: false, viewer: me.person }];
  if (path === "/api/v0/clients") return [200, { clients: [{ id: "synthetic-client", name: "Synthetic Client", engagements: 1, projects: 1, deliveries: 0, locations: [] }], unassigned: 0, canEdit: false }];
  if (path === "/api/v0/projects") return [200, { projects: [{ projectId: "synthetic-project", title: "Synthetic Project" }] }];
  if (path === "/api/v0/search") return [200, { q: url.searchParams.get("q"), groups: [
    ["tasks", "task", "/tasks/synthetic-task", "Synthetic Task"], ["sops", "sop", "/sops/synthetic-sop", "Synthetic SOP"],
    ["places", "place", "/map/synthetic-place", "Synthetic Place"], ["contacts", "contact", "/contacts/synthetic-contact", "Synthetic Visible"],
  ].map(([key, kind, href, title]) => ({ key, label: key, items: [{ id: `synthetic-${kind}`, kind, href, title, score: 1 }] })) }];
  if (path === `/api/v0/people/${me.person}`) return [200, { ...person, id: me.person, name: me.name, userNo: null, username: null,
    joinedOn: null, photoAt: null, managerId: null, managerName: null, email: null, phone: null, department: null,
    locked: [], skills: [], sources: [], flags: [], accounts: [], reports: [], managers: [], projects: [], deliveries: [], history: [],
    attendance: [], leave: [], fieldSources: {}, can: { self: true, me: true }, workDetail: "Synthetic profile" }];
  return null;
}
