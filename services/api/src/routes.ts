import { ORG_TZ, zoneTime } from './org-time.js';
import { registerAccountSecurity } from './account-security.js';
import type { GoogleConfiguration } from './google-sign-in-flow.js';
import { registerFinanceDeskRoutes } from './finance-desk-routes.js';
import { registerFinanceEntryRoutes } from './finance-entry.js';
import {registerNativeRoutes} from './native.js';
import { registerAgentAdminRoutes, registerAgentRoutes } from './agents.js';
import { registerAgentTaskRoutes } from './agent-tasks.js';
import { registerAgentHistoryRoutes } from './agent-history.js';
import { registerConnectAiRoutes } from './connect-ai.js';
import { registerV1 } from './v1.js';
import './v1-people.js';
import { registerOAuth } from './oauth.js';
import { registerCompanionInboxRoutes } from './companion-inbox.js';
import { registerNoticeRoutes } from './notices.js';
import { registerCompanionRoutes } from './companion.js';
import { registerAttendanceExceptionRoutes } from './attendance-exceptions.js';
import {registerFairWorkRoutes} from './fair-work-routes.js';
import {registerWhatsAppIngress} from './whatsapp-ingress.js';
import { registerAcquisitionRoutes } from './acquisition-routes.js';
import { registerPortalRoutes } from "./portal-routes.js";
import { registerDeliveryRoutes } from "./delivery-routes.js";
import { registerDeliveryClaimRoutes } from "./delivery-claims.js";
import { registerDesignClaimRoutes } from "./design-claims.js";
import { registerAccountClaimRoutes } from "./account-claims.js";
import { registerPulseAppRoutes } from './pulse-app.js';
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { registerInvitationRoutes } from "./invitations.js";
import { registerTeamSetupRoutes } from "./team-setup.js";
import { registerDeviceSignIn } from "./device-signin.js";
import { registerRecordRoutes } from "./records.js";
import { registerHrRoutes } from "./hr.js";
import { registerSelfHistoryRoutes } from "./self-history.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerBillingSetupRoutes } from "./billing-setup.js";
import { registerBrandRoutes } from "./brand.js";
import { registerMailboxRoutes } from "./mailbox.js";
import { brandAssetForDeliverableType, BRAND_ASSET_DELIVERABLE_TYPES, BRAND_ASSET_TYPES,
  classifyDesignType, classifyEditorCreativeType, DESIGN_DELIVERY_TYPES, EDITOR_CREATIVE_TYPES,
  type DesignDeliveryType, isDesignExport, loadDesignerTargets, loadEditorTargets,
  countedWorkdays, designerTargetForRole, singleImageExpectation } from "./editor-targets.js";
import { registerContactIdentityRoutes } from "./contact-identity.js";
import { registerBriefRoutes } from "./briefs.js";
import { registerClientMasterRoutes } from "./client-master.js";
import { registerIntelligenceRoutes } from "./intelligence.js";
import { registerInsightRoutes } from "./insights.js";
import { registerCompanyRoutes } from "./company.js";
import { registerPolicyWordRoutes } from "./policy-word.js";
import { registerDriveChangesRoutes } from "./drive-changes.js";
import { registerConnectorRoutes } from "./connectors.js";
import { registerDriveTextRoutes } from "./drive-text.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerTaskLifeRoutes } from "./task-life.js";
import { registerTaskCompanionRoutes } from "./task-companion.js";
import { registerOrgRoutes } from "./org.js";
import { registerPoolProposalRoutes } from "./pool-proposals.js";
import { registerSopRoutes } from "./sops.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { registerWorkflowBoardRoutes } from "./workflow-boards.js";
import { registerFormRoutes } from "./forms.js";
import { registerTaskFocusRoutes } from "./task-focus.js";
import { registerWorkRoutes } from "./work.js";
import { registerWorkDomainRoutes } from "./work-domains.js";
import { registerWorkScorecardRoutes } from "./work-scorecard.js";
import { registerProjectHealthRoutes, registerProjectQuoteRoutes, registerProjectRunRoutes } from "./project-health.js";
import { registerProjectPlanRoutes } from "./project-plan.js";
import { registerProjectShareRoutes } from "./project-share.js";
import { registerWorkViewRoutes } from "./work-views.js";
import { orgVocabulary, workLabels } from "./work-model.js";
import { registerPeopleWork } from "./people-work.js";
import { filesReady, gateFree, gateOpen, registerPresenceOnboardRoutes } from "./presence-onboard.js";
import { registerPeopleInfoRoutes } from "./people-info.js";
import { registerSkillRoutes } from "./skills.js";
import { registerAtsRoutes } from "./ats.js";
import { registerCoachRoutes } from "./coach.js";
import { registerLifecycleRoutes } from "./lifecycle.js";
import { registerPeopleValueRoutes } from "./people-value.js";
import { registerMyPulseRoutes } from "./my-pulse.js";
import { registerSearchRoutes } from "./search.js";
import { registerNetworkRoutes } from "./network.js";
import { registerLicenceRoutes } from "./licences.js";
import { registerPulseHqRoutes } from "./pulse-hq.js";
import { registerPlatformAdminRoutes } from "./platform-admin.js";
import { registerStackRoutes } from "./stack-intel.js";
import { registerStoryRoutes } from "./story.js";
import { registerProductMapRoutes } from "./product-map.js";
import { registerReviewGroups } from "./review-groups.js";
import { registerGroupRoutes } from "./groups.js";
import { registerGroupsHubRoutes } from "./groups-hub.js";
import { registerResearchRoutes } from "./research.js";
import { registerPerformanceRoutes } from "./performance.js";
import { noteViewer, registerTelemetryRoutes } from "./telemetry.js";
import { registerBugReportRoutes } from "./bug-reports.js";
import { registerRequestsBoardRoutes } from "./requests-board.js";
import { registerChatRoutes } from "./chats.js";
import { registerGroupAccessRoutes } from "./group-access.js";
import { registerChatIntentRoutes } from './chat-intent.js';
import { registerChatVoiceRoutes } from "./chat-voice.js";
import { registerCallRoutes } from "./calls.js";
import { registerChatWorkRoutes } from "./chat-work.js";
import { registerChatImportRoutes } from "./chat-import.js";
import { registerWaChatRoutes } from "./wa-chats.js";
import { registerWaKnowledgeRoutes } from "./wa-knowledge.js";
import { registerWaAudioReviewRoutes } from "./wa-audio-review.js";
import { registerOpsInsightRoutes } from "./ops-insights.js";
import { registerWaIntelRoutes } from "./wa-intel.js";
import { registerReportRoutes } from "./reports.js";
import { registerInsightCardRoutes } from "./insight-cards.js";
import { registerMapRoutes } from "./map.js";
import { registerErpRoutes } from "./erp.js";
import { registerQuoteFollowupRoutes } from "./quote-followups.js";
import { registerServiceNotice } from './service-notice.js';
import { registerUpdates } from './updates.js';
import { registerUpdateRequests } from './update-requests.js';
import { registerCompRoutes } from "./comp.js";
import { registerPayrollRoutes } from "./payroll.js";
import { registerPeopleCostRoutes } from "./people-cost.js";
import { registerTalentRoutes } from "./talent.js";
import { registerRelationshipRoutes } from "./relationships.js";
import { invalidateOnWrite, ResponseCache, syncVersion } from "./response-cache.js";
import { MODULES_RESPONSE_SCHEMA, moduleForRoute, moduleOff, readModules } from "./modules.js";
import type { Installation } from "./installation.js";
import { folderRulesSummary, type FolderRuleDocument } from "./folder-rules.js";
import { attendanceEnabled } from "./attendance-policy.js";
import { accessHeaderAllowed, hostCompany } from "./tenant-context.js";
import { moduleForPath, MODULE_OFF } from "./tenant-model.js";
import { registerTenantRoutes } from "./tenants.js";
import { registerScreenRoutes, viewerHiddenScreens, viewerHome } from "./screens.js";
import { registerCreativeRoutes } from "./creative.js";
import { registerSalesHomeRoutes } from "./sales-home.js";
import { registerSalesXrayRoutes } from "./sales-xray.js";
import { registerSalesXraySyncRoutes } from "./sales-xray-sync.js";
import { registerOidcRoutes } from "./oidc.js";
import { registerConnectApi } from "./connect-api.js";
import { registerSiteVisitSettings } from "./site-visit-settings.js";
import { registerSiteVisits } from "./site-visits.js";
import { registerChatNames } from "./chat-names.js";
import { registerAccountRoutes } from "./accounts.js";
import { registerConnectRoutes } from "./connect.js";
import { registerClientPortalRoutes } from "./client-portal.js";
import { registerClientSignIn } from "./client-signin.js";
import { registerClientSpaceRoutes } from "./client-space.js";
import { SCREENS } from "./screens.js";
import { registerFlowRoutes } from "./flow/routes.js";
import { registerFlowSetupRoutes, roleScreens } from "./flow/setup.js";
import { registerFlowAppRoutes } from "./flow/apps.js";
import { wordsOf } from "./flow/packs.js";

export const normalizedOrgName = (name: unknown): string => String(name ?? "").trim() || "Pulse";
export type Viewer = { email: string; org: string; person: string | null; role: string; name: string; pod: string | null; via: "access" | "password"; username: string | null; mustChange: boolean; nativeDevice?:string;
  /** ORG: the person's side in this organisation (staff, freelancer, client, …); a client sees only their shared work. */ side?: string;
  /** VISIBLE: someone in HR who also holds leadership (one role is picked, HR first); they keep HR's and get leadership's. */ lead?: boolean };
class HttpError extends Error { constructor(public statusCode: number, message: string, public publicCode?: string) { super(message); } }
export const fail = (code: number, text: string): never => { throw new HttpError(code, text); };
/** A refusal that also names a machine-readable reason ({ error, code }), e.g. profile_incomplete. */
export const failCode = (code: number, text: string, reason: string): never => { throw new HttpError(code, text, reason); };

export const admin = (v: Viewer) => v.role === "admin";
export const leadership = (v: Viewer) => admin(v) || v.role === "leadership" || !!v.lead;
export const manager = (v: Viewer) => ["manager","pgs"].includes(v.role);
export const hr = (v: Viewer) => leadership(v) || v.role === "hr";
/** Client, project and pipeline work (clients, contacts, projects, map, my week, editors, research, creative ...): an
 *  HR-only account is refused, as the HR navigation says ("never clients, money or admin"; tests/core role matrix). */
export const work = (v: Viewer) => { if (v.role === "hr" && !v.lead) fail(403, "This account has HR access only"); };
/** Owner, 21 Oct 2026: HR works on tasks and the Work (delivery) views too (Azavez: HR desk plus Work and Tasks). Tasks
 *  routes never called work(); the delivery views use this one, so 959a7f8c no longer opens every client route to HR. */
