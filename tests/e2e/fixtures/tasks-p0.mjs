// TASKS-P0 specs on wholly invented data: a task page (hero, steps, unlocks, a real PDF proof, a protected document),
// a person's board grouped by when, mentions and the actions each role sees. Served by mock-editors-api.mjs:
//   admin@  → the doer of the task (Synthetic Admin)        hr@ → its reviewer, and the task is done
//   anyone else → neither (Synthetic Sam): Follow / Ask to join, never "Take it"
// Board dates use the shared synthetic clock; task-detail dates remain relative to the request.
// RELEASE-4: the task carries TASKS-4B's `life` (the reviewer's bar, the clock) and the person's board is TASKS-4A's
// `work/list?scope=person` with its `work/views` preferences, as the real API serves them.
import { readFileSync } from "node:fs";
import { TASKS_NOW } from "./tasks-clock.mjs";

const PDF = readFileSync(new URL("./tasks-p0/roadmap-synthetic.pdf", import.meta.url));
const istDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const plus = (n) => istDay(Date.now() + n * 86400000);
const at6 = (day) => new Date(`${day}T18:00:00+05:30`).toISOString();
const KEDAB = { id: "tp-kedab", name: "Kedab Demo", role: "Co-founder (synthetic)", pod: "Leadership", photoAt: null };
const ASHA = { id: "tp-asha", name: "Asha Demo", role: "HR executive (synthetic)", pod: "Shared", photoAt: null };
const RIFOB = { id: "tp-rifob", name: "Rifob Demo", role: "Engineer (synthetic)", pod: "Tech", photoAt: null };
const PROJECT = { id: "tp-launch", name: "Launch & admin (synthetic)" };
const comments = [];
const notices = [];

const task = (over) => ({
  id: "tp-task", title: "Send HR the office Wi-Fi name and the office public IP", status: "open", priority: "high", projectId: PROJECT.id, projectName: PROJECT.name, parentId: null,
  assigneeId: KEDAB.id, assigneeName: KEDAB.name, assigneePhotoAt: null, reviewerId: ASHA.id, reviewerName: ASHA.name, createdBy: "synthetic-admin",
  dueAt: at6(plus(0)), dueOn: plus(0), dueLabel: null, workOn: null, type: null, startedAt: null, doneAt: null, acceptedAt: null, effort: null, impact: null, points: null,
  valueNote: "Unlocks: check-in on arrival, so attendance is accurate and payroll can come from Pulse.", source: "pulse", sourceStatus: null, sourcePeriod: null, trackerProject: null, trackerOwner: null,
  updatedAt: null, createdAt: null, openBlockers: 0, subtasks: 0, subtasksDone: 0, proof: 2, category: "hr", categoryLabel: "HR and people", tags: [], urgency: "normal", estimateMinutes: 15, valuePoints: 5,
  valueSource: "set", poolScope: null, poolRef: null, claimedBy: null, suggestedPoints: null, projectPod: null, projectKind: "internal", inDomain: null, comments: 1, waiting: 2, unlockedAt: null,
  projectCategory: "launch", projectCategoryLabel: "Launch", projectColor: "violet", projectIcon: "rocket", ...over,
});
const notes = "Send HR two things: the office Wi-Fi name, and the public IP address of the office internet.\n1. Connect a phone or laptop to the office Wi-Fi.\n2. Search Google for \"what is my IP\": https://www.google.com/search?q=what+is+my+ip\n3. Send both to Asha on WhatsApp.\nHR adds both in Pulse → HR → Policies → Office presence.";

