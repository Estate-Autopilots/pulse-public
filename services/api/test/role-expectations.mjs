const staff=r=>['hr','leadership','admin'].includes(r),lead=r=>['leadership','admin'].includes(r);
export function denied(role,method,url){
 if(url.startsWith('/api/v0/customers/')||url.startsWith('/api/v0/site-visits/'))return role==='hr';
 if(url.startsWith('/api/v0/integrations/keys'))return role!=='admin';
 if(method==='HEAD')method='GET';
 if(url==='/api/v0/licences'||url==='/api/v0/licences/referrals')return !['leadership','admin'].includes(role); // LICENCES (+ FEATURES-1024 referrals): the platform leaders only.
 // PULSE-HQ: an organisation-only module (modules.ts ORG_ONLY), on only in the Pulse organisation (0944): in the matrix's
 // organisation every role gets 404 like an unknown route. Inside Pulse, leaders change the catalogue, offers and brand;
 // everyone reads, adds ideas and votes (services/api/src/pulse-hq.ts).
 if(url==='/api/v0/hq'||url.startsWith('/api/v0/hq/'))return false;
 // PULSE-HQ (0947): what Pulse can do, read only, for every person of every organisation.
 if(url==='/api/v0/features')return false;
 // TELEMETRY (0983): every signed-in person sends their own movements; leadership and admins read the overview and timelines.
 if(url==='/api/v0/telemetry'&&method==='POST')return false;
 if(url==='/api/v0/telemetry'||url==='/api/v0/telemetry/sessions/:id')return !lead(role);
 // PULSE-HQ (0973): Stack Intelligence, for every organisation: everyone reads, adds and edits tools and stacks, copies a
 // shared stack and saves their own sheet views; leaders remove tools and stacks and share or publish a stack.
 if(['/api/v0/stack/tools/:id/remove','/api/v0/stack/stacks/:id/remove','/api/v0/stack/stacks/:id/share','/api/v0/stack/stacks/:id/unshare'].includes(url))return !lead(role);
 if(url==='/api/v0/stack'||url.startsWith('/api/v0/stack/'))return false;
 // FEATURES-1024: Product Story, for every organisation: everyone reads, adds and edits products and versions; leaders remove.
 if(['/api/v0/story/products/:id/remove','/api/v0/story/versions/:id/remove'].includes(url))return !lead(role);
 if(url==='/api/v0/story'||url.startsWith('/api/v0/story/'))return false;
 // PRODUCT-MAP (1010): the Product map, for every organisation: everyone reads, connects sources, edits and plans; leaders
 // remove sources, screens found in code, features and user types, and manage tokens (whoever added a journey, idea or
 // proposed screen may remove it: decided in the handler). The feed takes a Product map token only (401 for a session).
 if(['/api/v0/product-map/sources/:id/remove','/api/v0/product-map/features/:id/remove','/api/v0/product-map/personas/:id/remove','/api/v0/product-map/products/:id/tokens','/api/v0/product-map/tokens/:id/revoke'].includes(url))return !lead(role);
 if(url==='/api/v0/product-map'||url.startsWith('/api/v0/product-map/'))return false;
 if(url==='/api/v0/sheet-views'||url.startsWith('/api/v0/sheet-views/'))return false;
 if(url==='/api/v1/updates/:id/open')return false; // EST-1539: any staff role may open; the audience is decided per row (404 outside it).
 if(method==='POST'&&url==='/api/v1/updates/:id/reply')return false; // EST-1662: audience membership, not role, gates replies; valid fixtures cover the 404 refusals.
 // EST-1035: agent routes take an AI co-worker's key only; every person's session gets 401 (access-matrix-runner).
 // GROUPS-HUB (1018): the groups hub. Every person reads it, asks AI employees in their groups and works the review
 // queue; what may change in a group is decided per group in the database (chat_group_manages). Leaders re-read every name.
 if(url==='/api/v0/chats/hub/classify')return !lead(role);
 if(url==='/api/v0/chats/hub'||url.startsWith('/api/v0/chats/hub/'))return false;
 if(url.startsWith('/api/v0/agent/'))return false;
 // EST-1733: leaders read the AI employees; a profile shows only where the AI employee already appears to the viewer,
 // decided in the database (agent_profile; ai-employee-runner.mjs): anywhere else, and for a missing one, it answers 404.
 if(url==='/api/v0/agents/team')return !lead(role);
 // FEATURES-1024 (0988): AI spend (leaders for the organisation, its managers for one), engines (like settings), the org's engine settings (leaders).
 if(url==='/api/v0/agents/spend'||url==='/api/v0/agents/engine-settings')return !lead(role);
 // 0988: an AI employee's spend is hidden (404, like its profile and detail) from whoever may not manage it, so the GET
 // is not a 403 refusal; choosing its engines is refused (403/404) for anyone but HR, leaders and admins.
 if(url==='/api/v0/agents/:id/spend'&&method==='GET')return false;
 if(url==='/api/v0/agents/:id/engines')return !staff(role);
 if(url==='/api/v0/agents/:id'&&method==='GET')return false;
 // CHAT-WORK (62908ef3): the profile's detail (settings, notes, runs, tasks) follows the same rule (agent_detail): 404 elsewhere.
 if(url==='/api/v0/agents/:id/detail'&&method==='GET')return false;
 // UI-UPGRADE (0990): its runs a page at a time follow agent_detail's rule; a retry, agent_manage_ok's (like its settings).
 if(url==='/api/v0/agents/:id/runs'&&method==='GET')return false;
 if(url==='/api/v0/agents/:id/runs/:run/retry')return !staff(role);
 // AI-EMPLOYEES v2: admins, HR and leadership change an AI employee (its manager too, decided in the database:
 // agent_manage_ok); its approver sends or drops its proposal (anyone else 404, agent_proposal_decide); leaders set a
 // project's coordinators.
 if(url==='/api/v0/agents/:id/settings'||url==='/api/v0/agents/:id/memory'||url==='/api/v0/agents/:id/group-approver')return !staff(role); // FEATURES-1024: group-approver like settings
 if(url==='/api/v0/chats/proposals/:id/decide')return false;
 if(url==='/api/v0/projects/:id/coordinators')return !lead(role);
 // CONNECT-AI: Settings → AI (subscriptions, API keys, agent workspaces) is for admins and leadership; HR also reads the
 // connections by name (no secret) to choose an AI employee's AI on its profile.
 if(url==='/api/v0/ai/choices')return !staff(role);
 if(url==='/api/v0/ai'||url.startsWith('/api/v0/ai/'))return !lead(role);
 if(url.startsWith('/api/v0/agents'))return role!=='admin'; // admins list co-workers, revoke keys, switch them
 if(url==='/api/v0/chats/handoffs/:id/decide'||url==='/api/v0/chats/:id/agents')return !lead(role); // leaders steer co-workers
 // PULSE-NETWORK (EST-1038/1026/1027): leaders only (403 first); /status tells anyone whether it is on.
 if(url.startsWith('/api/v0/network/'))return url!=='/api/v0/network/status'&&!lead(role);
 // CONNECT (0953): every person reads their organisation's connections and the groups shared with them, and accepts a
 // client link with their own account; admins, HR and leadership send and withdraw client requests; groups and tasks for a
 // connection are decided per connection in the database (an unknown one answers 404).
 if(['/api/v0/connections','/api/v0/connections/shared-chats','/api/v0/account/connect-accept'].includes(url))return false;
 // ORG part 1 (3f2c08d8): one Pulse account across organisations. Its own handle, password, links, switch, start, accept,
 // portable profile, sharing, highlights and carried badges are the signed-in person's own; invitations are for admins,
 // HR and leadership (org_invite_create/revoke); a badge comes from leaders, HR or the person's manager (org_badge_give).
 if(url==='/api/v0/account/invites'||url==='/api/v0/account/invites/:id/revoke')return method!=='GET'&&!staff(role); // the list is empty for anyone else
 if(url==='/api/v0/people/:id/badges')return role==='person';
 if(url.startsWith('/api/v0/account/'))return false;
 if(url.startsWith('/api/v0/connections/requests'))return !staff(role);
 // Points of contact (0957): admins, HR and leadership add or remove their own side's contacts; decided per connection in the
 // database, which answers 404 for an unknown connection before it checks the role.
 if(url==='/api/v0/connections/:id/contacts'||url==='/api/v0/connections/:id/contacts/:seatId/remove')return false;
 if(url.startsWith('/api/v0/connections/:id/'))return false;
 if(url==='/api/v0/companion/ack')return true;
 if(['/api/v0/companion/read','/api/v0/companion/snooze','/api/v0/companion/notification-settings','/api/v0/companion/web-push','/api/v0/companion/notification-test'].includes(url))return false;
 // UX-NOTIFY: the notification panel reads and marks the viewer's own outbox only.
 if(['/api/v0/notices','/api/v0/notices/read','/api/v0/notices/read-all'].includes(url))return false;
 if(url==='/api/v0/notifications/payroll-access')return role!=='admin';
 if(url==='/api/v0/notifications/payroll-processed')return false; // Default-off gate; valid accounts grants are tested in R27's disposable fixture.
 if(url==='/api/v0/companion/presence')return true; // Web-role fixtures lack the required authorized native device.
 // R15d: anyone sends feedback and reads their own wallet; the app team (admin, leadership) triages feedback and testers.
 if(['/api/v0/feedback','/api/v0/companion/wallet','/api/v0/companion/late-dispute'].includes(url)&&(method==='POST'||url!=='/api/v0/feedback'))return false;
 if(url==='/api/v0/feedback'||url.startsWith('/api/v0/feedback/')||url.startsWith('/api/v0/testers'))return !lead(role);
 if(/^\/api\/v0\/(native|devices|sensing|events)(\/|$)/.test(url))return url==='/api/v0/devices/policy'&&method==='POST'&&role!=='admin';
 if(url.startsWith('/api/v0/fair-work'))return method==='GET'&&role==='hr';
 if(url==='/api/v0/admin/auth-policy'||url.startsWith('/api/v0/admin/client-accounts'))return role!=='admin';
 if(url.startsWith('/api/v0/admin/auth-history'))return !['hr','admin'].includes(role);
 if(['/api/v0/hr/flows','/api/v0/hr/work-calendar','/api/v0/hr/work-days','/api/v0/hr/flows/:id/decision'].includes(url))return false;
 if(['/api/v0/hr/attendance-close-policy','/api/v0/hr/flow-settings','/api/v0/hr/pod-heads','/api/v0/hr/cofounders','/api/v0/hr/work-patterns'].includes(url))return !staff(role);
 if(['/api/v0/hr/rules','/api/v0/hr/rules/preview','/api/v0/hr/rules/confirm','/api/v0/hr/rules/waive','/api/v0/hr/employment/:id'].includes(url))return !staff(role);
 if(url==='/api/v0/hr/payslip/:id')return !staff(role); // Matrix target differs from the viewer; self reads have valid fixtures in R19b.
 if(['/api/v0/leave/notice','/api/v0/leave/emergencies','/api/v0/leave/emergency'].includes(url))return false; // Scoped to the signed-in employee; inactive rules reject emergency creation.
 if(url.startsWith('/api/v0/auth/'))return false;
 // UX-TENANT: companies are set up by the platform operator (an individual admin of the install's own company, which
 // the matrix world is); the host lookup is public; the module switches are read by everyone and changed by admins.
 if(url.startsWith('/api/v0/tenants'))return role!=='admin';
 if(url==='/api/v0/host'||(url==='/api/v0/settings/modules'&&method==='GET'))return false;
 if(url.startsWith('/api/v0/acquisition'))return method==='GET'&&role==='hr'&&!url.includes('/webhook/'); // Valid intake, contact and finance boundaries are in the Round 12 fixture.
 if(url.startsWith('/api/v0/delivery'))return false; // Valid delivery boundaries are exercised by the Round 11 tenant suite.
 // RF1 membership administration follows invitation administration; existing finance grants are unchanged.
 if(url==='/api/v0/finance/desk/accountants')return role!=='admin';
 if(url.startsWith('/api/v0/finance'))return role!=='leadership';
 // ERP-INVOICE: invoicing reads and writes follow the money grants (leadership; the admin fixture holds none) and the
 // Finance role (tests/core/test_erp_invoice.py covers it and the Accountant's read-only access).
 if(url.startsWith('/api/v0/erp'))return role!=='leadership';
 // EST-1238: a quotation's follow-up is answered by its salesperson or an ERP writer, decided per quotation in the
 // database (0520 erp_followup_answer; tests/core/test_quote_followups.py checks the salesperson, finance and another person).
 if(url==='/api/v0/quotes/:id/follow-up')return false;
 if(url==='/api/v0/auth-review')return !staff(role);
 // R47: importing WhatsApp history is for admins (the database also requires membership of the target); reading it is
 // for the conversation's members, decided in the database (tests/core/test_chat_history_import.py): an unknown
 // conversation answers 404 to everyone.
 if(url.startsWith('/api/v0/chats/imports'))return role!=='admin';
 if(url==='/api/v0/chats/:id/history')return false;
 // WA-IMPORT (1015): imported WhatsApp chats are read by their staff members and admins, decided in the database
 // (pulse.wa_reader; tests/core/test_wa_import.py): an unknown chat or file answers 404 to everyone. Every import's
 // provenance is for admins; withdrawing is too (decided in the database).
 if(url==='/api/v0/chats/whatsapp/batches')return role!=='admin';
 // WA-IMPORT (1016): signals across chats (complaints, churn risk, upsell …) are for leadership and admins.
 if(url==='/api/v0/chats/whatsapp/signals')return !lead(role);
 if(url==='/api/v0/chats/whatsapp'||url.startsWith('/api/v0/chats/whatsapp/'))return false;
 // CHAT-VOICE (87b6d999): any staff member starts a call; who is in a call is decided per call (pulse.chat_call, 404 elsewhere).
 if(url==='/api/v0/calls'||url.startsWith('/api/v0/calls/'))return false;
 // R48: a person's skills and reviewed CV are read by the person, their manager or pod head, HR and admins (the matrix
 // target is another member, whom manager and pgs manage); the person alone writes their profile and previews or keeps
 // their CV; HR and admins look after the list and the scale. Single claims, verifications and entries are decided per
 // row in the database (tests/core/test_structured_skills.py, services/api/test/skills-runner.mjs).
 if(['/api/v0/people/:id/skills','/api/v0/people/:id/cv','/api/v0/people/:id/cv/export'].includes(url)&&method==='GET')return ['person','leadership'].includes(role);
 if(['/api/v0/people/:id/skills','/api/v0/people/:id/experience','/api/v0/people/:id/cv','/api/v0/people/:id/cv/preview'].includes(url))return true;
 if(['/api/v0/skills/setup','/api/v0/skills/local','/api/v0/skills/names','/api/v0/skills/names/:id/withdraw','/api/v0/skills/scale'].includes(url))return !['hr','admin'].includes(role);
 if(url.startsWith('/api/v0/skills/'))return false;
 // R49: how matching works is published to everyone; a person reads and answers their own checks (decided per row in
 // the database); HR alone accepts the weights; jobs, candidates, picks and checks are HR's and admins'
 // (tests/core/test_internal_ats.py, services/api/test/ats-runner.mjs).
 if(['/api/v0/ats/method','/api/v0/ats/my-checks','/api/v0/ats/checks/:id/answer'].includes(url))return false;
 if(url==='/api/v0/ats/accept')return role!=='hr';
 if(url.startsWith('/api/v0/ats/'))return !['hr','admin'].includes(role);
 // R50: whether the coach is on and its contract are published to everyone; admins configure it; HR and admins preview,
 // ask and decide (tests/core/test_coach_seam.py, services/api/test/coach-runner.mjs).
 if(['/api/v0/coach/status','/api/v0/coach/contract'].includes(url))return false;
 if(url==='/api/v0/coach/config')return role!=='admin';
 if(url.startsWith('/api/v0/coach/'))return !['hr','admin'].includes(role);
 // COMP-A: individuals' pay is for the HR and leadership roles (the admin fixture holds no salary permission); the
 // matrix target is another member. One's own pay, claims, offer answers and probation reviews are decided per row in
 // the database (tests/core/test_comp.py, services/api/test/comp-runner.mjs). The policy reads for everyone.
 if(url==='/api/v0/comp/me'||(url==='/api/v0/comp/policy'&&method==='GET')||url.startsWith('/api/v0/comp/claims')||url==='/api/v0/comp/offers/:id/answer'||url==='/api/v0/comp/reviews/:id'
  ||url.startsWith('/api/v0/comp/letters/')||(url==='/api/v0/comp/settlements/:id'&&method==='GET'))return false;
 // COMP-B: a person's own payslips are decided per row in the database (tests/core/test_payroll.py); the rest of
 // payroll, the ledger, the budget and scenarios are for the HR and leadership roles like the rest of /comp/.
 if(url.startsWith('/api/v0/comp/payslips/')||url==='/api/v0/comp/people/:id/payslips')return false;
 if(url.startsWith('/api/v0/comp/'))return !['hr','leadership'].includes(role);
 // R52: a company's connectors are its admins' alone (tests/core/test_company_connectors.py, connectors-runner.mjs).
 if(url==='/api/v0/connectors'||url.startsWith('/api/v0/connectors/'))return role!=='admin';
 // R53: a company's setup checklist is its admins' and HR's to read; its admins register and decide sources.
 if(url==='/api/v0/company-setup')return !['admin','hr'].includes(role);
 // R54: the pilot's checks are its admins' and HR's (HR alone signs off the walkthrough, in the database); everyone
 // answers the pilot feedback once (tests/core/test_tenant_pilot.py).
 if(url==='/api/v0/company-setup/pilot-checks')return !['admin','hr'].includes(role);
 if(url==='/api/v0/pilot-feedback')return false;
 if(url.startsWith('/api/v0/company-setup/'))return role!=='admin';
 if(method==='GET'){
  // R45: captured Drive text is decided per root audience in the database; unknown roots and files answer 404.
  if(url==='/api/v0/drive-text/:source/:file')return false;
  if(url==='/api/v0/hr/rules')return !staff(role);
  if(url==='/api/v0/hr/payslip/:id')return !staff(role);
  if(url.startsWith('/api/v0/client-master')||url.startsWith('/api/v0/contact-identity'))return role==='hr';
  if(url==='/api/v0/research/growth')return !lead(role);
  if(url==='/api/v0/money/ad-spend')return role!=='leadership';
  if(url==='/api/v0/research'||url==='/api/v0/research/clients')return role==='hr';
  if(url==='/api/v0/projects/:id/calls')return !lead(role)&&!['manager','pgs'].includes(role);
  if(url==='/api/v0/settings/site-visit')return method==='GET'?role==='hr':role!=='admin'; // EST-1407: customer-facing roles read; only admins save
  if(url.startsWith('/api/v0/creative'))return role==='hr'; // EST-1474: work data; HR-only accounts are refused
  if(url==='/api/v0/sales-home')return role==='hr'; // EST-1240: the viewer's own tasks and quotations; HR-only accounts are refused
  if(url.startsWith('/api/v0/sales-xray'))return false; // EST-1363: each staff person's own Sales X-Ray connection (accountants are refused)
  if(['/api/v0/settings','/api/v0/settings/screens','/api/v0/accounts','/api/v0/company/imports','/api/v0/opshub','/api/v0/notifications/connections'].includes(url))return role!=='admin';
  if(url==='/api/v0/chat-names')return !['leadership','hr'].includes(role); // EST-1542: leadership and HR match WhatsApp names
  if(['/api/v0/admin/access','/api/v0/admin/invitations'].includes(url))return !['hr','admin'].includes(role);
  if(['/api/v0/insights','/api/v0/leadership-week'].includes(url))return !lead(role);
  if(url==='/api/v0/audit')return role!=='admin'; // MODULES-1024: audit rows are admin-only (RLS 0011); leaders without admin are refused at once
  if(url==='/api/v0/money')return !lead(role); // admin fixture has no finance grants: separately checked below
  if(['/api/v0/hr/desk','/api/v0/hr/attendance','/api/v0/hr/leave','/api/v0/hr/payroll','/api/v0/shifts','/api/v0/review-data','/api/v0/review-data/groups','/api/v0/review-data/attention','/api/v0/hr/policy-attention'].includes(url))return !staff(role);
  // PEOPLE-LIVE: everyone may open a person's work; the response says what the viewer may see (RLS on the links).
  if(url==='/api/v0/people/:id/work')return false;
  if(url==='/api/v0/people/:id/hr')return !staff(role);
  if(url==='/api/v0/hr/person/:id')return !staff(role)&&!['manager','pgs'].includes(role);
  // PRESENCE-ONBOARD: HR's check-in settings and Onboard team are for HR, leadership and admins; one's own day,
  // onboarding and files are decided per person and document in the database.
  if(url==='/api/v0/hr/checkin-settings'||url==='/api/v0/hr/onboard')return !staff(role);
  // PEOPLE-CONTACTS: someone's My info opens for HR, leadership and admins (bank details inside only for HR, in the
  // database); an IFSC's bank and branch are public reference data.
  if(url==='/api/v0/people/:id/info')return !staff(role);
  if(url==='/api/v0/ifsc/:code')return false;
  // RT1: HR has tasks of their own (policy items, roster), so the task list is no longer work data closed to HR.
  if(url==='/api/v0/tasks/blocking')return !staff(role);
  // TASKS-P0: the biggest blockers (most value waiting) are leadership's and HR's, like the blocker list.
  if(url==='/api/v0/tasks/biggest-blockers')return !staff(role);
  // UX-TASKS: the filing review is for leadership and HR; the team dashboard for leadership, HR and pod heads.
  if(url==='/api/v0/work/review')return !staff(role);
  if(url==='/api/v0/work/dashboard')return role==='person';
  // LIFECYCLE: People moves and its checklists are for HR, leadership and admins; a person's own moves open per viewer.
  if(url.startsWith('/api/v0/lifecycle'))return !staff(role);
  if(url==='/api/v0/people/:id/lifecycle')return false;
  // READY (0972): Hiring (jobs and their candidates, interviews) is HR's and admins' (lifecycle.ts actor).
  if(url.startsWith('/api/v0/hiring/'))return !['hr','admin'].includes(role);
  // LIFECYCLE parts 2–4: value and cost read like salaries: HR and leadership, admins only with the salary permission
  // (no matrix fixture holds it; test_lifecycle_value covers it); one's own value and best-fit people are everyone's;
  // seats are leadership's; staffing gaps HR's too.
  if(url==='/api/v0/value')return !['hr','leadership'].includes(role);
  if(url==='/api/v0/value/mine'||url==='/api/v0/fit')return false;
  if(url==='/api/v0/seats'||url==='/api/v0/seats/:id')return !lead(role);
  if(url==='/api/v0/staffing-gaps')return !staff(role);
  if(url==='/api/v0/me/pulse')return false; // LIFECYCLE: everyone's own home
  if(url==='/api/v0/hr/self/history')return false; // R43: everyone's own history; it takes no person to guess
  // UX-TASKS-2: link suggestions wait for leadership (HR reads them); everything else in Work is decided per person and task.
  if(url==='/api/v0/work/links/review')return !staff(role);
  if(url==='/api/v0/work/pool/proposals')return !staff(role); // TASKS-3: proposed pool work, for leadership and HR
  if(url==='/api/v0/map/review')return role!=='admin'; // R55: the geocode review queue is the organisation admins'
  if(['/api/v0/projects','/api/v0/clients','/api/v0/contacts','/api/v0/editors','/api/v0/pod-board','/api/v0/activity','/api/v0/tracking-signals','/api/v0/map','/api/v0/my-week'].includes(url))return role==='hr';
  if(/^\/api\/v0\/(clients|contacts|projects|editors|map)\//.test(url))return role==='hr';
  // R55: the talent board and a model's profile are work data (HR-only accounts are refused); fees are decided in the
  // database (leadership with finance grants; tests/core/test_talent_index.py covers them).
  if(url==='/api/v0/talent'||url==='/api/v0/talent/:id')return role==='hr';
  // R46: the relationship graph is work data (HR-only accounts are refused); reviewer grants and setup are the admins'.
  if(url==='/api/v0/relationships/setup')return role!=='admin';
  if(url.startsWith('/api/v0/relationships'))return role==='hr';
  // SOP-WORKFLOW: active SOPs are everyone's to read; what Drive holds is leadership's and admins' to bring in.
  if(url.startsWith('/api/v0/sops/drive'))return !lead(role);
  return false;
 }
 // UX-TASKS: everyone creates, asks, comments and follows; the database decides per task and project who may assign,
 // create projects or answer an ask. HR and admins change the rules; leadership files projects and edits packages.
 // LIFECYCLE: HR and admins record moves, run checklists and decide reviews (Workspace ticks: admins, in the database).
 if(url.startsWith('/api/v0/lifecycle/'))return !['hr','admin'].includes(role);
 if(url.startsWith('/api/v0/hiring/'))return !['hr','admin'].includes(role); // READY (0972): jobs ↔ candidates, interviews
 if(url==='/api/v0/seats/:id/holders')return !lead(role);
 // LIFECYCLE: everyone thanks colleagues and asks HR to correct what Pulse knows about them; the receiver or HR hides kudos.
 if(['/api/v0/kudos','/api/v0/kudos/:id/hide','/api/v0/me/corrections'].includes(url))return false;
 // TASKS-3: HR and admins set reporting lines and confirm proposals; leadership may also look for them.
 if(url.startsWith('/api/v0/work/pool/proposals')||url.startsWith('/api/v0/work/pool/batches'))return !lead(role); // leadership fills the pool
 if(url==='/api/v0/org/suggest')return !['hr','admin','leadership'].includes(role);
 if(url.startsWith('/api/v0/org/'))return !['hr','admin'].includes(role);
 if(url==='/api/v0/work/rules')return !['hr','admin'].includes(role);
 if(url==='/api/v0/work/review/:id'||url==='/api/v0/work/package/:id')return !lead(role);
 // UX-TASKS-2: leadership and admins name the business model and look for links; HR and admins name kinds of work; the
 // Google capture seam is for admins (and the collector). Domains, the pool and value are decided per person and task.
 if(url==='/api/v0/work/settings'||url==='/api/v0/work/links/detect')return !lead(role);
 if(url==='/api/v0/work/categories')return !['hr','admin'].includes(role);
 if(url==='/api/v0/work/links/capture')return role!=='admin';
 // TASKS-P0: leadership and admins name the company's project categories; a project's style is decided per project.
 if(url==='/api/v0/work/project-categories')return !lead(role);
 if(url.startsWith('/api/v0/work/'))return false;
 // R46: admins name reviewers, record the owner's definition of models and read the sources; deciding is per reviewer
 // and kind in the database (tests/core/test_relationship_graph.py); suggesting is everyone's who works on projects.
 if(['/api/v0/relationships/reviewers','/api/v0/relationships/models','/api/v0/relationships/refresh'].includes(url))return role!=='admin';
 if(url.startsWith('/api/v0/relationships/'))return role==='hr';
 // SOP-WORKFLOW: leadership and admins make, import and change SOPs.
 if(url.startsWith('/api/v0/sops'))return !lead(role);
 // SOP-WORKFLOW part 2: leadership and admins design workflows; leadership, HR, pod heads and project owners start runs;
 // answering an approval, giving a step to someone and stopping a run are decided per run and step in the database.
 if(url==='/api/v0/workflows/:id/start')return role==='person';
 if(['/api/v0/workflows/runs/:id/cancel','/api/v0/workflows/steps/:id/decide','/api/v0/workflows/steps/:id/assign','/api/v0/workflows/steps/:id/check'].includes(url))return false; // WORKFLOW BUILDER: whoever does a step ticks its checklist
 if(url.startsWith('/api/v0/workflows'))return !lead(role);
 // SOP-WORKFLOW part 3: leadership and admins build forms, install templates and void a sent form; sending a form is
 // decided per form and step in the database (whoever does the step, or anyone for a live form outside a workflow).
 if(url==='/api/v0/forms/submit')return false;
 if(url.startsWith('/api/v0/forms'))return !lead(role);
 // RT1: everyone manages their own tasks and time; who may change which task is decided per task in the database.
 if(url==='/api/v0/tasks/:id/review-agreement')return role!=='admin';
 if(url==='/api/v0/tasks/link-tracker')return !lead(role);
 if(url.startsWith('/api/v0/tasks')||url.startsWith('/api/v0/time')||url.startsWith('/api/v0/kpis/'))return false;
 if(url==='/api/v0/people/:id/work-terms')return !['hr','admin'].includes(role);
 if(url==='/api/v0/hr/pods')return !staff(role);
 if(url.startsWith('/api/v0/client-master/')||url.startsWith('/api/v0/contact-identity/'))return role!=='admin';
 if(url==='/api/v0/briefs/preferences'||url==='/api/v0/intelligence/:id/decision')return false;
 if(['/api/v0/auth/sign-in','/api/v0/auth/forgot','/api/v0/auth/set-password','/api/v0/auth/change-password','/api/v0/auth/sign-out'].includes(url))return false;
 if(url==='/api/v0/research/leads/:id/touch')return !lead(role)&&!['manager','pgs'].includes(role);
 if(url.startsWith('/api/v0/sales-xray/'))return false; // EST-1363: a staff person's own Sales X-Ray connection; nothing reaches Sales X-Ray without its address
 if(url.startsWith('/api/v0/creative/'))return !['admin','leadership','manager','pgs'].includes(role); // EST-1474: starting a sprint; a missing sprint answers 404
 if(url==='/api/v0/chat-names/load')return !['admin','leadership','hr'].includes(role); // EST-1542 B (0680): leadership, HR and admins load names
 if(url==='/api/v0/chat-names/:id')return !['leadership','hr'].includes(role); // a missing name answers 404 to them
 if(url.startsWith('/api/v0/settings/')||url==='/api/v0/groups/mapping'||url==='/api/v0/notifications/connect')return role!=='admin';
 if(['/api/v0/performance/events','/api/v0/review-data/rules','/api/v0/review-data/gaps'].includes(url))return role!=='admin';
 if(['/api/v0/hr/policies','/api/v0/hr/policies/draft','/api/v0/hr/policies/publish'].includes(url))return !staff(role);
 // R41: Word files and editor sessions are HR's; the editor itself stays off until a provider is approved and configured.
 if(['/api/v0/hr/policies/docx','/api/v0/hr/policies/:id/docx','/api/v0/hr/policies/word-session'].includes(url))return !staff(role);
 if(['/api/v0/hr/rules/preview','/api/v0/hr/rules/confirm','/api/v0/hr/rules/waive','/api/v0/hr/employment/:id',
   '/api/v0/leave/emergency','/api/v0/hr/payslip/:id'].includes(url))return !staff(role);
 if(url==='/api/v0/hr/policies/acknowledge')return false;
 if(url==='/api/v0/presence')return false; // CHATS-2: everyone sets their own status line and do-not-disturb
 // PRESENCE-ONBOARD: HR and admins decide check-in settings, nudges and which documents to ask for; only the HR role
 // checks ID documents (admins need hr.documents.read). Everything else is one's own, or HR's for someone, decided per
 // person, event and document in the database.
 if(['/api/v0/hr/checkin-settings','/api/v0/hr/onboard/nudge','/api/v0/hr/onboard/kinds'].includes(url))return !['hr','admin'].includes(role);
 if(url==='/api/v0/onboarding/documents/:id/check')return role!=='hr';
 // PEOPLE-CONTACTS: someone else's about/pronouns: HR and admins; bank details are opened and checked by the HR role
 // only (the person themself too: tests/core/test_people_contacts.py); HR and admins decide name and birth-date
 // requests; everyone asks for and withdraws their own.
 if(url==='/api/v0/people/:id/info')return !['hr','admin'].includes(role);
 if(url==='/api/v0/people/:id/bank/reveal'||url==='/api/v0/people/:id/bank/confirm')return role!=='hr';
 if(url==='/api/v0/profile-changes/:id')return !['hr','admin'].includes(role);
 if(url==='/api/v0/me/changes'||url==='/api/v0/profile-changes/:id/withdraw')return false;
 if(url==='/api/v0/attendance/events/:id/dispute'||url.startsWith('/api/v0/onboarding/'))return false;
 // ATT: everyone answers Pulse's question about their own session; HR settles exceptions.
 if(url==='/api/v0/attendance/answer')return false;
 if(url==='/api/v0/hr/attendance/exceptions/:id')return !['hr','admin','leadership'].includes(role);
 if(url==='/api/v0/corrections/suggest')return false; // anyone with their own sign-in suggests; admins apply
 if(['/api/v0/admin/onboarding/run','/api/v0/admin/onboarding/receipt'].includes(url))return role!=='admin';
 if(url.startsWith('/api/v0/admin/')||url==='/api/v0/people/:id/login')return !['hr','admin'].includes(role);
 if(['/api/v0/people','/api/v0/people/:id','/api/v0/people/:id/hr-contact','/api/v0/people/:id/flags/:flag','/api/v0/people/:id/salary','/api/v0/hr/leave-adjustments','/api/v0/hr/policy','/api/v0/hr/presence','/api/v0/hr/leave-types','/api/v0/hr/holidays','/api/v0/hr/imported-history','/api/v0/shifts','/api/v0/review-data/decide','/api/v0/review-data/decide-group','/api/v0/people/work/decide','/api/v0/people/work/group'].includes(url))return !staff(role);
 if(url==='/api/v0/people/:id/photo'||url==='/api/v0/people/:id/self')return !staff(role); // target is a different person
 if(url.startsWith('/api/v0/chats/')||['/api/v0/chats/direct','/api/v0/attendance/check-in','/api/v0/attendance/check-out','/api/v0/attendance/break','/api/v0/leave','/api/v0/leave/:id/decision','/api/v0/hr/regularisations','/api/v0/hr/regularisations/:id','/api/v0/hr/tickets','/api/v0/hr/tickets/:id','/api/v0/notifications/read','/api/v0/audit/events','/api/v0/inbox/send','/api/v0/projects/:id/upload'].includes(url))return false;
 if(url.startsWith('/api/v0/money/'))return !lead(role);
 if(url==='/v1/deliveries/:id/claim')return role==='hr';
 if(url==='/v1/deliveries/:id/claim/decide')return !['admin','manager','pgs'].includes(role);
 if(url==='/v1/designs/claimable')return !['person','manager'].includes(role);
 if(url==='/v1/designs/:id/claim')return !['person','manager'].includes(role);
 if(url==='/v1/designs/claims')return !['admin','manager','pgs'].includes(role);
 if(url==='/v1/accounts/:id/claim')return false;
 if(['/v1/accounts/:id/claim/decide','/v1/accounts/:id/claim/revert'].includes(url))
  return !['admin','hr','manager','pgs'].includes(role);
 // R55: invoice parties on the map are linked by leadership with finance grants (the admin fixture holds none).
 // PEOPLE-CONTACTS: everyone on the team (not HR-only accounts) writes notes about contacts; the author or an admin
 // removes one (decided in the database); linking a contact to a project or client is for admins.
 if(url==='/api/v0/contacts/:id/notes'||url==='/api/v0/contacts/notes/:id/remove')return role==='hr';
 if(url==='/api/v0/map/money/party'||url==='/api/v0/map/money/check')return role!=='leadership';
 if(/^\/api\/v0\/(projects|clients|contacts|tasks|files|records|record-links|stewardship|opshub|map)/.test(url)||url==='/api/v0/people/:id/accounts')return role!=='admin';
 // FLOW (A–E): leadership and admins design processes, company blocks and record types, try them, and choose the
 // company's industry, words, roles and apps; HR also names who holds a role. Starting a run, acting on its steps and
 // records, and Pip on a step are decided per run and step in the database (a missing one answers 404).
 if(url.startsWith('/v1/flow/')){
  if(url==='/v1/flow/roles/:id/holders')return !lead(role)&&role!=='hr';
  if(/^\/v1\/flow\/(record-types|blocks|check|propose|describe|setup\/|roles|apps\/|records\/import)/.test(url)||/^\/v1\/flow\/processes(\/:id(\/(publish|status|hook))?)?$/.test(url)
   ||/^\/v1\/flow\/runs\/:id\/(later|discard)$/.test(url))return !lead(role);
  return false;
 }
 throw new Error('Unclassified mutation: '+url);
}
