// Types for @pulse/companion (the implementation is plain ESM so desktop and Chrome can load it without a build).

export type CompanionState = 'out' | 'in' | 'break' | 'done' | 'leave' | 'holiday' | 'off';
export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'new-message' | 'happy' | 'concerned' | 'sleeping' | 'waking' | 'in' | 'break' | 'done' | 'celebrate' | 'sleepy';
export type ActionId = 'check-in' | 'break-start' | 'break-end' | 'check-out';
export type Mode = 'office' | 'wfh' | 'field';

export type CompanionEntry = { id: string | null; date: string; in: string; out: string | null; mode: string; late: number; onBreak: boolean; breakStartedAt: string | null; closedBreakSeconds: number; synced?: string | null;
  /** ATT: "auto" when Pulse checked in or out by itself (with why it checked out), "answer" when the person's one tap did. */
  inVia?: string | null; outVia?: string | null; outReason?: string | null;
  /** POLISH-1: the person sent the time they left for this open session (a correction waiting for approval). */
  correctionPending?: boolean };
export type Office = { id: string; name: string; lat: number; lng: number; radius: number; wifi: { ssid: string; bssids: string[] }[] };
export type Site = { id: string; name: string; lat: number; lng: number; radius: number; precision: 'exact' | 'building' };
export type CompanionPayload = {
  demo?: boolean; pending?: boolean; attendanceEnabled?: boolean;
  person: { id: string; name: string; firstName: string };
  now: string; today: string; clock: string; timezone: string; utcOffsetMinutes: number;
  shift: { start: string; end: string; graceMinutes: number; onTimeBy: string; workingDay: boolean; mode: string };
  shiftStartsAt: string; shiftEndsAt: string;
  state: CompanionState; holiday: string | null; entry: CompanionEntry | null;
  nextShift: { date: string; start: string; startsAt: string } | null;
  upcoming?: { date: string; start: string; startsAt: string }[];
  streak: { onTime: number; firstCheckIn: boolean };
  waiting: { count: number; href: string } | null;
  presence: { dwellMinutes?:number; leaveMinutes?:number; autoCheckIn: boolean; /** ATT: Pulse checks out by itself when someone leaves. */ autoCheckOut?: boolean; offices: Office[]; sites: Site[] };
  /** PRESENCE-ONBOARD: Pulse noticed the person at an office and asked "Check in?" (until they answer). */
  arrival?: { at: string; office: string | null } | null;
  /** POLISH-2: a session Pulse closed for review because nobody checked out (the time they left is still to send). */
  unresolved?: { entryId: string; date: string; in: string; proposedEnd: string; reason: string; correctionPending: boolean } | null;
  /** ATT: Pulse's one question about the open session (the signals conflict), until it is answered. */
  question?: { entryId: string; kind: 'left' | 'left_early'; leftAt: string; askedAt: string; office: string | null } | null;
  /** This week's working days so far: on time, late, missed or not a working day. */
  week?: { onTime: number; late: number; missed: number; days: { date: string; state: 'on_time' | 'late' | 'missed' | 'off' | 'today' }[] } | null;
};

export type View = {
  state: CompanionState | 'loading' | 'disabled'; mood: Mood; title: string; subtitle: string; greeting: string;
  timer: { seconds: number; display: string; label: string; running: boolean } | null;
  chip: { tone: 'success' | 'warning' | 'info' | 'neutral'; text: string };
  actions: { id: ActionId; label: string; primary: boolean }[];
  showModes: boolean; footer: string; next: string | null; waiting: { count: number; label: string; href: string } | null; late: number; pending?: boolean;
};