function detail(role, me) {
  const doer = role === "admin", reviewer = role === "hr";
  const t = task({ notes, locked: [], requiresProof: false, canEdit: doer || reviewer, evidenceSource: null, canValue: reviewer, suggestion: null,
    ...(doer ? { assigneeId: me.person, assigneeName: me.name } : {}), ...(reviewer ? { status: "done", doneAt: new Date().toISOString(), reviewerId: me.person, reviewerName: me.name } : {}) });
  return {
    task: t, parents: [], children: [], blockedBy: [], blocks: [], events: [{ kind: "created", from: null, to: t.title, note: null, at: new Date(Date.now() - 86400000).toISOString(), by: "Synthetic Admin" }],
    proof: [
      { id: "tp-pdf", kind: "file", label: "Pulse roadmap (synthetic).pdf", url: null, addedAt: new Date().toISOString(), addedBy: "Synthetic Admin", readable: true },
      { id: "tp-doc", kind: "document", label: "Offer letter (synthetic draft)", url: null, addedAt: new Date().toISOString(), addedBy: "Synthetic HR", readable: false, concerns: null },
    ],
    time: [], me: me.person, members: [], asks: [], watching: false, project: { kind: "internal", clientName: null, summary: "Synthetic: everything before the team moves onto Pulse.", category: "launch", color: "violet", icon: "rocket" },
    comments: comments.length ? comments : [{ id: "tp-c0", body: `@${KEDAB.name} the Wi-Fi name is on the router label.`, at: new Date(Date.now() - 3600000).toISOString(), authorId: ASHA.id, authorName: ASHA.name, authorPhotoAt: null, mine: false, people: [KEDAB] }],
    checks: [], plan: null, same: [],
    unlocks: { tasks: [
      { id: "tp-w1", title: "Add the office Wi-Fi and IP in Pulse → HR → Policies → Office presence", status: "blocked", personId: ASHA.id, personName: ASHA.name, photoAt: null, valuePoints: 3, points: null, estimateMinutes: 10, dueOn: plus(2), dueAt: at6(plus(2)), openBlockers: 1 },
      { id: "tp-w2", title: "Turn on check-in on arrival", status: "open", personId: RIFOB.id, personName: RIFOB.name, photoAt: null, valuePoints: 8, points: null, estimateMinutes: 60, dueOn: plus(3), dueAt: at6(plus(3)), openBlockers: 1 },
    ], now: 2, people: 2, value: 11, minutes: 70, chain: { tasks: 2, value: 11, minutes: 70, people: 2 } },
    can: { edit: doer || reviewer, accept: reviewer, take: false, review: reviewer, ask: doer, join: role !== "admin" && role !== "hr", value: reviewer, claim: false, release: false },
    life: { flags: [], leaderWork: false, mode: "rate", policy: { reviewBy: "assigner", reviewScale: "three", reviewLeaders: "acknowledge", aboveBonus: 25, helpPoints: 2, reviewNudgeHours: 24 },
      quality: [{ value: "great", label: "Great" }, { value: "good", label: "Good" }, { value: "needs_work", label: "Needs work" }], credit: null, acceptedBy: null,
      doneBy: reviewer ? { id: KEDAB.id, name: KEDAB.name } : null, returned: null, timing: null, waited: reviewer ? "under an hour" : null, me: me.person,
      clock: { running: null, last: null, captured: 0, proposed: 0, mine: doer }, askEstimate: false },
  };
}

function board(me) {
  // Match the browser's fixed starting time, including when CI runs after 23:59 IST.
  const plus = (n) => istDay(TASKS_NOW + n * 86400000);
  const mk = (id, title, day, over = {}) => task({ id, title, dueOn: day, dueAt: day ? (day === plus(0) ? new Date(`${day}T23:59:00+05:30`).toISOString() : at6(day)) : null, waiting: 0, comments: 0, proof: 0, ...over });
  const open = [
    mk("tp-b1", "File GSTR-1 (Jul–Sep) with the CA", plus(-2), { priority: "urgent", status: "in_progress", valuePoints: 13 }),
    mk("tp-b2", "Send HR the office Wi-Fi name and the office public IP", plus(0), { valuePoints: 5, waiting: 2, comments: 1 }),
    mk("tp-b3", "Decide the check-in rules", plus(0), { valuePoints: 8, subtasks: 3, subtasksDone: 1, unlockedAt: new Date(TASKS_NOW - 3600000).toISOString() }),
    mk("tp-b4", "Approve staff notice v2 (privacy and consent)", plus(1), { proof: 1 }),
    mk("tp-b5", "Make sure every team member adds their bank details in Pulse", plus(4), { priority: "normal" }),
    mk("tp-b6", "Record a 2-minute welcome video for new joiners", null, { priority: "low", projectId: null, projectName: null }),
  ];
  return { scope: "person", pod: null, pods: ["Leadership", "Tech"], myPod: "Studio", me: me.person, canAll: true,
    columns: { todo: open.filter((t) => t.status === "open"), doing: open.filter((t) => t.status === "in_progress"), blocked: [], done: [], accepted: [] },
    counts: [{ status: "open", n: 5 }, { status: "in_progress", n: 1 }], blockers: [], people: [KEDAB, ASHA, RIFOB], person: KEDAB, same: {}, today: plus(0) };
}

/** TASKS-4A: a person's tasks as one list (work/list?scope=person; My tasks asks with scope=me), the board groups them by
 *  when in the browser. */
function list(me, scope) {
  const b = board(me);
  return { scope, pod: null, pods: b.pods, myPod: b.myPod, me: me.person, today: b.today, canAll: true, openCount: 6, truncated: false,
    rows: [...b.columns.todo, ...b.columns.doing], person: scope === "person" ? KEDAB : null, project: null, labels: { team: "Pod", teams: "Pods" } };
}

