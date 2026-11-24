// PM-UI (22 Nov 2026): the view-model types every PM screen shares. Names are SPEC v1.1's logical names in camelCase
// (scratch/pm-ui/SPEC.md); each field says where it comes from. Types only: no data, no logic. A screen's own view model
// lives in contract/<screen>.ts and builds on these (see contract/README.md).

/** A calendar day as `YYYY-MM-DD` (no time, no zone). Every date in a view model is one of these. */
export type IsoDate = string;
/** A moment as an ISO 8601 date-time with offset (`2026-11-21T17:00:00+05:30`): only where a time of day shows. */
export type IsoDateTime = string;

/** A person in the company (or a client contact). SPEC §1.4 role_map values, §4 permissions. */
export type Person = {
  /** users.id (or the client contact's id). */ id: string;
  /** Full name, e.g. "Kavya Rao". Screens show the first name where space is short (kit `firstName`). */ name: string;
  /** Job role in words, e.g. "Growth lead", "Video editor" (§7 roles). */ role: string;
  /** When the photo last changed (the app's Avatar shows it); absent = initials. */ photoAt?: string | null;
  /** True for a client contact (§1.2): never shown as a team member. */ client?: boolean;
};

/** A project's identity colour: one of the design system's category hues (`--ds-hue-*`). The iris (indigo) is left out
 *  on purpose: SPEC §0 rule 9, the accent means "press this / you are here", never a project. */
export type HueKey = "teal" | "green" | "sky" | "amber" | "pink" | "orange" | "slate";

/** A project's icon (lucide-react, mapped in kit.tsx `PROJECT_ICONS`). SPEC §1.4 icon. */
export type IconKey = "building" | "flower" | "waves" | "tree" | "sun" | "palm" | "sparkles" | "house" | "rocket" | "megaphone" | "video" | "globe" | "store" | "landmark";

/** A project as other screens point at it. SPEC §1.4 (id, name, colour, icon) + §1.2 client. */
export type ProjectRef = {
  id: string;
  /** e.g. "Orchid Towers launch". */ name: string;
  /** The client's name (§1.2), e.g. "Orchid Realty"; null for an internal project. */ client: string | null;
  /** Identity colour (§1.4 colour; editable per project). */ hue: HueKey;
  /** Identity icon (§1.4 icon; editable per project). */ icon: IconKey;
};

/** Project health (computed). SPEC §3.2 and §0.5.3 (first match wins: paused/done → needs_setup → not_started →
 *  waiting_client → late → at_risk → on_track). Sort order on lists: kit `HEALTH_ORDER`. */
export type HealthKey = "needs_setup" | "not_started" | "waiting_client" | "late" | "at_risk" | "on_track" | "paused" | "done";

/** Health with its reason in words. SPEC §3.2 "Words shown"; every key but `on_track` carries a reason (§0 rule 3). */
export type Health = {
  key: HealthKey;
  /** The top reason, without the health word: "shoot moved 3 days", "floor plans, 4 days", "no lead yet",
   *  "Starts when invoice is paid". */ reason?: string;
};

/** A step's status. SPEC §3.1, exactly. Late is NOT a status: it is the `LateFlag` beside it. */
export type StepStatus = "blocked" | "todo" | "doing" | "in_review" | "changes" | "waiting_client" | "done" | "skipped";

/** The late flag (SPEC §3.1): due < today and not done/skipped. `who: "client"` when the step waits on the client
 *  ("Client late · 2 days", amber, not counted against the team); else "team" ("Late · 2 days", red). */
export type LateFlag = { /** Days past due (≥ 1). */ days: number; who: "team" | "client" };

/** A named project date. SPEC §1.9 + §0.5.1: due dates use `actual`, else `planned`; both empty = not started. */
export type Clock = {
  /** Template clock key: `invoice_paid`, `inputs_complete`, `ads_live` (§7). */ key: string;
  /** In words: "Invoice paid", "Day 0: inputs complete", "Ads live". */ label: string;
  planned?: IsoDate | null;
  /** Set when it happened (a paid invoice sets `invoice_paid`, §6 rule 13). Shown ticked. */ actual?: IsoDate | null;
};

/** The project's active clock in one line (SPEC §5.1, PICKS 01 must-fix): "Day 12 of 45 · Ads live in 33 days (15 Dec)".
 *  Always `day + daysLeft = of`. Build it with canon `clockLine()`, never by hand. */