export const deliveryWork = (v: Viewer) => void v;
const explained = (value: number, ruleKeys: string[], detail: string, ids: string[] = []) => ({ value, why: {
  rule: ruleKeys[0] ?? null, ruleKeys, detail, source: "deliveries_read_model", sampleFileIds: ids.slice(0, 5),
} });
const deliveryAttributionJoin = `
  left join pulse.account ea_account on ea_account.org_id=d.org_id
    and ea_account.provider='google' and ea_account.handle=d.uploader_account
  left join lateral (
    select a.method,a.person_id,a.evidence from pulse.file source_file
    join pulse.version version on version.file_id=source_file.id
    join pulse.attribution a on a.version_id=version.id and a.resolver_version='delivery-attribution/v1'
    where source_file.org_id=d.org_id and source_file.store='gdrive' and source_file.store_id=d.file_id
    order by a.event_time desc,a.event_seq desc limit 1
  ) delivery_attribution on true`;
const creditedTo = `case
  when delivery_attribution.method in ('evidence','declared','individual_account','device','manual')
    and delivery_attribution.person_id is not null then delivery_attribution.person_id::text
  when coalesce(ea_account.is_shared,false) then 'shared login'
  else 'unresolved' end`;
const attributionHow = `case
  when delivery_attribution.method in ('evidence','declared','individual_account','device','manual')
    and delivery_attribution.person_id is not null then (
      select evidence.item->>'how'
      from jsonb_array_elements(coalesce(delivery_attribution.evidence,'[]'::jsonb)) with ordinality
        as evidence(item, position)
      where evidence.item ? 'how' order by evidence.position desc limit 1)
  when coalesce(ea_account.is_shared,false) then 'shared'
  else null end`;