export const MOODS: Mood[];
export const ACTIONS: ActionId[];
export const MODES: Record<Mode, string>;
export function clockOffset(payload: CompanionPayload | null, localNow?: number): number;
export function liveSeconds(entry: CompanionEntry | null, at: number): { worked: number; onBreak: number; breakTotal: number };
export function actionRequest(action: ActionId, extra?: Record<string, unknown>): { path: string; body: Record<string, unknown> };
export function allowedActions(state: CompanionState, attendanceEnabled?: boolean): ActionId[];
export function applyLocal(payload: CompanionPayload, action: ActionId, at: number, extra?: Record<string, unknown>): CompanionPayload;
export function celebration(payload: CompanionPayload | null): string | null;
export function deriveView(payload: CompanionPayload | null, at?: number, options?: { celebrate?: boolean }): View;
export function badge(payload: CompanionPayload | null, at?: number): { text: string; tone: string; title: string };

export function stopwatch(seconds: number): string;
export function duration(seconds: number): string;
export function wallMinutes(at: number, offsetMinutes: number): number;
export function shortDay(date: string): string;
export function addClock(hhmm: string, minutes: number): string;
export function friendlyClock(hhmm: string): string;

export type Prefs = { checkIn: boolean; breakBack: boolean; checkOut: boolean; breakMinutes: number; popAtStart: boolean; mascot: boolean; autoStart: boolean; autoCheckIn: boolean; presence: boolean };
export type Reminder = { id: string; kind: 'check-in' | 'break-back' | 'check-out'; action: ActionId; title: string; body: string; at?: number };
export const DEFAULT_PREFS: Readonly<Prefs>;
export function prefsWith(saved: Partial<Prefs> | null | undefined): Prefs;
export function dueReminders(payload: CompanionPayload | null, prefs: Partial<Prefs>, at: number, shown?: Iterable<string>): Reminder[];
export function reminderPlan(payload: CompanionPayload | null, prefs: Partial<Prefs>, at: number, days?: number): (Reminder & { at: number })[];
export function shouldPopUp(payload: CompanionPayload | null, prefs: Partial<Prefs>, at: number, shown?: Iterable<string>): string | null;

export type Region = { id: string; kind: 'office' | 'site'; placeId: string; name: string; lat: number; lng: number; radius: number; distance?: number; strength?: 'strong' | 'weak'; via?: 'wifi' };
export type PresenceSignal = { trigger: 'enter' | 'exit' | 'wifi' | 'open'; place: Region };
export type PresenceDecision = { kind: 'none' | 'suggest-check-in' | 'auto-check-in' | 'suggest-leave'; reason?: string; key?: string; placeId?: string; mode?: Mode; title?: string; body?: string; actions?: ActionId[] };
export const WEAK_GPS_METERS: number;
export const REPEAT_MINUTES: number;
export const IOS_REGION_LIMIT: number;
export const ANDROID_REGION_LIMIT: number;
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number;
export function regionsToMonitor(presence: CompanionPayload['presence'] | null | undefined, limit?: number): Region[];
export function placeAt(coords: { lat: number; lng: number; accuracy: number } | null, presence: CompanionPayload['presence'] | null | undefined): { place: Region | null; reason: string };
export function wifiMatch(wifi: { ssid?: string | null; bssid?: string | null } | null, presence: CompanionPayload['presence'] | null | undefined): Region | null;
export function decidePresence(input: { signal: PresenceSignal | null; payload: CompanionPayload | null; prefs: Partial<Prefs>; at: number; recent?: { key: string; at: number }[] }): PresenceDecision;
export function presenceBody(decision: PresenceDecision, signal: PresenceSignal, auto?: boolean): Record<string, unknown>;

export type QueueItem = { id: string; action: ActionId; at: number; body: Record<string, unknown>; tries: number };
export const QUEUE_LIMIT: number;
export const QUEUE_MAX_AGE_MS: number;
export function enqueue(queue: QueueItem[] | null | undefined, action: ActionId, at: number, body?: Record<string, unknown>, id?: string): QueueItem[];
export function prune(queue: QueueItem[] | null | undefined, at: number): { keep: QueueItem[]; expired: QueueItem[] };
export function queuedRequest(item: QueueItem): { action: ActionId; extra: Record<string, unknown> };
export function settle(queue: QueueItem[] | null | undefined, id: string, outcome: 'ok' | 'rejected' | 'retry'): QueueItem[];
export function outcomeOf(error: unknown): 'ok' | 'rejected' | 'retry';
export function projected(payload: CompanionPayload, queue: QueueItem[] | null | undefined): CompanionPayload;