export type ClockLineVM =
  | { state: "running"; /** days since Day 0 */ day: number; /** plan length */ of: number; /** "Ads live" */ target: string; daysLeft: number; date: IsoDate }
  | { state: "before"; /** "Day 0" */ start: string; startDate: IsoDate; target: string; date: IsoDate }
  | { state: "passed"; target: string; date: IsoDate; daysAgo: number; /** the target clock has an actual date */ done: boolean }
  | { state: "unset"; /** "Starts when invoice is paid" */ note: string };

/** Phase status, computed. SPEC §1.5. */
export type PhaseStatus = "not_started" | "active" | "done" | "late";

/** A phase of a project's plan. SPEC §1.5 (+ §1.3 client_name). */
export type Phase = {
  id: string;
  /** internal_name, e.g. "Brand blueprint". */ name: string;
  /** client_name: the name the client sees ("Getting your site ready"); absent = not client-facing by name. */ clientName?: string;
  status: PhaseStatus;
  /** Computed from its steps (§1.5). A gate-only phase has start = end. */ start?: IsoDate | null;
  end?: IsoDate | null;
  /** The phase the project is in now ("you are here"). Exactly one per project once started. */ isCurrent: boolean;
  /** The phase ends on a gate (§1.5 gate_step_id): drawn as a diamond on timelines. */ isGate?: boolean;
};

/** Where a due date comes from. SPEC §1.6 clock + day_offset ("Day 0 + 18 → 9 Dec", §5.4). */
export type DueSource = { clockKey: string; /** "Day 0", "Invoice paid" */ clockLabel: string; offset: number; /** manual date (date_locked) */ locked?: boolean };

/** A file version under review. SPEC §1.7 + §1.8 (round, max_rounds). Shown as "v2 · Round 2 of 3". */
export type Round = { version: number; round: number; maxRounds: number };

/** One step (= task) as a row anywhere: project page, board, My day, approvals. SPEC §1.6. */
export type StepRow = {
  id: string;
  title: string;
  /** The project, for cross-project lists (My day, Approvals, notifications). */ project?: ProjectRef;
  /** §1.6 phase_id, with its name for display. */ phase: { id: string; name: string } | null;
  status: StepStatus;
  /** §1.6 assignee (resolved from the role map); null = no owner yet. */ owner: Person | null;
  /** §1.6 role from the template, e.g. "Video editor". */ role?: string;
  /** §1.6 reviewer_id (team approver). */ reviewer?: Person | null;
  /** §1.6 needs_client_approval. */ needsClientApproval?: boolean;
  /** §1.6 due_at (computed from clock + offset, or manual). Null while its clock is not started. */ due: IsoDate | null;
  /** A due time of day, only where the step has one (My day "5:00 pm"). */ dueAt?: IsoDateTime | null;
  dueSource?: DueSource;
  /** Present only when late (§3.1 flag). */ late?: LateFlag;
  /** Present only while in review or with the client (§1.8). */ round?: Round;
  /** `blocked`: the step it waits on, for the chip 'Waiting on "<step>"' (§3.1). */ blockedBy?: string;
  /** The signed-in person owns this step (row actions show only then; PICKS 02 must-fix). */ mine: boolean;
  /** The signed-in person is its reviewer ("Your turn", §3.1). */ toReview?: boolean;
  /** §1.6 is_gate. */ isGate?: boolean;
  /** §1.6 client_visible. */ clientVisible?: boolean;
};

/** The signed-in person and what they may do on the screen in view. SPEC §4 permissions. */
export type Viewer = {
  person: Person;
  /** Company role (§4 columns). */ orgRole: "owner" | "admin" | "member" | "client";
  /** Leads the project in view (§1.4 lead_id). */ isLead: boolean;
  can: {
    /** Create a project / use templates (§4 row 2). */ createProject: boolean;
    /** Edit role map, clocks, phases (§4 row 3). */ editPlan: boolean;
    /** Change a step's owner or due date (§4 row 4; an assignee only asks). */ changeStepOwnerOrDue: boolean;
    /** Approve as the team when named reviewer (§4 row 6). */ approveTeam: boolean;
    /** Skip a step with a reason (§0.5.2: Owner/Admin/lead). */ skip: boolean;
    /** See money (§4 row 9); always off on PM screens in v1 (§0.5.6). */ seeMoney: boolean;
  };
};

/** Props of every screen: ONE prop, its view model. `screens/<slug>.tsx` default-exports `(props: ScreenProps<VM>)`. */
export type ScreenProps<VM> = { vm: VM };
/** Shape of every `fixtures/<slug>.ts`: named states, the first is the default (`?state=` picks another). */
export type ScreenFixtures<VM> = { states: Record<string, VM> };