export type Tx = <T>(request: FastifyRequest, run: (c: PoolClient, v: Viewer) => Promise<T>) => Promise<T>;
export type Open = <T>(run: (c: PoolClient, org: string) => Promise<T>) => Promise<T>;
export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function registerRoutes(app: FastifyInstance, pool: Pool, installation: Installation, google?: GoogleConfiguration) {
  // Expensive read-only views are kept per viewer until their data version moves or a write goes through this API.
  const cache = new ResponseCache();
  invalidateOnWrite(app, cache);
  /** A transaction with the tenant set and no viewer: sign-in and "forgot password" only. */
  const open: Open = async run => {
    // UX-TENANT: the company whose address the request came in on; an unclaimed address is the install's own company.
    const installed = await installation.readOrg();
    if (installed === null) throw new HttpError(503, "not_initialised");
    const org = hostCompany()?.org ?? installed;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('pulse.org_id',$1,true)", [org]);
      const result = await run(c, org);
      await c.query("commit");
      return result;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  // A switched-off module's routes answer exactly like a route that does not exist, before sign-in or any body is read.
  app.addHook("onRequest", async (request, reply) => {
    const key = moduleForRoute(request.routeOptions.url);
    if (key && moduleOff(await open(readModules), key)) return reply.callNotFound();
  });
  /** The viewer is the Access identity (company e-mail) or, without one, a Pulse username session. */
  const tx: Tx = (request, run) => open(async (c, org) => {
    // EST-1035: an AI co-worker's key opens /api/v0/agent/* only (agents.ts); here it never stands in for a person.
    if (request.headers['x-pulse-agent-key'] !== undefined) fail(401, 'An AI co-worker key works on its own routes only');
    const bearer=request.headers.authorization;
    let nativeDevice:string|undefined;
    let nativePerson:string|undefined;
    if(bearer!==undefined){
      if(typeof bearer!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))fail(401,'Invalid device credential');
      // Device tokens carry narrow employee scope even when the employee is an administrator.
      // CALLS-NATIVE: the phone's ring screen asks whether a call still rings for this person, and declines it.
      if(!/^\/api\/v0\/(me(?:\?|$)|companion(?:\/(?:presence|inbox|updates|read|ack|snooze|notification-settings|wallet|late-dispute))?(?:\?|$)|my-week(?:\?|$)|intelligence(?:\?|$)|delivery(?:\?|$)|tasks(?:\?|$)|chats(?:\/events|\/direct|\/[0-9a-f-]{36}\/(messages|read))?(?:\?|$)|people(?:\/|\?|$)|projects(?:\/|\?|$)|hr\/(self|tickets)(?:\?|$)|attendance\/(check-in|check-out|break)$|leave(?:\?|$)|devices(?:\/|\?|$)|calls\/[0-9a-f-]{36}\/(?:ring|decline)$|events\/today(?:\?|$)|sensing\/|native\/(batches$|web-session$|notifications\/[0-9a-f-]{36}\/open$)|feedback$|fair-work(?:\?|$))/.test(request.url))fail(403,'Device scope excludes this endpoint');
      const binding=(await c.query('select * from pulse.native_token_resolve($1)',[sessionHash(bearer.slice(7))])).rows[0];
      if(!binding)fail(401,'Device credential expired or revoked');nativeDevice=binding.device_id;nativePerson=binding.person_id;
    }
    const raw = nativeDevice || !accessHeaderAllowed(hostCompany(), process.env.PULSE_PUBLIC_LOGIN_ENABLED === "1") ? undefined :request.headers["cf-access-authenticated-user-email"];
    // DE-EA (ADR-0031): roles come from the database only; no address is an admin or HR by its spelling.
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const token = request.headers["x-pulse-session"];
    const profile = `p.id person,p.display_name name,p.status,p.side,pp.pod,pp.username,pp.accounts,pulse.is_accountant(p.id) accountant,
      coalesce((select array_agg(case when r.is_manager_of_unit then 'manager' else r.role_key end) from pulse.role_assignment r where r.person_id=p.id
        and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'{}') roles`;
    let user: { side?: string | null; via?: string; person: string | null; name: string | null; status: string | null; pod: string | null; username: string | null; accounts: string[] | null; roles: string[] | null; accountant?: boolean; mustChange?: boolean } | undefined;
    let via: Viewer["via"] = "access";
    if(nativePerson){
      user=(await c.query(`select ${profile} from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`,[nativePerson])).rows[0];via='password';
    } else if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(401, "Sign in through your company's Access");
      user = (await c.query(`select ${profile} from pulse.account a left join pulse.person p on p.id=a.holder_person_id
        left join pulse.people_profile pp on pp.person_id=p.id
        where a.provider='google' and a.handle=$1 and a.purpose like 'Workspace%'`, [email])).rows[0];
    } else if (typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      user = (await c.query(`select ${profile},s.via from pulse.login_session s join pulse.person p on p.id=s.person_id
        join pulse.people_profile pp on pp.person_id=p.id
        where s.token_hash=$1 and s.revoked_at is null and s.expires_at > now()`, [sessionHash(token)])).rows[0];
      if (!user) fail(401, "Your session has ended. Sign in again.");
      // The credential row is visible to its own person only, so the viewer is set before it is read.
      await c.query("select set_config('pulse.viewer_id',$1,true)", [user!.person]);
      const login = (await c.query("select must_change from pulse.login_credential where person_id=$1 and status='active'", [user!.person])).rows[0];
      // ORG (0920): a session minted by a Pulse account switch needs no password of this organisation's own.
      if (!login && user!.via !== "account") fail(401, "Your session has ended. Sign in again.");
      user!.mustChange = login?.must_change ?? false;
      via = "password";
    } else fail(401, "Sign in to Pulse");
    if (!user || (user.status && user.status !== "active")) fail(403, "This account is not active in this company's Pulse");
    const roles = user!.roles ?? [];
    const role = user!.accountant ? "accountant" : roles.includes("admin") ? "admin" : roles.includes("hr") ? "hr" : roles.includes("leadership") ? "leadership" : roles.includes("finance") ? "finance" : roles.includes("manager") ? "manager" : roles.some(r=>["pgs","head_pgs"].includes(r)) ? "pgs" : "person";
    // Deliveries are matched by uploader account: the Access e-mail, or the first account linked to the person.
    const account = email || user!.accounts?.[0] || `pulse:${user!.username}`;
    const v: Viewer = { email: account, org, person: user!.person, role, name: user!.name ?? email, pod: user!.pod, via, username: user!.username, mustChange: !!user!.mustChange, ...(nativeDevice?{nativeDevice}:{}), side: user!.side ?? undefined,
      ...(role === "hr" && roles.includes("leadership") ? { lead: true } : {}) };
    noteViewer(v);
    // ORG: a client of this organisation works on what is shared with them: their tasks, chats and their own account.
    // SIM-CLIENTS: and calls in the groups shared with them (chat_call_* checks membership; a connection seat is rung).
    // CLIENT-PORTAL: also their space (/client-portal) and calls in the conversations they are in (the database rings members only).
    if (v.side === 'client' && !/^\/api\/v0\/(me|account|auth|tasks|task-|chats|notices|updates|notifications|inbox|companion\/inbox|brand|host|client-portal|calls)(\/|\?|$)/.test(request.url)
      && !(v.person && request.url.split('?')[0] === `/api/v0/people/${v.person}`) && !/^\/api\/v0\/people\/[0-9a-f-]{36}\/carried$/.test(request.url.split('?')[0]))
      fail(403, 'As a client of this organisation you see the work shared with you: your tasks and chats');
    await c.query("select set_config('pulse.viewer_id',$1,true)", [v.person ?? ""]);
    await c.query("select set_config('pulse.actor_account',$1,true)", [v.email]);
    if (v.role === 'accountant') {
      const path = request.url.split('?')[0];
      const self = ['/api/v0/me','/api/v0/auth/account','/api/v0/auth/change-password','/api/v0/auth/logout'].includes(path);
      // ERP-INVOICE: the Accountant also reads invoices, the catalog and the exports (never writes).
      // COMP-A: and the month's pay total (no person: comp_month_sealed hides who; the route returns the sum only).
      const financeRead = request.method === 'GET' && (path === '/api/v0/finance/desk' || /^\/api\/v0\/finance\/desk\/(files|exports)\/[^/]+$/.test(path) || /^\/api\/v0\/erp(\/|$)/.test(path) || /^\/api\/v0\/quotes\/[0-9a-f-]{36}$/i.test(path) || path === '/api/v0/comp/totals');
      if (nativeDevice || (!self && !financeRead)) fail(403, 'Accountant access is read-only Finance only');
      if (path === '/api/v0/auth/account' && (request.body as { action?: string } | undefined)?.action === 'totp-disable') fail(403, 'Two-step verification is required for Accountant access');
      if (request.method === 'GET') await c.query("select pulse.audit_write('accountant_view',$1)", [path]);
      await c.query("select set_config('pulse.session_hash',$1,true)", [typeof token === 'string' ? sessionHash(token) : '']);
      if (financeRead) await c.query('select pulse.finance_desk_authorize(false)');
    }
    if (via === "access") await c.query("select pulse.audit_signin($1)", [v.email + ':' + String(request.headers['x-pulse-access-id']??'daily-session-unknown')]);
    if (request.method==='GET' && /^\/api\/v0\/(hr\/|people\/[^/]+\/hr|me\/hr(\?|$)|me(\?|$)|attendance|leave|audit(\?|$)|review-data(\/attention)?(\?|$)|notifications|company\/imports)/.test(request.url))
      await c.query("select pulse.audit_write('restricted_read',$1)",[request.url.split('?')[0]]);
    if (via === 'password' && typeof token === 'string') await c.query("update pulse.login_session set last_active_at=now() where token_hash=$1 and last_active_at<now()-interval '1 minute'",[sessionHash(token)]);
    // ONBOARD-GATE (1195): after the password change, a staff person with a missing profile field reaches only profile
    // setup, sign-out and help until it is in (pulse.onboarding_gate: per person, in the organisation now open). It is
    // read with the two-step check (one round trip) and skipped for a minute after Pulse was open for this person.
    const gateKey = `${v.org}/${v.person}`;
    const gateDue = !!v.person && !v.mustChange && v.role !== 'accountant' && v.side !== 'client' && !gateFree(request.url, v.person) && (gateOpen.get(gateKey) ?? 0) < Date.now();
    const checks = (await c.query('select pulse.auth_enforcement($1) blocked,case when $2::boolean then pulse.onboarding_gate($3::boolean) end gate',[v.person, gateDue, gateDue && await filesReady()])).rows[0];
    // TWO-STEP-NUDGE (owner, 30 Oct 2026: "make it simpler for anyone ... consider user experience"): an organisation's
    // two-step rule no longer locks an admin out of every page once the grace period ends. Signing in still opens
    // Account / Security with the set-up (auth_login's enrollmentRequired), so the reminder stays; work never stops.
    if (v.mustChange && !request.url.startsWith("/api/v0/auth/") && request.url.split("?")[0] !== "/api/v0/me") fail(403, "Change your issued password before opening your workspace");
    if (gateDue) {
      if (checks.gate?.blocked) failCode(403, "Finish setting up your profile to open Pulse", "profile_incomplete");
      if (gateOpen.size > 5000) gateOpen.clear();
      gateOpen.set(gateKey, Date.now() + 60_000);
    }
    // UX-TENANT: a module the company switched off (Settings → Organisation → Modules) answers as off.
    const off = moduleForPath(request.url);
    if (off && !(await c.query("select pulse.org_modules() m")).rows[0].m[off]) fail(403, MODULE_OFF[off]);
    if(request.method==='GET') {
      const record=request.url.split('?')[0].match(/^\/api\/v0\/(clients|projects|contacts)\/([0-9a-f-]{36})$/);
      if(record){const entity={clients:'client',projects:'project',contacts:'contact'}[record[1]];
        const merged=(await c.query('select keep_id from pulse.record_merge where entity_type=$1 and gone_id=$2 and undone_at is null',[entity,record[2]])).rows[0];
        if(merged)(request.params as {id:string}).id=merged.keep_id;
      }
    }
    return run(c, v);
  });
  registerNativeRoutes(app,{tx,open});
  registerUpdates(app, { tx });
  registerUpdateRequests(app, { tx });
  registerAgentRoutes(app, { open });
  registerV1(app, { open });
  registerAgentAdminRoutes(app, { tx }, installation);
  // AI-TASKS: an AI employee working its tasks (its runtime's key), and what people read about that work.
  registerAgentTaskRoutes(app, { open, tx });
  registerAgentHistoryRoutes(app, { tx });
  // CONNECT-AI: Settings → AI (subscriptions, API keys, agent workspaces).
  registerConnectAiRoutes(app, { tx }, installation);
  registerCompanionRoutes(app, { tx, open });
  registerAttendanceExceptionRoutes(app, { tx });
  registerCompanionInboxRoutes(app, { tx });
  registerNoticeRoutes(app, { tx });
  registerWhatsAppIngress(app, { tx, open });
  registerAcquisitionRoutes(app, { tx, open });
  registerDeliveryRoutes(app, { tx });
  registerFairWorkRoutes(app, { tx });
  registerPortalRoutes(app, { tx, open });
  registerContactIdentityRoutes(app, { tx });
  registerBriefRoutes(app, { tx });
  registerClientMasterRoutes(app, { tx });
  registerIntelligenceRoutes(app, { tx });
  registerInvitationRoutes(app, { tx });
  // ONBOARD: the public /team-setup page and HR → Onboard team → Team setup.
  registerTeamSetupRoutes(app, { tx, open });
  // MOBILE-READY (1260): Settings → Devices → Add a test device, and the sign-in page's "Sign in with a code".
  registerDeviceSignIn(app, { tx, open });
  registerAccountSecurity(app, { tx, open, google });
  registerOAuth(app, { tx, open });
  registerPeopleInfoRoutes(app, { tx });
  registerSkillRoutes(app, { tx });
  registerAtsRoutes(app, { tx });
  registerCoachRoutes(app, { tx });
  registerFinanceDeskRoutes(app, { tx });
  registerFinanceEntryRoutes(app, { tx });
  registerChatRoutes(app, { tx, pool });
  // GROUP-ACCESS (1098): who reads client group conversations (Settings → Chats), Client groups, browse and join.
  registerGroupAccessRoutes(app, { tx });
  registerChatIntentRoutes(app, { tx });
  registerChatVoiceRoutes(app, { tx });
  registerCallRoutes(app, { tx, pool, open });
  registerChatWorkRoutes(app, { tx });
  registerChatImportRoutes(app, { tx });
  registerWaChatRoutes(app, { tx });
  registerWaKnowledgeRoutes(app, { tx });
  // WA-AUDIO (1112): a colleague corrects machine transcripts of a test set of voice notes (the engines are scored on it).
  registerWaAudioReviewRoutes(app, { tx });
  registerOpsInsightRoutes(app, { tx });
  registerWaIntelRoutes(app, { tx });
  registerReportRoutes(app, { tx });
  registerInsightCardRoutes(app, { tx });
  registerResearchRoutes(app,{tx,cache});
  registerPerformanceRoutes(app, { tx });
  // TELEMETRY: the browser's movements in, leadership's overview and session timelines out.
  registerTelemetryRoutes(app, { tx });
  // BUG-REPORT (1201): "Report a bug" from any screen, and /bug-reports triage.
  registerBugReportRoutes(app, { tx, open });
  registerRequestsBoardRoutes(app, { tx, open });
  registerGroupRoutes(app, { tx });
  registerGroupsHubRoutes(app, { tx, open });
  registerDeliveryClaimRoutes(app, { tx });
  registerDesignClaimRoutes(app, { tx });
  registerAccountClaimRoutes(app, { tx });
  registerPulseAppRoutes(app, { tx });
  registerTenantRoutes(app, { tx, open, pool });
  registerScreenRoutes(app, { tx });
  registerCreativeRoutes(app, { tx });
  registerSalesHomeRoutes(app, { tx });
  registerSalesXrayRoutes(app, { tx });
  // XRAY-LINK: lead sync, calls linked to clients and people, recordings sent for analysis.
  registerSalesXraySyncRoutes(app, { tx, pool, f: (url, init) => fetch(url, init) });
  registerSiteVisitSettings(app, { tx });
  registerSiteVisits(app, { tx });
  registerChatNames(app, { tx });
  registerAccountRoutes(app, { tx, open });
  // PULSE-ID: Sign in with Pulse (OpenID Connect provider) and the data API apps call with its tokens.
  registerOidcRoutes(app, { tx, open });
  registerConnectApi(app, { open, pool });
  registerConnectRoutes(app, { tx, open });
  // CLIENT-PORTAL: client access from client records, the client's space, shared quotations.
  registerClientPortalRoutes(app, { tx });
  // PORTAL-2 (1066): sign-in links for client accounts, deliverables for approval, paying, preferences.
  registerClientSignIn(app, { tx, open });
  registerClientSpaceRoutes(app, { tx });
  registerFlowRoutes(app, { tx });
  registerFlowSetupRoutes(app, { tx });
  registerFlowAppRoutes(app, { tx, open });
  // ORG: a client of the organisation sees Work (their tasks), Chats and their own pages.
  const clientHidden = SCREENS.filter((s) => !["work", "chats", "me"].includes(s.key));
  const clientScreens = { keys: clientHidden.map((s) => s.key), paths: clientHidden.flatMap((s) => [...s.paths]) };
  const day = (d: string, add = 0) => new Date(Date.parse(`${d}T00:00:00Z`) + add * 86400000).toISOString().slice(0, 10);
  const realDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && day(d) === d;
  // A period is an inclusive date range on the company's calendar (its time zone): ?period=this|last, ?week=2026-W41 or ?from=&to=.
  async function period(c: PoolClient, req: FastifyRequest) {
    const q = req.query as { week?: string; period?: string; from?: string; to?: string };
    const now = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text today,
      date_trunc('week',now() at time zone ${ORG_TZ})::date::text monday,pulse.org_time_zone() zone`)).rows[0] as { today: string; monday: string; zone: string };
    let from = now.monday, to = day(now.monday, 6), kind = "this";
    if (q.from || q.to) {
      if (!realDate(q.from) || !realDate(q.to)) fail(400, "Use dates such as 2026-10-05");
      if (q.to! < q.from!) fail(400, "End date must be on or after start date");
      if (Date.parse(q.to!) - Date.parse(q.from!) > 366 * 86400000) fail(400, "Choose a range of one year or less");
      from = q.from!; to = q.to!; kind = "custom";
    } else if (q.week) {
      if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(q.week)) fail(400, "Use an ISO week such as 2026-W41");
      const w = (await c.query(`select to_char(to_date($1,'IYYY-"W"IW'),'IYYY-"W"IW')=$1 valid,
        to_date($1,'IYYY-"W"IW')::text monday`, [q.week])).rows[0];
      if (!w.valid) fail(400, "Invalid ISO week");
      from = w.monday; to = day(from, 6); kind = "week";
    } else if (q.period === "last") { from = day(now.monday, -7); to = day(from, 6); kind = "last"; }
    else if (q.period && q.period !== "this") fail(400, "Unknown period");
    if (from === now.monday && to === day(from, 6)) kind = "this";
    else if (from === day(now.monday, -7) && to === day(from, 6)) kind = "last";
    const isoWeek = (await c.query(`select to_char($1::date,'IYYY-"W"IW') week,extract(isodow from $1::date)::int dow`, [from])).rows[0];
    const start = zoneTime(from, now.zone), end = zoneTime(day(to, 1), now.zone), at = new Date();
    // Compare an unfinished period with the same elapsed span of the one before it.
    const cut = new Date(Math.max(start.getTime(), Math.min(at.getTime(), end.getTime())));
    const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
    const prevEnd = new Date(prevStart.getTime() + (cut.getTime() - start.getTime()));
    return { from, to, kind, today: now.today, monday: now.monday, zone: now.zone,
      week: isoWeek.dow === 1 && to === day(from, 6) ? isoWeek.week as string : null,
      start, end, cut, prevStart, prevEnd, inProgress: at >= start && at < end };
  }
  type Period = Awaited<ReturnType<typeof period>>;
  async function designerWorkCalendar(c: PoolClient, orgId: string, p: Period) {
    const policy = (await c.query("select work_days from pulse.hr_policy where org_id=$1", [orgId])).rows[0] as { work_days?: number[] } | undefined;
    const workDays = policy?.work_days ?? [1, 2, 3, 4, 5, 6];
    const holidays = (await c.query(`select h.day::text as holiday_day from pulse.holiday h
      where h.org_id=$1 and h.day between $2::date and $3::date and not h.optional`, [orgId, p.from, p.to])).rows as Array<{ holiday_day: string }>;
    return { workDays, holidays: new Set(holidays.map(row => row.holiday_day)), capAtToday: p.from === p.monday };
  }
  const publicPeriod = (p: Period) => ({ from: p.from, to: p.to, kind: p.kind, week: p.week, today: p.today, inProgress: p.inProgress });
  const visible = (v: Viewer) => leadership(v) ? null : manager(v) ? `team:${v.person}` : v.person ? `person:${v.person}` : v.email;
  const designCountTypes = [...DESIGN_DELIVERY_TYPES, "other"] as DesignDeliveryType[];
  type DesignCounts = Record<DesignDeliveryType, number>;
  type DesignFile = { path: string; name: string; mime: string | null; eventDay: string;
    personId: string | null; sharedLogin: boolean; hasDelivery: boolean; claimed: boolean };
  const emptyDesignCounts = (): DesignCounts =>
    Object.fromEntries(designCountTypes.map(type => [type, 0])) as DesignCounts;
  async function designFiles(c: PoolClient, orgId: string, p: Period, scope: string | null) {
    return (await c.query(`with claim_files as materialized (
      select f.*,pulse.design_claim_person(f.file_id) claim_person
      from pulse.index_file f
      where f.org_id=$1 and f.account_basis='last modifying account'
        and coalesce(f.modified_at,f.created_at) >= $2 and coalesce(f.modified_at,f.created_at) < $3
        and coalesce(f.modified_at,f.created_at) < now()
        and (lower(f.mime) like 'image/%' or lower(f.mime)='application/pdf'
          or lower(f.name) like any(array['%.ai','%.bmp','%.gif','%.jpeg','%.jpg','%.pdf','%.png','%.psd','%.svg','%.tif','%.tiff','%.webp']))
    ), eligible as (
      select f.path,f.name,f.mime,
        to_char(coalesce(f.modified_at,f.created_at) at time zone ${ORG_TZ},'YYYY-MM-DD') "eventDay",
        credit.person_id "personId",
        (coalesce(ea_account.is_shared,false) and f.claim_person is null) "sharedLogin",
        (coalesce(ea_account.is_shared,false) and f.claim_person is not null) claimed,
        exists(select 1 from pulse.delivery d where d.org_id=f.org_id and d.file_id=f.file_id) "hasDelivery"
      from claim_files f
      join pulse.account ea_account on ea_account.org_id=f.org_id and ea_account.provider='google'
        and ea_account.handle=f.uploader_account
      left join pulse.person uploader_person on uploader_person.org_id=ea_account.org_id
        and uploader_person.id=ea_account.holder_person_id
      left join lateral (
        select a.method,a.person_id
        from pulse.file source_file
        join pulse.version version on version.org_id=source_file.org_id and version.file_id=source_file.id
        join pulse.attribution a on a.org_id=version.org_id and a.version_id=version.id
          and a.resolver_version='delivery-attribution/v1'
        where source_file.org_id=f.org_id and source_file.store='gdrive' and source_file.store_id=f.file_id
        order by a.event_time desc,a.event_seq desc limit 1
      ) delivery_attribution on true
      left join pulse.person attributed_person on attributed_person.org_id=f.org_id
        and attributed_person.id=delivery_attribution.person_id and attributed_person.side='staff'
      cross join lateral (select case
          when coalesce(ea_account.is_shared,false) and f.claim_person is not null then f.claim_person
          when coalesce(ea_account.is_shared,false) then null
          when delivery_attribution.method in ('evidence','declared','individual_account','device','manual')
            and attributed_person.id is not null then attributed_person.id
          when uploader_person.side='staff' then uploader_person.id
          else null end) credit(person_id)
      where (uploader_person.side='staff' or coalesce(ea_account.is_shared,false))
        and ($4::text is null
          or ($4 like 'team:%' and (f.project_id=any(pulse.work_projects())
            or credit.person_id=pulse.current_viewer()))
          or ($4 like 'person:%' and credit.person_id=nullif(substr($4,8),'')::uuid))
    )
    select * from eligible
    where "sharedLogin" or "personId" is not null
      and ($4::text is null or $4 not like 'team:%' or "personId" is null
        or "personId"=pulse.current_viewer() or pulse.manages("personId"))`,
    [orgId, p.start, p.end, scope])).rows as DesignFile[];
  }
  async function attributionCounts(c: PoolClient, account: string | null) {
    const counts = (await c.query(`select
      count(*) filter(where credited_to not in ('shared login','unresolved'))::int credited_to_person,
      count(*) filter(where credited_to='shared login')::int shared_login,
      count(*) filter(where credited_to='unresolved')::int unresolved,
      count(*)::int total_deliveries
      from (select ${creditedTo} credited_to from pulse.delivery d ${deliveryAttributionJoin}
        where d.delivered_at >= now()-interval '30 days' and pulse.delivery_matches(d.file_id,$1)) rows`,
    [account])).rows[0];
    const creditedToPerson = Number(counts.credited_to_person);
    const sharedLogin = Number(counts.shared_login);
    const unresolved = Number(counts.unresolved);
    const totalDeliveries = Number(counts.total_deliveries);
    return { window_days: 30, total_deliveries: totalDeliveries,
      credited_to_person: creditedToPerson,
      credited_to_person_share: totalDeliveries ? creditedToPerson / totalDeliveries : 0,
      shared_login: sharedLogin,
      shared_login_share: totalDeliveries ? sharedLogin / totalDeliveries : 0,
      unresolved };
  }
  async function summary(c: PoolClient, v: Viewer, req: FastifyRequest, account = visible(v), pod: string | null = null) {
    const p = await period(c, req); const week = p.week ?? `${p.from} – ${p.to}`;
    const params = [p.start, account, pod, p.end];
    const filter = `d.delivered_at >= $1 and d.delivered_at < $4
      and pulse.delivery_matches(d.file_id,$2)
      and ($3::text is null or u.name=$3 or ($3='Unassigned' and p.unit_id is null))`;
    const projectRows = (await c.query(`select p.id "projectId",p.name "projectName",count(*)::int count,
      count(*) filter(where d.kind='draft')::int drafts,count(*) filter(where d.kind='final')::int finals,
      array_agg(distinct d.rule order by d.rule) "matchedRuleDocs"
      from pulse.delivery d join pulse.project p on p.id=d.project_id left join pulse.unit u on u.id=p.unit_id
      where ${filter} group by p.id order by count(*) desc,p.name`, params)).rows;
    const ruleKeys = [...new Set(projectRows.flatMap(p => p.matchedRuleDocs ?? []))].sort();
    const projects = projectRows.map(({ matchedRuleDocs, ...p }) => ({ ...p,
      deliveries: explained(p.count, matchedRuleDocs ?? [],
        "Distinct indexed media files matching configured delivery folders in the selected week.") }));
    const recent = (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",p.id "projectId",p.name "projectName",
      d.uploader_account "uploaderAccount",d.kind "deliverableType",d.delivered_at "deliveredAt",
      to_char(d.delivered_at at time zone ${ORG_TZ},'IYYY-"W"IW') week,d.rule "matchedRule",
      d.rule_detail "ruleDetail",f.account_basis "accountBasis",f.path,
      coalesce(ea_account.is_shared,false) "sharedLogin",(ea_account.holder_person_id is not null) "identityVerified",
      ${creditedTo} credited_to,${attributionHow} how
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project p on p.id=d.project_id
      left join pulse.unit u on u.id=p.unit_id
      ${deliveryAttributionJoin}
      where ${filter} order by d.delivered_at desc,d.file_id limit 40`, params)).rows;
    const count = projects.reduce((n, p) => n + p.count, 0);
    const usual = (await c.query(`select count(*)::numeric/8 usual from pulse.delivery d
      join pulse.project p on p.id=d.project_id left join pulse.unit u on u.id=p.unit_id
      where delivered_at >= $1::timestamptz - interval '8 weeks' and delivered_at < $1
      and pulse.delivery_matches(d.file_id,$2)
      and ($3::text is null or u.name=$3 or ($3='Unassigned' and p.unit_id is null))`, params.slice(0, 3))).rows[0].usual;
    const source = (await c.query(`select count(*)::int files,max(observed_at) "lastIndexedAt",
      count(distinct project_id)::int "indexedProjects" from pulse.index_file f
      where pulse.delivery_matches(f.file_id,$1)`, [account])).rows[0];
    // UX-TENANT: "All <code> accounts" names the company by its own code (DE-EA: no fallback company).
    const everyone = account ? null : await (async () => { const code = (await c.query("select code from pulse.org where id=pulse.current_org()")).rows[0]?.code; return code ? `All ${code} accounts` : "All company accounts"; })();
    return { week, period: publicPeriod(p), uploaderAccount: account ?? everyone, projects, byProject: projects, recentDeliveries: recent,
      deliveries: explained(count, ruleKeys,
        "One record per indexed file in a configured delivery folder. Delivery time is the snapshot modification date. Personal views count only files with a qualified uploader; shared logins and unknown actors receive no personal credit.",
        recent.map(r => r.fileId)),
      drafts: projects.reduce((n, p) => n + p.drafts, 0), finals: projects.reduce((n, p) => n + p.finals, 0),
      usual: Number(usual), ...source, attribution: await attributionCounts(c, account), scope: account ? "Qualified uploads for this person" : everyone };
  }
  app.get("/api/v0/me", { schema: { response: { 200: {
    type: "object", additionalProperties: true, required: ["modules"], properties: { modules: MODULES_RESPONSE_SCHEMA } } } } },
  req => tx(req, async (c, v) => { const own = v.person && v.role !== 'accountant' ? await roleScreens(c, v.person) : null;
    const words = v.person && v.role !== 'accountant' ? (await c.query('select pulse.org_words() w')).rows[0].w : null;
    // PERF: /me is read by every page's server render; its small reads go in one query instead of six round trips.
    const self = !!v.person && v.role !== 'accountant';
    const one = (await c.query(`select o.handle,o.name,pulse.org_modules() modules,
        case when $2 then pulse.tenant_operator() else false end operator,case when $2 then pulse.platform_admin() else false end "platformAdmin",case when $3 then pulse.hr_can('hr.salary.read') else false end "hrAccess",
        case when $4 then pulse.account_me() end account,case when $4 then (select ph.updated_at from pulse.person_photo ph where ph.person_id=$5) end "photoAt",
        case when $6::boolean then pulse.onboarding_gate($7::boolean) end "profileGate",
        case when $4 then exists(select 1 from pulse.role_assignment r where r.person_id=$5 and r.role_key in ('finance','leadership') and (r.valid_to is null or r.valid_to>=current_date))
          or not exists(select 1 from pulse.role_assignment r where r.role_key in ('finance','leadership') and (r.valid_to is null or r.valid_to>=current_date)) else false end "moneyHome",
        case when $4 then pulse.auth_two_step_due($5) else false end "twoStepDue"
      from (select 1) x left join pulse.org o on o.id=$1`, [v.org, v.role === "admin" && !!v.person, hr(v) && !!v.person, self, v.person,
        self && !v.mustChange && v.side !== 'client', await filesReady()])).rows[0];
    return { ...v,
    // ORG: the Pulse account (handle, organisations to switch to, invitations waiting) for the org switcher.
    account: self ? one.account : null,
    orgHandle: one.handle ?? null,
    orgName: normalizedOrgName(one.name),
    // TWO-STEP-GUIDE: the guided two-step window opens while this is true (pulse.auth_two_step_due).
    twoStepSetup: self && v.side !== 'client' && !!one.twoStepDue,
    roles: [v.role],
    // UX-TENANT: the company's own switches (the rail hides what is off) and whether this person runs the platform.
    // `modules` (EST-647, below) is the install's config list of switched-off modules.
    companyModules: one.modules,
    operator: !!one.operator,
    // PULSE-ADMIN (1140): whether this person uses the platform admin console (/admin).
    platformAdmin: !!one.platformAdmin,
    // ONBOARD-GATE: whether Pulse opens yet ({ blocked, missing, canSkip }); the web app shows /welcome while blocked.
    profileGate: one.profileGate ?? null,
    hrAccess: !!one.hrAccess,
    // MY-TASKS (owner, 28 Oct 2026): the company's money (owed, the gap, bank statements, GST, renewals) is on the Home
    // of whoever holds Finance or Leadership; an admin who holds neither (the person who runs Pulse) is not asked to
    // chase invoices or upload statements. When nobody holds either role, the admins keep it.
    moneyHome: !!one.moneyHome,
    photoAt: self ? one.photoAt ?? null : null,
    modules: await readModules(c, v.org),
    // EST-1419: the screens this person's role does not see (their menu entries go; a direct link shows /hidden).
    hiddenScreens: v.side === 'client' ? clientScreens : await viewerHiddenScreens(c, v.role, own?.screens ?? []),
    // EST-1240/1241: the home this person's role lands on (the organisation's choice; the Dashboard by default). FLOW-E:
    // a work role that names a home (a sales role's sales home) picks it.
    home: own?.home ?? await viewerHome(c, v.role),
    // FLOW-E: the work roles this person holds and the company's own words (Settings → Industry & roles). DE-EA: `vocabulary`
    // is the company's one vocabulary (orgVocabulary: neutral → business model → team word → its own words).
    ...(await (async () => {
      if (!(v.person && v.role !== 'accountant')) return { workRoles: own?.roles ?? [], words: null, vocabulary: null, workLabels: null };
      const s = (await c.query('select pulse.work_settings_get() s')).rows[0].s;
      const ownWords = words && Object.keys(words).length ? wordsOf(words) : null;
      return { workRoles: own?.roles ?? [], words: ownWords, vocabulary: orgVocabulary(s.businessModel, s.teamLabel, words),
        // UX-TASKS-2: what the company calls clients and what it sells (rail labels follow the business model).
        workLabels: workLabels(s.businessModel, s.teamLabel, words) };
    })()) }; }));
  app.get("/api/v0/admin/config/folder-rules", req => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Admin access required");
    const rows = (await c.query(`select doc_key,version,body from pulse.tenant_config
      where org_id=$1 and doc_kind='folder_rules' and is_active order by doc_key,version`, [v.org])).rows;
    return folderRulesSummary(rows as FolderRuleDocument[], v.org);
  }));
  app.get("/api/v0/my-week", req => tx(req, async (c, v) => { work(v); return summary(c, v, req,v.person?`person:${v.person}`:v.email); }));
  app.get("/api/v0/leadership-week", req => tx(req, async (c, v) => {
    work(v); if (!leadership(v)) fail(403, "Leadership access required");
    const people = (await c.query("select count(*)::int headcount,pulse.agent_count() ai from pulse.person where status='active' and side='staff'")).rows[0];
    return { ...await summary(c, v, req), people };
  }));
  app.get("/api/v0/pod-board", req => tx(req, async (c, v) => {
    work(v);
    const pod = (req.query as { pod?: string }).pod;
    if (pod && !["Pod 1", "Pod 2", "Shared", "Unassigned"].includes(pod)) fail(400, "Unknown pod");
    if (!leadership(v) && pod && pod !== v.pod) fail(403, "You can view your own pod");
    const data = await summary(c, v, req, visible(v), pod ?? null);
    const pods = await Promise.all((leadership(v)?["Pod 1", "Pod 2", "Shared", "Unassigned"]:[v.pod??"Unassigned"]).map(async name => {
      const s = await summary(c, v, req, visible(v), name);
      return { name, projects: s.projects.length, deliveries: s.deliveries.value,
        detail: name === "Unassigned" ? "Real projects inferred from Drive paths; pod ownership has not been verified." : "Only projects with a verified pod assignment are counted." };
    }));
    return { ...data, pods };
  }));
  app.get<{ Params: { person: string } }>("/v1/editors/:person/week", req => tx(req, async (c, v) => {
    work(v);
    const person = req.params.person.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(person)) fail(400, "Use a person UUID");
    if (!admin(v) && person !== v.person) {
      if (!manager(v) || !v.person || !(await c.query('select pulse.manages($1) ok', [person])).rows[0]?.ok)
        fail(403, "You can view your own editor week or a direct report’s week");
    }
    const q = req.query as { week?: string };
    if (!q.week) fail(400, "Choose an ISO week such as 2026-W41");
    const p = await period(c, req);
    if (!p.week) fail(400, "Choose one complete ISO week");
    const exists = (await c.query("select id from pulse.person where org_id=$1 and id=$2 and status='active'", [v.org, person])).rows[0];
    if (!exists) fail(404, "Editor was not found");

    await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
      values ($1,$2,$3,'editors.week','person','editor_week_view')`, [v.org, v.person, person]);
    const targetDoc = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='targets' and doc_key='editors' and is_active`, [v.org])).rows[0]?.body ?? {};
    const typeRules = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='folder_rules' and is_active
        and (body ? 'creative_type_rules' or (body->'folder_rules') ? 'creative_type_rules')
      order by doc_key limit 1`, [v.org])).rows[0]?.body ?? {};
    const targets = loadEditorTargets(targetDoc, person);
    const deliveries = (await c.query(`select f.path,f.name,d.kind,
        exists(select 1 from pulse.delivery_claim claim where claim.org_id=d.org_id and claim.file_id=d.file_id
          and claim.claim_scope='delivery' and claim.person_id=$4 and claim.status='confirmed') claimed
      from pulse.delivery d join pulse.index_file f using(org_id,file_id)
      where d.org_id=$1 and d.delivered_at >= $2 and d.delivered_at < $3
        and (exists (select 1 from pulse.account a where a.org_id=d.org_id and a.provider='google'
            and a.handle=d.uploader_account and a.holder_person_id=$4 and not a.is_shared)
          or exists(select 1 from pulse.delivery_claim claim where claim.org_id=d.org_id and claim.file_id=d.file_id
            and claim.claim_scope='delivery' and claim.person_id=$4 and claim.status='confirmed'))`,
    [v.org, p.start, p.end, person])).rows;
    const counts = Object.fromEntries(EDITOR_CREATIVE_TYPES.map(type => [type, { drafts: 0, finals: 0 }])) as
      Record<(typeof EDITOR_CREATIVE_TYPES)[number], { drafts: number; finals: number }>;
    const claimedCounts = Object.fromEntries(EDITOR_CREATIVE_TYPES.map(type => [type, { drafts: 0, finals: 0 }])) as
      Record<(typeof EDITOR_CREATIVE_TYPES)[number], { drafts: number; finals: number }>;
    for (const delivery of deliveries as Array<{ path: string; name: string; kind: "draft" | "final"; claimed: boolean }>) {
      if (delivery.kind !== "draft" && delivery.kind !== "final") continue;
      const type = classifyEditorCreativeType(delivery.path, delivery.name, typeRules);
      counts[type][delivery.kind === "draft" ? "drafts" : "finals"] += 1;
      if (delivery.claimed) claimedCounts[type][delivery.kind === "draft" ? "drafts" : "finals"] += 1;
    }
    const types = Object.fromEntries(EDITOR_CREATIVE_TYPES.map(type => {
      const target = targets[type].target;
      const delivered = counts[type];
      return [type, { target, delivered, claimed: claimedCounts[type], gap: target === null ? null : Math.max(0, target - delivered.drafts - delivered.finals),
        placeholder: targets[type].placeholder }];
    }));
    // Open tasks are a self-only surface. Admins retain their existing ability to
    // inspect another editor's delivery report, but that report never includes
    // the target editor's assigned work.
    const openTasks = person === v.person ? await c.query(`select t.id,t.title,t.status,t.due_at "dueAt",
        a.id "assetId",asset_file.store "assetStore",asset_file.store_id "assetStoreId"
      from pulse.task t
      left join pulse.asset a on a.org_id=t.org_id and a.task_id=t.id
      left join lateral (
        select f.store,f.store_id from pulse.version ver
        join pulse.file f on f.org_id=ver.org_id and f.id=ver.file_id
        where ver.org_id=a.org_id and ver.asset_id=a.id and f.store='gdrive' and f.trashed_at is null
        order by ver.created_at desc,ver.version_no desc,ver.id desc limit 1
      ) asset_file on true
      where t.org_id=$1 and t.assignee_person_id=$2 and t.status not in ('done','cancelled')
      order by t.due_at asc nulls last,t.id,a.id`, [v.org, v.person]) : undefined;
    const tasks = new Map<string, { id: string; title: string; status: string; dueAt: Date | string | null;
      assets: Array<{ id: string; url: string | null }> }>();
    for (const row of (openTasks?.rows ?? []) as Array<{ id: string; title: string; status: string; dueAt: Date | string | null;
      assetId: string | null; assetStore: string | null; assetStoreId: string | null }>) {
      let task = tasks.get(row.id);
      if (!task) {
        task = { id: row.id, title: row.title, status: row.status, dueAt: row.dueAt, assets: [] };
        tasks.set(row.id, task);
      }
      if (row.assetId) task.assets.push({ id: row.assetId,
        url: row.assetStore === "gdrive" && row.assetStoreId
          ? `https://drive.google.com/file/d/${encodeURIComponent(row.assetStoreId)}/view` : null });
    }
    return { week: p.week, types, ...(openTasks ? { openTasks: [...tasks.values()] } : {}) };
  }));
  app.get("/api/v0/design-deliveries/summary", req => tx(req, async (c, v) => {
    work(v);
    if (!admin(v) && !manager(v)) fail(403, "Only admins or managers can view team design delivery totals");
    await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
      values ($1,$2,null,'design_deliveries.summary','30_day','design_delivery_credit_aggregate')`, [v.org, v.person]);
    const config = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='folder_rules' and is_active
        and (body ? 'design_type_rules' or (body->'folder_rules') ? 'design_type_rules')
      order by version desc,doc_key limit 1`, [v.org])).rows[0]?.body ?? {};
    const deliveries = (await c.query(`with claim_files as materialized (
      select f.*,pulse.design_claim_person(f.file_id) claim_person
      from pulse.index_file f
      where f.org_id=$1 and coalesce(f.modified_at,f.created_at) >= now()-interval '30 days'
        and coalesce(f.modified_at,f.created_at) < now()
        and f.account_basis='last modifying account'
    )
      select f.path,f.name,f.mime,
        exists(select 1 from pulse.delivery d where d.org_id=f.org_id and d.file_id=f.file_id) has_delivery,
        case
          when coalesce(ea_account.is_shared,false) and f.claim_person is not null then f.claim_person::text
          when delivery_attribution.method in ('evidence','declared','individual_account','device','manual')
            and delivery_attribution.person_id is not null then delivery_attribution.person_id::text
          when coalesce(ea_account.is_shared,false) then 'shared login'
          when ea_person.side='staff' then ea_person.id::text
          else 'unresolved' end credited_to,
        case
          when coalesce(ea_account.is_shared,false) and f.claim_person is not null then 'confirmation'
          when delivery_attribution.method in ('evidence','declared','individual_account','device','manual')
            and delivery_attribution.person_id is not null then (
              select evidence.item->>'how'
              from jsonb_array_elements(coalesce(delivery_attribution.evidence,'[]'::jsonb)) with ordinality
                as evidence(item, position)
              where evidence.item ? 'how' order by evidence.position desc limit 1)
          when coalesce(ea_account.is_shared,false) then 'shared'
          when ea_person.side='staff' then 'account map'
          else null end how
      from claim_files f
      join pulse.account ea_account on ea_account.org_id=f.org_id and ea_account.provider='google'
        and ea_account.handle=f.uploader_account
      left join pulse.person ea_person on ea_person.org_id=ea_account.org_id and ea_person.id=ea_account.holder_person_id
      left join lateral (
        select a.method,a.person_id,a.evidence
        from pulse.file source_file
        join pulse.version version on version.file_id=source_file.id
        join pulse.attribution a on a.version_id=version.id and a.resolver_version='delivery-attribution/v1'
        where source_file.org_id=f.org_id and source_file.store='gdrive' and source_file.store_id=f.file_id
        order by a.event_time desc,a.event_seq desc limit 1
      ) delivery_attribution on true
      where (ea_person.side='staff' or coalesce(ea_account.is_shared,false))
        and (lower(f.mime) like 'image/%' or lower(f.mime)='application/pdf'
          or lower(f.name) like any(array['%.ai','%.bmp','%.gif','%.jpeg','%.jpg','%.pdf','%.png','%.psd','%.svg','%.tif','%.tiff','%.webp']))
        and ($2::text is null or ($2 like 'team:%' and f.project_id=any(pulse.work_projects()))
          or pulse.delivery_matches(f.file_id,$2))`,
    [v.org, visible(v)])).rows as Array<{ path: string; name: string; mime: string | null;
      has_delivery: boolean; credited_to: string; how: string | null }>;
    const types = Object.fromEntries([...DESIGN_DELIVERY_TYPES, "other"].map(type => [type, 0])) as
      Record<(typeof DESIGN_DELIVERY_TYPES)[number] | "other", number>;
    const creditStatus = { credited_to_person: 0, shared_login: 0, unresolved: 0 };
    const methods = { account_map: 0, confirmation: 0, fingerprint: 0, folder_owner: 0, shared: 0, unresolved: 0 };
    const methodKeys: Record<string, keyof typeof methods> = {
      "account map": "account_map", confirmation: "confirmation", fingerprint: "fingerprint",
      "folder owner": "folder_owner", shared: "shared",
    };
    for (const delivery of deliveries) {
      if (!isDesignExport(delivery.mime, delivery.name)) continue;
      const designType = classifyDesignType(delivery.path ?? "", delivery.name, config);
      if (designType === "other" && !delivery.has_delivery) continue;
      types[designType] += 1;
      if (delivery.credited_to === "shared login") creditStatus.shared_login += 1;
      else if (delivery.credited_to === "unresolved") creditStatus.unresolved += 1;
      else creditStatus.credited_to_person += 1;
      methods[methodKeys[delivery.how ?? ""] ?? "unresolved"] += 1;
    }
    const total = Object.values(types).reduce((sum, count) => sum + count, 0);
    return { window_days: 30, total, unmatched_count: types.other, types,
      attribution: { total_deliveries: total, ...creditStatus, by_method: methods } };
  }));

  app.get("/api/v0/designers", req => tx(req, async (c, v) => {
    work(v);
    const p = await period(c, req);
    if (!p.week) fail(400, "Choose one complete ISO week");
    const scope = visible(v);
    await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
      values ($1,$2,null,'designers.collection','week','design_delivery_weekly_counts')`, [v.org, v.person]);
    const targetDoc = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='targets' and doc_key='designers' and is_active`, [v.org])).rows[0]?.body ?? {};
    const designerTargets = loadDesignerTargets(targetDoc);
    const people = (await c.query(`select p.id "personId",p.display_name name,pp.role
      from pulse.person p
      left join pulse.people_profile pp on pp.org_id=p.org_id and pp.person_id=p.id
      where p.org_id=$1 and p.side='staff' and p.status='active'
        and ($2::text is null
          or ($2 like 'team:%' and (p.id=pulse.current_viewer() or pulse.manages(p.id)))
          or ($2 like 'person:%' and p.id=nullif(substr($2,8),'')::uuid))
        and lower(trim(coalesce(pp.role,'')))=any($3::text[])
      order by lower(p.display_name),p.display_name,p.id`, [v.org, scope, designerTargets.roles])).rows as Array<{ personId: string; name: string; role: string | null }>;
    const rows = new Map(people.map(person => [person.personId, {
      personId: person.personId, name: person.name, role: person.role as string | null,
      sharedLogin: false, types: emptyDesignCounts(), claimed: emptyDesignCounts(),
    }]));
    let shared: { personId: null; name: "shared login"; sharedLogin: true; types: DesignCounts; claimed: DesignCounts } | null = null;
    const config = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='folder_rules' and is_active
        and (body ? 'design_type_rules' or (body->'folder_rules') ? 'design_type_rules')
      order by version desc,doc_key limit 1`, [v.org])).rows[0]?.body ?? {};
    const files = await designFiles(c, v.org, p, scope);
    for (const file of files) {
      if (!isDesignExport(file.mime, file.name)) continue;
      const type = classifyDesignType(file.path, file.name, config);
      if (type === "other" && !file.hasDelivery) continue;
      if (file.sharedLogin) {
        shared ??= { personId: null, name: "shared login", sharedLogin: true,
          types: emptyDesignCounts(), claimed: emptyDesignCounts() };
        shared.types[type] += 1;
        if (file.claimed) shared.claimed[type] += 1;
      } else if (file.personId && rows.has(file.personId)) {
        rows.get(file.personId)!.types[type] += 1;
        if (file.claimed) rows.get(file.personId)!.claimed[type] += 1;
      }
    }
    const calendar = await designerWorkCalendar(c, v.org, p);
    const expectedDays = countedWorkdays(p.from, p.to, p.today, calendar.workDays, calendar.holidays, calendar.capAtToday);
    const designers = [...rows.values(), ...(shared ? [shared] : [])]
      .map(row => {
        const target = row.personId
          ? designerTargetForRole(designerTargets.singleImage, designerTargets.roles, "role" in row ? row.role : null)
          : { per_day: null, placeholder: true };
        const { role: _role, ...publicRow } = row as typeof row & { role?: string | null };
        return { ...publicRow, singleImage: singleImageExpectation(target, row.types.single_image_ad, expectedDays) };
      })
      .sort((a, b) => a.name.toLocaleLowerCase("en").localeCompare(b.name.toLocaleLowerCase("en"), "en"));
    return { week: p.week, designers };
  }));
  app.get<{ Params: { person: string } }>("/api/v0/designers/:person", req => tx(req, async (c, v) => {
    work(v);
    const person = req.params.person.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(person)) fail(400, "Use a person UUID");
    if (!["person", "staff"].includes(v.role) || !v.person || person !== v.person) fail(403, "Daily design detail is self-only");
    const p = await period(c, req);
    if (!p.week) fail(400, "Choose one complete ISO week");
    await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
      values ($1,$2,$3,'designers.detail','day','design_delivery_daily_self')`, [v.org, v.person, person]);
    const targetDoc = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='targets' and doc_key='designers' and is_active`, [v.org])).rows[0]?.body ?? {};
    const designerTargets = loadDesignerTargets(targetDoc);
    const profile = (await c.query("select role from pulse.people_profile where org_id=$1 and person_id=$2", [v.org, person])).rows[0] as { role?: string } | undefined;
    const target = designerTargetForRole(designerTargets.singleImage, designerTargets.roles, profile?.role);
    const calendar = await designerWorkCalendar(c, v.org, p);
    const config = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='folder_rules' and is_active
        and (body ? 'design_type_rules' or (body->'folder_rules') ? 'design_type_rules')
      order by version desc,doc_key limit 1`, [v.org])).rows[0]?.body ?? {};
    const days = new Map(Array.from({ length: 7 }, (_, index) => {
      const date = day(p.from, index);
      return [date, { day: date, types: emptyDesignCounts(), claimed: emptyDesignCounts() }];
    }));
    const files = await designFiles(c, v.org, p, `person:${person}`);
    for (const file of files) {
      if (file.sharedLogin || file.personId !== person || !isDesignExport(file.mime, file.name)) continue;
      const type = classifyDesignType(file.path, file.name, config);
      if (type === "other" && !file.hasDelivery) continue;
      const counts = days.get(file.eventDay);
      if (counts) {
        counts.types[type] += 1;
        if (file.claimed) counts.claimed[type] += 1;
      }
    }
    const dayRows = [...days.values()].map(row => ({
      ...row,
      singleImage: singleImageExpectation(target, row.types.single_image_ad,
        countedWorkdays(row.day, row.day, p.today, calendar.workDays, calendar.holidays, calendar.capAtToday)),
    }));
    const delivered = dayRows.reduce((sum, row) => sum + row.types.single_image_ad, 0);
    const expectedDays = countedWorkdays(p.from, p.to, p.today, calendar.workDays, calendar.holidays, calendar.capAtToday);
    return { week: p.week, singleImage: singleImageExpectation(target, delivered, expectedDays), days: dayRows };
  }));
  app.get("/api/v0/designers/brand-projects/open", req => tx(req, async (c, v) => {
    work(v);
    const scope = visible(v);
    const targetDoc = (await c.query(`select body from pulse.tenant_config
      where org_id=$1 and doc_kind='targets' and doc_key='designers' and is_active`, [v.org])).rows[0]?.body ?? {};
    const designerTargets = loadDesignerTargets(targetDoc);
    const assets = BRAND_ASSET_TYPES.flatMap(asset => [asset, BRAND_ASSET_DELIVERABLE_TYPES[asset]]);
    const rows = (await c.query(`select t.assignee_person_id "personId",p.id "projectId",t.deliverable_type "deliverableType",
        min(coalesce((t.assigned_at at time zone ${ORG_TZ})::date,ph.planned_start))::text "openedOn",
        case when min(coalesce((t.assigned_at at time zone ${ORG_TZ})::date,ph.planned_start)) is null then null
          else greatest(0,((now() at time zone ${ORG_TZ})::date
            - min(coalesce((t.assigned_at at time zone ${ORG_TZ})::date,ph.planned_start))))::int end "daysOpen"
      from pulse.task t join pulse.project p on p.org_id=t.org_id and p.id=t.project_id
      left join pulse.phase ph on ph.org_id=t.org_id and ph.project_id=t.project_id and ph.phase_key=t.phase_key
      where t.org_id=$1 and t.assignee_person_id is not null and p.status in ('onboarding','active','paused')
        and t.status in ('open','in_progress','blocked','in_review') and t.deliverable_type=any($2::text[])
        and ($3::text is null
          or ($3 like 'team:%' and t.project_id=any(pulse.work_projects()) and pulse.manages(t.assignee_person_id))
          or ($3 like 'person:%' and t.assignee_person_id=nullif(substr($3,8),'')::uuid))
      group by t.assignee_person_id,p.id,t.deliverable_type
      order by p.id,t.deliverable_type,t.assignee_person_id`, [v.org, assets, scope])).rows as Array<{
        personId: string; projectId: string; deliverableType: string; openedOn: string | null; daysOpen: number | null;
      }>;
    const subjects = [...new Set(rows.map(row => row.personId))];
    if (subjects.length) {
      await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
        select $1,$2,subject_id,'designers.brand_projects','project','design_brand_project_window'
        from unnest($3::uuid[]) as subject(subject_id)`, [v.org, v.person, subjects]);
    } else {
      await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
        values ($1,$2,null,'designers.brand_projects','project','design_brand_project_window')`, [v.org, v.person]);
    }
    const brandProjects = rows.flatMap(row => {
      const brandAsset = brandAssetForDeliverableType(row.deliverableType);
      return brandAsset ? [{ personId: row.personId, projectId: row.projectId, brandAsset,
        openedOn: row.openedOn, daysOpen: row.daysOpen, window: designerTargets.windows[brandAsset] }] : [];
    });
    return { brandProjects };
  }));
  app.get("/api/v0/editors", req => tx(req, async (c, v) => {
    work(v); const p = await period(c, req); const week = p.week ?? `${p.from} – ${p.to}`;
    const accounts = (await c.query(`select d.uploader_account account,
      case when coalesce(a.is_shared,false) then null else a.holder_person_id end holder_person_id,
      coalesce(a.is_shared,false) "sharedLogin",(not coalesce(a.is_shared,false) and a.holder_person_id is not null) "identityVerified",
      count(*)::int "allTime",count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $3)::int "thisWeek",
      count(*) filter(where d.kind='draft')::int drafts,count(*) filter(where d.kind='final')::int finals,
      max(delivered_at) "lastDelivery" from pulse.delivery d left join pulse.account a
      on a.provider='google' and a.handle=d.uploader_account where pulse.delivery_matches(d.file_id,$2)
      group by d.uploader_account,a.is_shared,a.holder_person_id order by "lastDelivery" desc`, [p.start, visible(v), p.end])).rows;
    return { week, period: publicPeriod(p), accounts, attribution: await attributionCounts(c, visible(v)) };
  }));
  app.get<{ Params: { account: string } }>("/api/v0/editors/:account", req => tx(req, async (c, v) => {
    work(v); const account = req.params.account.toLowerCase();
    if (!leadership(v) && account !== v.email && !(manager(v)&&(await c.query("select pulse.manages(holder_person_id) ok from pulse.account where handle=$1",[account])).rows[0]?.ok)) fail(403, "You can view your own account");
    const data = await summary(c, v, req, account);
    const days = (await c.query(`select (delivered_at at time zone ${ORG_TZ})::date::text "day",
      count(*)::int deliveries,count(*) filter(where d.kind='draft')::int drafts,
      count(*) filter(where d.kind='final')::int finals from pulse.delivery d where uploader_account=$1
      group by 1 order by 1 desc limit 35`, [account])).rows;
    const p = await period(c, req); const anchorDay = p.from > p.today ? p.today : p.to < p.today ? p.to : p.today;
    const weeks = (await c.query(`select to_char(w,'IYYY-"W"IW') week,w::date::text "start",count(d.file_id)::int deliveries
      from generate_series(date_trunc('week',$2::date::timestamp) - interval '77 days',date_trunc('week',$2::date::timestamp),interval '7 days') w
      left join pulse.delivery d on d.uploader_account=$1 and d.delivered_at >= (w at time zone ${ORG_TZ})
        and d.delivered_at < ((w + interval '7 days') at time zone ${ORG_TZ}) group by w order by w`, [account, anchorDay])).rows;
    const timeline = (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",d.kind,d.delivered_at "deliveredAt",
      d.rule_detail detail,p.name "projectName",${creditedTo} credited_to,${attributionHow} how from pulse.delivery d join pulse.index_file f using(org_id,file_id)
      join pulse.project p on p.id=d.project_id ${deliveryAttributionJoin} where d.uploader_account=$1 order by d.delivered_at desc limit 60`, [account])).rows;
    const a = (await c.query("select is_shared,holder_person_id from pulse.account where provider='google' and handle=$1", [account])).rows[0];
    return { ...data, account, holder_person_id: a?.is_shared ? null : a?.holder_person_id ?? null,
      sharedLogin: a?.is_shared ?? false, identityVerified: !a?.is_shared && !!a?.holder_person_id, days, weeks, timeline, turnaround: null,
      turnaroundDetail: "Turnaround needs a linked draft start and final handoff. The Drive index provides snapshots only." };
  }));
  // ---- Home dashboard, projects ----
  const acct = "pulse.delivery_matches(d.file_id,$3)";
  async function workHome(c: PoolClient, p: Period, account: string | null) {
    const now = new Date(), todayStart = zoneTime(p.today, p.zone);
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);
    const anchor = new Date(Math.min(now.getTime(), p.end.getTime()));
    const anchorDay = p.from > p.today ? p.today : p.to < p.today ? p.to : p.today;
    const counts = (await c.query(`select
      count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $2)::int deliveries,
      count(*) filter(where d.delivered_at >= $4 and d.delivered_at < $5)::int "deliveriesPrev",
      count(distinct d.project_id) filter(where d.delivered_at >= $1 and d.delivered_at < $2)::int projects,
      count(distinct d.project_id) filter(where d.delivered_at >= $4 and d.delivered_at < $5)::int "projectsPrev",
      count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $2 and d.kind='draft')::int drafts,
      count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $2 and d.kind='final')::int finals,
      count(*) filter(where d.delivered_at >= $6)::int today,
      count(*) filter(where d.delivered_at >= $7 and d.delivered_at < $6)::int yesterday
      from pulse.delivery d where ${acct} and d.delivered_at >= least($4::timestamptz,$7::timestamptz)`,
    [p.start, p.end, account, p.prevStart, p.prevEnd, todayStart, yesterdayStart])).rows[0];
    const usual = Number((await c.query(`select count(*)::numeric/8 usual from pulse.delivery d
      where d.delivered_at >= $1::timestamptz - interval '8 weeks' and d.delivered_at < $1 and pulse.delivery_matches(d.file_id,$2)`,
    [p.start, account])).rows[0].usual);
    const trend = (await c.query(`select to_char(w,'IYYY-"W"IW') week,w::date::text "start",
      count(d.file_id)::int deliveries,count(distinct d.project_id)::int projects
      from generate_series(date_trunc('week',$1::date::timestamp) - interval '77 days',date_trunc('week',$1::date::timestamp),interval '7 days') w
      left join pulse.delivery d on d.delivered_at >= (w at time zone ${ORG_TZ})
        and d.delivered_at < ((w + interval '7 days') at time zone ${ORG_TZ}) and pulse.delivery_matches(d.file_id,$2)
      group by w order by w`, [anchorDay, account])).rows;
    const daily = (await c.query(`select g::date::text "day",count(d.file_id)::int deliveries
      from generate_series($1::date::timestamp - interval '13 days',$1::date::timestamp,interval '1 day') g
      left join pulse.delivery d on d.delivered_at >= (g at time zone ${ORG_TZ})
        and d.delivered_at < ((g + interval '1 day') at time zone ${ORG_TZ}) and pulse.delivery_matches(d.file_id,$2)
      group by g order by g`, [p.today, account])).rows;
    const topProjects = (await c.query(`select p.id "projectId",p.name "projectName",count(*)::int count,
      count(*) filter(where d.kind='draft')::int drafts,count(*) filter(where d.kind='final')::int finals,
      max(d.delivered_at) "lastDeliveredAt" from pulse.delivery d join pulse.project p on p.id=d.project_id
      where d.delivered_at >= $1 and d.delivered_at < $2 and ${acct}
      group by p.id order by count(*) desc,max(d.delivered_at) desc limit 8`, [p.start, p.end, account])).rows;
    // Quiet: delivered during the eight weeks before the anchor, then nothing for 14 days or more.
    const quiet = (await c.query(`select p.id "projectId",p.name "projectName",max(d.delivered_at) "lastDeliveredAt",
      count(*) filter(where d.delivered_at >= $1::timestamptz - interval '56 days')::int recent,count(*) over()::int total
      from pulse.delivery d join pulse.project p on p.id=d.project_id
      where d.delivered_at < $1 and pulse.delivery_matches(d.file_id,$2) group by p.id
      having max(d.delivered_at) < $1::timestamptz - interval '14 days' and max(d.delivered_at) >= $1::timestamptz - interval '56 days'
      order by recent desc,max(d.delivered_at) desc limit 6`, [anchor, account])).rows;
    const recent = (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",p.id "projectId",p.name "projectName",
      d.uploader_account "uploaderAccount",d.kind "deliverableType",d.delivered_at "deliveredAt",d.rule_detail "ruleDetail",f.path,
      coalesce(a.is_shared,false) "sharedLogin",(a.holder_person_id is not null) "identityVerified"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project p on p.id=d.project_id
      left join pulse.account a on a.handle=d.uploader_account and a.provider='google'
      where d.delivered_at < $1 and pulse.delivery_matches(d.file_id,$2)
      order by d.delivered_at desc,d.file_id limit 8`, [p.end, account])).rows;
    return { ...counts, usual, trend, daily, topProjects, recent,
      attention: { total: quiet[0]?.total ?? 0, projects: quiet.map(({ total: _t, ...rest }) => rest) } };
  }
  async function hrHome(c: PoolClient, v: Viewer, p: Period, all: boolean) {
    const enabled = await attendanceEnabled(c);
    const todayStart = zoneTime(p.today, p.zone);
    const entries = enabled ? (await c.query(`select e.id,e.person_id "personId",pe.display_name name,e.checked_in_at "checkedInAt",
      e.checked_out_at "checkedOutAt" from pulse.attendance_entry e join pulse.person pe on pe.id=e.person_id
      where (e.checked_in_at >= $1 or e.checked_out_at is null) and ($2::boolean or e.person_id=$3)
      order by e.checked_in_at desc limit 50`, [todayStart, all, v.person])).rows : [];
    const headcount = (await c.query("select count(*)::int n from pulse.person where status='active' and side='staff'")).rows[0].n;
    const leave = (await c.query(`select l.id,l.person_id "personId",pe.display_name name,l.from_date::text "fromDate",
      l.to_date::text "toDate",coalesce(lt.name,l.leave_kind) kind,l.status,l.created_at "createdAt"
      from pulse.leave_request l join pulse.person pe on pe.id=l.person_id left join pulse.leave_type lt on lt.org_id=l.org_id and lt.key=l.leave_kind
      where ($1::boolean or l.person_id=$2) and (l.status='pending' or (l.status='approved' and l.to_date >= $3::date
        and l.from_date <= $3::date + 14)) order by l.from_date,l.created_at limit 40`, [all, v.person, p.today])).rows;
    return { ...(all && (leadership(v) || v.role === "hr") ? { people: { headcount, ai: (await c.query("select pulse.agent_count() ai")).rows[0].ai } } : {}),
      attendanceEnabled: enabled, attendance: enabled ? { headcount, entries, ownOpen: entries.some(e => e.personId === v.person && !e.checkedOutAt),
        canCheckIn: !!v.person, checkedInToday: new Set(entries.map(e => e.personId)).size,
        present: new Set(entries.filter(e => !e.checkedOutAt).map(e => e.personId)).size } : null,
      leave: { pending: leave.filter(l => l.status === "pending"),
        onLeaveToday: leave.filter(l => l.status === "approved" && l.fromDate <= p.today && l.toDate >= p.today),
        upcoming: leave.filter(l => l.status === "approved" && l.fromDate > p.today) } };
  }
  // "Synced N min ago" is the last refresh that finished without error; upstreamAt is when Drive itself was last read.
  async function syncStatus(c: PoolClient) {
    const ok = (await c.query(`select finished_at "syncedAt",upstream_at "upstreamAt",started_at "startedAt" from pulse.sync_run
      where source in ('ea-drive-index','ea-drive-index-incremental') and ok and finished_at is not null order by finished_at desc limit 1`)).rows[0];
    const last = (await c.query(`select ok,error,started_at "startedAt",finished_at "finishedAt" from pulse.sync_run
      where source in ('ea-drive-index','ea-drive-index-incremental') order by started_at desc limit 1`)).rows[0];
    return { lastIndexedAt: ok?.syncedAt ?? null, upstreamAt: ok?.upstreamAt ?? null, lastRun: last ?? null,
      everyMinutes: Math.round(Number(process.env.PULSE_SYNC_INTERVAL ?? 21600) / 60) };
  }
  /** A cheap stamp the pages poll once a minute: it moves when the index finished a run or anything was written
   *  through this API, and only then does a page reload itself. */
  app.get("/api/v0/freshness", req => tx(req, async c => ({ version: `${await syncVersion(c)}|w${cache.generation}`, ...await syncStatus(c) })));
  // The home figures are reused for a minute per viewer unless the index ran or something was written in between.
  app.get("/api/v0/home", req => tx(req, async (c, v) => {
    const attendance = await attendanceEnabled(c);
    return cache.through(v, req.url, `${await syncVersion(c)}|attendance:${attendance}`, 60_000, async () => {
    const p = await period(c, req);
    // The home depends only on the signed-in account: leadership for admins, HR for HR, own work for everyone else.
    // VISIBLE: HR who also holds leadership keeps the HR home (and gets leadership's cards on it).
    const view = leadership(v) && !v.lead ? "leadership" : v.role === "hr" ? "hr" : "editor";
    const freshness = { ...(await c.query(`select count(*)::int files,count(distinct project_id)::int projects,
      (select count(*)::int from pulse.delivery) deliveries from pulse.index_file`)).rows[0], ...await syncStatus(c) };
    const base = { role: v.role, view, viewer: { name: v.name, email: v.email, pod: v.pod, person: v.person },
      period: publicPeriod(p), freshness, generatedAt: new Date() };
    if (view === "hr") {
      const changes = (await c.query(`select pe.id,pe.display_name name,pp.role,pp.pod,pe.status,pe.created_at "createdAt",
        pe.active_from::text "activeFrom",pe.active_to::text "activeTo" from pulse.person pe
        left join pulse.people_profile pp on pp.person_id=pe.id where pe.side='staff'
        order by greatest(pe.created_at,coalesce(pe.active_to::timestamptz,pe.created_at)) desc,pe.display_name limit 8`)).rows;
      return { ...base, ...await hrHome(c, v, p, true), peopleChanges: changes };
    }
    if (view === "editor") {
      return { ...base, account: v.email, ...await workHome(c, p, v.person?`person:${v.person}`:v.email), ...await hrHome(c, v, p, false) };
    }
    const accounts = (await c.query(`select coalesce(d.uploader_account,'unknown') account,coalesce(a.is_shared,false) "sharedLogin",
      (a.holder_person_id is not null) "identityVerified",pe.display_name person,
      count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $2)::int count,
      count(*) filter(where d.delivered_at >= $3 and d.delivered_at < $4)::int prev,max(d.delivered_at) "lastDelivery"
      from pulse.delivery d left join pulse.account a on a.provider='google' and a.handle=d.uploader_account
      left join pulse.person pe on pe.id=a.holder_person_id
      where d.delivered_at >= least($3::timestamptz,$1::timestamptz - interval '56 days') and d.delivered_at < $2
      group by d.uploader_account,a.is_shared,a.holder_person_id,pe.display_name
      order by count desc,max(d.delivered_at) desc limit 6`, [p.start, p.end, p.prevStart, p.prevEnd])).rows;
    const pods = (await c.query(`select coalesce(pp.pod,'Unassigned') pod,count(*)::int people from pulse.person pe
      left join pulse.people_profile pp on pp.person_id=pe.id where pe.status='active' and pe.side='staff' group by 1 order by 1`)).rows;
    return { ...base, ...await workHome(c, p, null), accounts, pods, ...await hrHome(c, v, p, true) };
    });
  }));
  registerRecordRoutes(app, { tx, open, period, publicPeriod, summary, syncStatus });
  registerHrRoutes(app, { tx });
  registerSelfHistoryRoutes(app, { tx });
  registerSettingsRoutes(app, { tx, syncStatus });
  registerBrandRoutes(app, { tx, open });
  // MAILBOX: a company's own Google Workspace mailbox (Settings → Mail).
  registerMailboxRoutes(app, { tx, open });
  registerInsightRoutes(app, { tx, period, publicPeriod, cache });
  registerMapRoutes(app, { tx });
  registerErpRoutes(app, { tx, open });
  registerQuoteFollowupRoutes(app, { tx });
  registerServiceNotice(app, { tx });
  registerCompRoutes(app, { tx, open });
  registerPayrollRoutes(app, { tx });
  registerPeopleCostRoutes(app, { tx });
  registerBillingSetupRoutes(app, { tx });
  registerTalentRoutes(app, { tx });
  registerRelationshipRoutes(app, { tx });
  registerCompanyRoutes(app, { tx });
  registerPolicyWordRoutes(app, { tx, open });
  registerDriveChangesRoutes(app, { open });
  registerConnectorRoutes(app, { tx });
  registerDriveTextRoutes(app, { tx });
  registerTaskLifeRoutes(app, { tx });
  registerTaskCompanionRoutes(app, { tx });
  registerTaskRoutes(app, { tx });
  registerOrgRoutes(app, { tx });
  registerPoolProposalRoutes(app, { tx });
  registerSopRoutes(app, { tx });
  registerWorkflowRoutes(app, { tx });
  registerWorkflowBoardRoutes(app, { tx });
  registerFormRoutes(app, { tx });
  registerTaskFocusRoutes(app, { tx });
  registerWorkRoutes(app, { tx });
  registerWorkDomainRoutes(app, { tx });
  registerWorkScorecardRoutes(app, { tx });
  registerProjectHealthRoutes(app, { tx });
  registerProjectRunRoutes(app, { tx });
  registerProjectQuoteRoutes(app, { tx });
  registerProjectPlanRoutes(app, { tx });
  registerProjectShareRoutes(app, { tx, open });
  registerWorkViewRoutes(app, { tx });
  registerPeopleWork(app, { tx });
  registerPresenceOnboardRoutes(app, { tx });
  registerLifecycleRoutes(app, { tx });
  registerPeopleValueRoutes(app, { tx });
  registerMyPulseRoutes(app, { tx });
  registerSearchRoutes(app, { tx });
  registerNetworkRoutes(app, { tx });
  registerLicenceRoutes(app, { tx });
  registerPulseHqRoutes(app, { tx });
  // PULSE-ADMIN (1140): the platform admin console (platform admins only, checked in the database too).
  registerPlatformAdminRoutes(app, { tx, pool });
  registerStackRoutes(app, { tx });
  registerStoryRoutes(app, { tx });
  registerProductMapRoutes(app, { tx, open, pool });
  registerReviewGroups(app, { tx });
  return { tx };
}