export type Tokens = { accessToken: string; refreshToken: string; deviceId: string; person?: { id: string; name: string } | null };
export type TokenStore = { get(): Promise<Tokens | null>; set(tokens: Tokens): Promise<void>; clear(): Promise<void> };
export const DEFAULT_BASE: string;
export class GateError extends Error { gate: true }
export class OfflineError extends Error { offline: true }
export class ApiError extends Error { status: number; signedOut?: boolean; retryAfter?: number; constructor(status: number, message: string) }
export function verifyUrl(base: string, code: string, expectedPerson?: string): string;
export function checkBase(base: string): string;
export type CompanionClient = {
  base: string;
  call<T = any>(path: string, body?: unknown, options?: { auth?: boolean }): Promise<T>;
  companion(): Promise<CompanionPayload>;
  act(action: ActionId, extra?: Record<string, unknown>): Promise<unknown>;
  pairStart(platform: string, name: string): Promise<{ pairId: string; pollSecret: string; code: string; expiresIn: number; interval: number }>;
  pairPoll(pairId: string, pollSecret: string): Promise<{ status: 'pending' | 'approved' | 'denied' | 'expired'; person: { id: string; name: string } | null; deviceId: string | null }>;
  signOut(): Promise<void>;
};
export function createClient(options: { base?: string; fetchImpl?: typeof fetch; store: TokenStore; client?: string; credentials?: RequestCredentials; timeoutMs?: number }): CompanionClient;

export const PIP_MOODS: Mood[];
export const PIP_LABELS: Record<Mood, string>;
export const PIP_BULB: Record<Mood, string>;
export const PIP_COLORS: Record<'light' | 'dark', Record<string, string>>;
export const PIP_PATHS: { body: { cx: number; cy: number; r: number }; arcs: string[]; shine: string; eyesOpen: [number, number][]; eyesHappy: string[]; eyesClosed: string[]; brows: string[]; star: string; cup: string; cupHandle: string; steam: string[]; z: string; confetti: [number, number, string][] };
export function pipFace(mood: Mood): { eyes: 'open' | 'happy' | 'closed' | 'star'; mouth: 'smile' | 'grin' | 'o' | 'flat' | 'wobble' | 'none'; cheeks: boolean; brows: boolean; cup: boolean; zzz: boolean; confetti: boolean; wave: boolean; dots: boolean; rings: boolean; bulb: string };
export function pipSvg(options?: { mood?: Mood; size?: number; label?: string; still?: boolean; uid?: string }): string;
export function pipStaticSvg(options?: { mood?: Mood; theme?: 'light' | 'dark'; size?: number; blink?: boolean }): string;

export function demoPayload(state?: CompanionState, at?: number, options?: { first?: boolean; onTime?: number; waiting?: number; late?: number }): CompanionPayload;
export function demoClient(initial?: CompanionState): Pick<CompanionClient, 'companion' | 'act' | 'signOut'> & { demo: true };
export type SurfaceState = {state:string; title:string; active:boolean; actions:{id:ActionId;label:string}[]; seconds:number; timerSince:number|null; mood:Mood; pending:boolean};
export function surfaceState(payload:CompanionPayload|null, at?:number):SurfaceState;
export type PresenceEvidence = {region?:{inside:boolean;at:number};wifi?:{strength:'strong'|'weak'|null;at:number};ip?:{matched:boolean;at:number}};
export function triangulate(signals:PresenceEvidence, at?:number):{score:number;confident:boolean;holding:boolean;signals:{region:boolean;wifi:string|null;ip:boolean}};
export function dwellDecision(input:{signals:PresenceEvidence;previous?:{since?:number|null;lastPresence?:number|null;leftAt?:number|null};at:number;dwellMinutes?:number;leaveMinutes?:number;consent:boolean;autoConsent:boolean;hrAuto:boolean;workingDay:boolean;state:string}):{kind:string;score:number;since:number|null;lastPresence:number|null;leftAt:number|null};