const staff = (me) => [{ ...me, id: me.person, name: me.name }, KEDAB, ASHA, RIFOB].map((p) => ({ id: p.id, name: p.name, pod: p.pod ?? "Studio", role: p.role ?? "Synthetic", photoAt: null, canAssign: true, username: null }));

const PATHS = /^\/api\/v0\/(tasks(\/|$)|work\/(options|comments|asks|watch|notices|project-categories|list|views)(\/|$|\?))/;
/** [status, body] for JSON, { binary, type, disposition } for the proof's bytes, or null when the path is not ours. */
export function mockAnswer(url, method, role, me, body = {}) {
  const p = url.pathname;
  if (!PATHS.test(p)) return null;
  if (method === "GET") {
    if (p === "/api/v0/tasks") {
      const parent = task({ id: "tp-parent", title: "Synthetic launch checklist", subtasks: 1, subtasksDone: 0 });
      const child = task({ id: "tp-child", title: "Synthetic proofread", parentId: parent.id, parentTitle: parent.title, projectName: null, assigneeName: null, assigneeId: null });
      return [200, { rows: [parent, child], total: 2, page: 0, size: 200, statuses: [{ status: "open", n: 2 }], types: [], mine: 0, me: me.person, canLead: true }];
    }
    if (p === "/api/v0/tasks/proof/tp-pdf") return { binary: PDF, type: "application/pdf", disposition: "inline; filename*=UTF-8''roadmap-synthetic.pdf" };
    if (p === "/api/v0/tasks/proof/tp-doc") return [403, { error: "This document is protected. HR, the founders and the person it concerns can open it." }];
    if (p === "/api/v0/tasks/options") return [200, { me: me.person, people: staff(me), reviewers: staff(me), projects: [{ id: PROJECT.id, name: PROJECT.name, tasks: 6 }] }];
    if (p === "/api/v0/tasks/board") return [200, board(me)];
    if (p === "/api/v0/tasks/tp-task/plan") return [200, { plan: null }];
    if (p === "/api/v0/tasks/tp-task") return [200, detail(role, me)];
    if (p === "/api/v0/tasks/home") return [200, { me: me.person, canLead: true, workRole: "leadership", today: plus(0), week: plus(0), rows: board(me).columns.todo, blockers: [], waitingOnMe: [], review: [], summary: null, same: {} }];
    if (p === "/api/v0/work/options") return [200, { me: me.person, today: plus(0), people: staff(me), projects: [], clientProjects: [], templates: [], role, roleLabel: role }];
    if (p === "/api/v0/work/asks") return [200, { incoming: [], outgoing: [] }];
    if (p.startsWith("/api/v0/work/notices")) return [200, { rows: notices.filter((n) => n.to === me.person) }];
    if (p === "/api/v0/work/project-categories") return [200, { rows: [], canEdit: false }];
    if (p === "/api/v0/work/list" && ["person", "me"].includes(url.searchParams.get("scope"))) return [200, list(me, url.searchParams.get("scope"))];
    if (p === "/api/v0/work/views") return [200, { place: url.searchParams.get("place") ?? "person", layout: null, defaultLayout: null, config: {}, saved: [], ask: null }];
    return [404, { error: "Synthetic task route not found" }];
  }
  if (p === "/api/v0/work/comments") {
    const people = [KEDAB, ASHA, RIFOB].filter((x) => (body.mentions ?? []).includes(x.id));
    comments.push({ id: `tp-c${comments.length + 1}`, body: String(body.body ?? ""), at: new Date().toISOString(), authorId: me.person, authorName: me.name, authorPhotoAt: null, mine: true, people, mentions: body.mentions ?? [] });
    for (const x of people) notices.push({ to: x.id, eventType: "task.mention", title: `${me.name} mentioned you on “${task({}).title}”`, subject: { type: "task", id: body.taskId } });
    return [200, { id: comments.at(-1).id }];
  }
  if (/\/move$/.test(p)) return [200, { status: body.status, released: 0, weekDone: 1, streak: 1 }];
  if (/\/plan$/.test(p)) return [200, { plan: { summary: "3 steps, about 15 min, from your phone; it goes to Asha.", steps: [], fromNotes: true, fastest: ["Every step works from your phone."], ask: [{ id: ASHA.id, name: ASHA.name, why: "HR: the task is for them" }],
    message: { channel: "WhatsApp", to: ASHA.name, toId: ASHA.id, text: "Hi Asha, here are the details you asked for:\n• Office Wi-Fi name: ____\n• Office public IP: ____\n— Admin" }, basis: [], planner: "pip-planner-heuristic", version: "1", at: new Date().toISOString(), fresh: true } }];
  return [200, { ok: true }];
}
