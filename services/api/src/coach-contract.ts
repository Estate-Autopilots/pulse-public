/** R50: the coach.v1 contract (migration 0380). Pulse gives a coach one narrow packet, R49's explanation of one current
 *  staff member against one internal job, and takes back suggestions that each cite items of that packet. A suggestion
 *  is a next step for a person to take, never a decision. The only provider is a deterministic stub: the same packet
 *  always gives the same suggestions, nothing reads keys, calls out or costs money. A real provider later implements
 *  CoachProvider behind the owner's gates (docs/ops/COACH.md); the schemas, citation check and timeout stay. */
import { Ajv2020 } from "ajv/dist/2020.js";

export const COACH_CONTRACT = "coach.v1";
export const KINDS = ["ask_check", "verify", "record_work", "learn"] as const;
export type Kind = typeof KINDS[number];

const skill = { type: "string", minLength: 1, maxLength: 200 } as const;
const level = { type: ["integer", "null"], minimum: 1, maximum: 10 } as const;
/** What a coach may receive, and nothing else: no name or id (the subject is "subject"), no job title or notes, no
 *  verifier, attendance, leave, pay, chats, app activity, contact or private profile fields. */
export const evidenceSchema = {
  $id: "https://pulse.estateautopilots.com/schemas/coach.v1/evidence.json", type: "object", additionalProperties: false,
  required: ["contract", "purpose", "subject", "method", "scale", "evidence"],
  properties: {
    contract: { const: COACH_CONTRACT }, purpose: { const: "internal_job_fit" }, subject: { const: "subject" },
    method: { type: "object", additionalProperties: false, required: ["weightsVersion", "accepted"],
      properties: { weightsVersion: { type: "integer", minimum: 0 }, accepted: { type: "boolean" } } },
    scale: { type: "array", maxItems: 10, items: { type: "string", maxLength: 60 } },
    evidence: { type: "array", maxItems: 50, items: {
      type: "object", additionalProperties: false, required: ["id", "requirement", "outcome", "points", "weight", "record"],
      properties: {
        id: { type: "string", pattern: "^e[0-9]{1,2}$" },
        requirement: { type: "object", additionalProperties: false, required: ["skill", "importance", "minLevel", "recentMonths"],
          properties: { skill, importance: { enum: ["required", "preferred"] }, minLevel: level, recentMonths: { type: ["integer", "null"], minimum: 1, maximum: 240 } } },
        outcome: { enum: ["matched", "unknown", "missing"] }, points: { type: "number", minimum: 0 }, weight: { type: "number", minimum: 0 },
        record: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["skill", "via", "level", "basis", "recent", "lastUsed"],
          properties: { skill, via: { enum: ["same", "alternative", "replaced", "exact", "close"] }, level, basis: { enum: ["verified", "approvedWork", "self"] },
            recent: { type: "boolean" }, lastUsed: { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}$" } } }] },
      } } },
  },
} as const;
/** What a coach may answer: suggestions of four kinds, each citing at least one evidence item. */
export const suggestionsSchema = {
  $id: "https://pulse.estateautopilots.com/schemas/coach.v1/suggestions.json", type: "object", additionalProperties: false,
  required: ["contract", "suggestions"],
  properties: {
    contract: { const: COACH_CONTRACT },
    suggestions: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["kind", "text", "cites"],
      properties: { kind: { enum: KINDS }, text: { type: "string", minLength: 3, maxLength: 300 },
        cites: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^e[0-9]{1,2}$" } } } } },
  },
} as const;
/** What a reviewer sends to ask: these fields only. Evidence is never taken from the caller; Pulse builds it. */
export const REQUEST_FIELDS = ["jobId", "personId", "purpose"] as const;

export type Evidence = { contract: string; purpose: string; subject: string; method: { weightsVersion: number; accepted: boolean }; scale: string[];
  evidence: { id: string; requirement: { skill: string; importance: "required" | "preferred"; minLevel: number | null; recentMonths: number | null };
    outcome: "matched" | "unknown" | "missing"; points: number; weight: number;
    record: { skill: string; via: string; level: number; basis: "verified" | "approvedWork" | "self"; recent: boolean; lastUsed: string | null } | null }[] };
export type Suggestion = { kind: Kind; text: string; cites: string[] };
export type Failure = "schema" | "citation" | "too_many" | "identifier" | "error";
export interface CoachProvider { readonly name: "stub"; readonly version: string; suggest(packet: Evidence, o: { signal: AbortSignal; max: number }): Promise<unknown> }

const ajv = new Ajv2020({ allErrors: true, strict: false });
const evidenceValid = ajv.compile(evidenceSchema), suggestionsValid = ajv.compile(suggestionsSchema);
const IDENTIFIER = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;

/** The packet passes the schema and carries no id or e-mail address (the database checks the same, coach_evidence_ok). */
export function checkEvidence(packet: unknown): { ok: true; packet: Evidence } | { ok: false; failure: "schema" | "identifier" } {
  if (!evidenceValid(packet)) return { ok: false, failure: "schema" };
  if (IDENTIFIER.test(JSON.stringify(packet))) return { ok: false, failure: "identifier" };
  return { ok: true, packet: packet as unknown as Evidence };
}

/** A coach's answer passes the schema, stays within the company's number, cites only this packet's evidence and
 *  repeats no id or e-mail address. Anything else is a failure; the answer is not kept. */
export function checkSuggestions(packet: Evidence, answer: unknown, max: number): { ok: true; suggestions: Suggestion[] } | { ok: false; failure: Exclude<Failure, "error"> } {
  if (!suggestionsValid(answer)) return { ok: false, failure: "schema" };
  const suggestions = (answer as { suggestions: Suggestion[] }).suggestions;
  if (suggestions.length > max) return { ok: false, failure: "too_many" };
  const ids = new Set(packet.evidence.map((e) => e.id));
  if (suggestions.some((s) => s.cites.some((c) => !ids.has(c)))) return { ok: false, failure: "citation" };
  if (IDENTIFIER.test(JSON.stringify(suggestions))) return { ok: false, failure: "identifier" };
  return { ok: true, suggestions: suggestions.map((s) => ({ kind: s.kind, text: s.text.trim(), cites: s.cites })) };
}

const levelName = (packet: Evidence, n: number | null) => n === null ? "" : packet.scale[n - 1] ?? `level ${n}`;
/** Pulse's deterministic stub: one next step per requirement that needs one, required first, in the packet's order. */
export const stubProvider: CoachProvider = {
  name: "stub", version: "stub-1",
  async suggest(packet, { max }) {
    const out: Suggestion[] = [];
    for (const e of packet.evidence) {
      const what = `"${e.requirement.skill}" (${e.requirement.importance})`, r = e.record;
      if (e.outcome === "unknown") out.push({ kind: "ask_check", text: `Nothing on record for ${what}: ask them to check their Skills & CV.`, cites: [e.id] });
      else if (e.outcome === "missing" && r) out.push({ kind: "ask_check", text: `${what} is on record at ${levelName(packet, r.level)}, below the ${levelName(packet, e.requirement.minLevel)} asked: ask them whether it is current, or plan a learning step.`, cites: [e.id] });
      else if (r && r.basis !== "verified") out.push({ kind: "verify", text: `${what} is self-assessed${r.basis === "approvedWork" ? " with approved work" : ""}: their manager, pod head or HR could verify it.`, cites: [e.id] });
      else if (r && !r.recent) out.push({ kind: "record_work", text: `${what} was last used ${r.lastUsed ?? "a while ago"}: recent work with it would bring the record up to date.`, cites: [e.id] });
    }
    return { contract: COACH_CONTRACT, suggestions: out.slice(0, max) };
  },
};
/** Providers by the name in coach_config.provider. Only the stub exists (E08, E16). */
export const PROVIDERS: Record<string, CoachProvider> = { stub: stubProvider };

export type Outcome = { status: "answered"; suggestions: Suggestion[]; version: string; latencyMs: number }
  | { status: "timed_out"; version: string; latencyMs: number }
  | { status: "failed"; failure: Failure; version: string; latencyMs: number };
const TIMEOUT = Symbol("timeout");
/** Ask a provider with the company's timeout. A late, broken or uncited answer ends as timed out or failed: the reviewer
 *  then reads R49's explanation without suggestions. A provider's words are never kept on failure. */
export async function askCoach(provider: CoachProvider, packet: Evidence, { timeoutMs, max }: { timeoutMs: number; max: number }): Promise<Outcome> {
  const started = performance.now(), abort = new AbortController(), version = provider.version;
  const latency = () => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => { resolve(TIMEOUT); abort.abort(); }, timeoutMs); });
  try {
    const answer = await Promise.race([provider.suggest(packet, { signal: abort.signal, max }), late]);
    if (answer === TIMEOUT) return { status: "timed_out", version, latencyMs: latency() };
    const checked = checkSuggestions(packet, answer, max);
    return checked.ok ? { status: "answered", suggestions: checked.suggestions, version, latencyMs: latency() } : { status: "failed", failure: checked.failure, version, latencyMs: latency() };
  } catch {
    return { status: "failed", failure: "error", version, latencyMs: latency() };
  } finally { clearTimeout(timer); }
}

/** Off unless the server sets PULSE_COACH=1; each company also turns it on (coach_config). */
export const coachServerOn = () => process.env.PULSE_COACH === "1";

/** What must happen before a real coach: owner errands and work, none done in R50 (docs/ops/COACH.md). */
export const ACTIVATION_GATES = [
  { id: "E16", what: "Owner approval of a coach provider, its model and a monthly budget ceiling (and HR's acceptance of the R49 weights the packet is built from)", status: "open" },
  { id: "E08", what: "Privacy notice and Indian legal/HR review for sending skill evidence to an outside processor, including international transfer and retention", status: "open" },
  { id: "provider-terms", what: "Signed processor terms: no training on submitted data, retention of at most 30 days, region and deletion on request", status: "open" },
  { id: "build", what: "A later round adds the provider (migration, ADR, LLM gateway with per-company budget caps), the person's view of suggestions about them and the staff notice", status: "open" },
] as const;
