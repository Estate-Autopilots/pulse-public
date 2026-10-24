/** FLOW-A: the built-in record types (INVENTORY §3 primitive 1: a schema, fields and a status machine). Module backends
 *  are records of these types: a meeting, a document, an asset, a review, a request. The first group is what EA's
 *  Blueprint needs (Persona, Competitor, USP, Fact/Claim, Big Idea, Offer, Open item); every word in it is generic
 *  enough for any agency, and a company adds its own types the same way (pulse.flow_record_type). Pure. */
import type { RecordField, RecordStatus, RecordType } from './types.js';

const f = (key: string, label: string, type: RecordField['type'] = 'text', more: Partial<RecordField> = {}): RecordField => ({ key, label, type, ...more });
const s = (key: string, label: string, next: string[], more: Partial<RecordStatus> = {}): RecordStatus => ({ key, label, next, ...more });
const type = (t: Omit<RecordType, 'builtin'>): RecordType => ({ ...t, builtin: true });

/** Where a fact or a claim comes from (DR#3: a source label on every point). */
const SOURCE_LABELS = ['Client — Meeting', 'Client — Document', 'Client — WhatsApp', 'Sales / CP — Offline', 'Website', 'Portal', 'Google Maps', 'RERA', 'Competitor Claim', 'Developer Claim — To Verify', 'Own research', 'Other'];

export const RECORD_TYPES: RecordType[] = [
  // --- Strategy records (the Blueprint) -------------------------------------------------------------------------------
  type({ key: 'persona', name: 'Persona', plural: 'Personas', icon: 'user-round', summary: 'A buyer the work is for: who they are, what they compare, why now.',
    titleField: 'name', initial: 'draft',
    fields: [f('name', 'Name', 'text', { required: true }), f('who', 'Who they are', 'longtext', { required: true }), f('situation', 'Situation and trigger', 'longtext', { required: true }),
      f('wants', 'What they want', 'longtext', { required: true }), f('fears', 'What stops them', 'longtext', { required: true }), f('compares', 'What they compare', 'longtext'),
      f('decides', 'Who decides and how', 'longtext'), f('channels', 'Where they are reached', 'longtext'), f('priority', 'Priority', 'choice', { options: ['P1', 'P2', 'P3'] }),
      f('stage_fit', 'Current stage fit', 'choice', { options: ['P1', 'P2', 'P3'] }), f('language', 'Language bank (quotes, source and status)', 'list'), f('confirmed_by_sales', 'Sales confirms this persona', 'boolean')],
    statuses: [s('draft', 'Draft', ['checked']), s('checked', 'Checked', ['confirmed', 'draft'], { tone: 'good' }), s('confirmed', 'Confirmed', ['draft'], { final: true, tone: 'good' })] }),
  type({ key: 'competitor', name: 'Competitor', plural: 'Competitors', icon: 'swords', summary: 'A project the buyer compares this one with, with sources and the date checked.',
    titleField: 'name', initial: 'draft',
    fields: [f('name', 'Project and developer', 'text', { required: true }), f('distance', 'Distance', 'text'), f('ticket', 'Ticket size', 'text'), f('configurations', 'Configurations', 'text'),
      f('possession', 'Possession', 'text'), f('pitch', 'Their pitch', 'longtext'), f('strengths', 'Where they win', 'longtext'), f('weaknesses', 'Where they lose', 'longtext'),
      f('ads', 'What their ads say', 'longtext'), f('sources', 'Sources', 'list'), f('checked_on', 'Date checked', 'date'), f('coverage', 'Coverage line', 'text')],
    statuses: [s('draft', 'Draft', ['checked']), s('checked', 'Checked', ['draft'], { final: true, tone: 'good' })] }),
  type({ key: 'usp', name: 'USP', plural: 'USPs', icon: 'gem', summary: 'A strength in the form "strength → what it means → proof (source)".',
    titleField: 'strength', initial: 'draft',
    fields: [f('strength', 'Strength', 'text', { required: true }), f('meaning', 'What it means to the buyer', 'longtext', { required: true }), f('proof', 'Proof', 'longtext', { required: true }),
      f('source', 'Source', 'choice', { options: SOURCE_LABELS }), f('rank', 'Priority', 'number'), f('fact', 'Fact it rests on', 'record', { recordType: 'fact' })],
    statuses: [s('draft', 'Draft', ['proven', 'dropped']), s('proven', 'Proven', ['draft', 'dropped'], { tone: 'good' }), s('dropped', 'Dropped', ['draft'], { final: true, tone: 'neutral' })] }),
  type({ key: 'fact', name: 'Fact or claim', plural: 'Facts and claims', icon: 'badge-check', summary: 'A fact or claim with its source, when it was last checked and whether it may be used in ads.',
    titleField: 'statement', initial: 'to_verify',
    fields: [f('statement', 'Statement', 'longtext', { required: true }), f('source', 'Source', 'choice', { options: SOURCE_LABELS, required: true }), f('source_detail', 'Where exactly', 'text'),
      f('updated_on', 'Last updated', 'date'), f('operational', 'Is it there today', 'choice', { options: ['Operational', 'Under Construction', 'Proposed'] }),
      f('reveal', 'Reveal or hold', 'choice', { options: ['Reveal', 'Hold'] }), f('kpc', 'A known product constraint', 'boolean'), f('ads_ok', 'May be used in ads', 'boolean')],
    statuses: [s('to_verify', 'To verify', ['confirmed', 'provisional', 'hold', 'na'], { tone: 'warn' }), s('confirmed', 'Confirmed', ['to_verify', 'hold'], { tone: 'good' }),
      s('provisional', 'Provisional', ['confirmed', 'hold', 'na'], { tone: 'warn' }), s('hold', 'Hold', ['confirmed', 'provisional', 'na'], { tone: 'bad' }), s('na', 'Not applicable', ['to_verify'], { final: true })] }),
  type({ key: 'offer', name: 'Offer', plural: 'Offers', icon: 'tag', summary: 'An offer with its mechanism, who bears the cost, validity and whether it is approved for ads.',
    titleField: 'name', initial: 'pending',
    fields: [f('name', 'Offer', 'text', { required: true }), f('mechanism', 'Mechanism', 'longtext'), f('cost_bearer', 'Who bears the cost', 'text'), f('valid_until', 'Valid until', 'date'),
      f('terms', 'Terms', 'longtext'), f('approved_by', 'Approved by', 'text')],
    statuses: [s('pending', 'Pending', ['approved', 'expired'], { tone: 'warn' }), s('approved', 'Approved for ads', ['expired', 'pending'], { tone: 'good' }), s('expired', 'Expired', ['pending'], { final: true, tone: 'bad' })] }),
  type({ key: 'positioning', name: 'Positioning line', plural: 'Positioning', icon: 'crosshair', summary: 'The common line or one persona\'s line, with the Why-Now lever and its five checks.',
    titleField: 'line', initial: 'draft',
    fields: [f('line', 'Line', 'longtext', { required: true }), f('persona', 'Persona', 'record', { recordType: 'persona' }), f('why_now', 'Why-Now lever', 'longtext'),
      f('checks', 'Checks passed', 'multi', { options: ['Segment fit', 'Proof', 'Constraints', 'Specificity', 'Durability'] })],
    statuses: [s('draft', 'Draft', ['locked']), s('locked', 'Locked', ['draft'], { final: true, tone: 'good' })] }),
  type({ key: 'big_idea', name: 'Big Idea', plural: 'Big Ideas', icon: 'lightbulb', summary: 'One idea per creative: the promise, why it works, the hook plan and the proof it needs.',
    titleField: 'idea', initial: 'draft',
    fields: [f('idea', 'The idea', 'longtext', { required: true }), f('why', 'Why it works', 'longtext'), f('promise', 'Promise or mechanism', 'longtext'),
      f('hooks', 'Hook plan (lead type per hook)', 'list'), f('execution', 'Execution', 'longtext'), f('proof_needed', 'Proof needed', 'longtext'),
      f('persona', 'Persona', 'record', { recordType: 'persona' }), f('emotion', 'Emotion', 'text'),
      f('checks', 'Checks passed', 'multi', { options: ['Rule of One', 'Specific', 'Believable', 'Proof exists', 'Persona fit', 'Stage valid', 'Buyer voice'] })],
    statuses: [s('draft', 'Direction', ['chosen', 'parked']), s('chosen', 'Chosen', ['parked'], { tone: 'good' }), s('parked', 'Parked', ['draft'], { final: true })] }),
  type({ key: 'open_item', name: 'Open item', plural: 'Open items', icon: 'circle-help', summary: 'A PENDING, CONFLICT or FOLLOW-UP point with its owner, routed to whoever can answer.',
    titleField: 'question', initial: 'open',
    fields: [f('question', 'What is open', 'longtext', { required: true }), f('tag', 'Tag', 'choice', { options: ['PENDING', 'CONFLICT', 'FOLLOW-UP', 'ARCHITECT / DEVELOPER FOLLOW-UP REQUIRED'], required: true }),
      f('owner', 'Owner', 'person'), f('ask', 'Who is asked', 'text'), f('answer', 'Answer', 'longtext'), f('answered_on', 'Answered on', 'date')],
    statuses: [s('open', 'Open', ['asked', 'answered'], { tone: 'warn' }), s('asked', 'Asked', ['answered'], { tone: 'warn' }), s('answered', 'Answered', ['open'], { final: true, tone: 'good' })] }),
  type({ key: 'word', name: 'Word', plural: 'Word Library', icon: 'book-a', summary: 'A word to use and the word to avoid, its scope and why: versioned, approved by the client.',
    titleField: 'use', initial: 'proposed',
    fields: [f('use', 'Use', 'text', { required: true }), f('avoid', 'Avoid', 'text'), f('scope', 'Scope', 'choice', { options: ['All', 'Ads', 'Sales'] }), f('why', 'Why', 'longtext')],
    statuses: [s('proposed', 'Proposed', ['approved', 'retired']), s('approved', 'Approved', ['retired'], { tone: 'good' }), s('retired', 'Retired', ['proposed'], { final: true })] }),
  type({ key: 'message', name: 'Message', plural: 'Message Bank', icon: 'messages-square', summary: 'A message of a sequence or a bank: track, day, channel, text in each language, buttons.',
    titleField: 'msg_id', initial: 'draft',
    fields: [f('msg_id', 'Message ID', 'text', { required: true }), f('bank', 'Bank', 'choice', { options: ['Positioning', 'Tier 1', 'Tier 2', 'Proof', 'Trust', 'Objection', 'Action Reason', 'Sequence'] }),
      f('track', 'Track', 'choice', { options: ['0', 'A', 'B', 'C', 'D', 'X'] }), f('day', 'Day', 'number'), f('channel', 'Channel', 'choice', { options: ['WhatsApp', 'Email', 'Call', 'SMS'] }),
      f('asset', 'Asset', 'record', { recordType: 'asset' }), f('text', 'Text (English)', 'longtext', { required: true }), f('text_local', 'Text (Marathi / Hindi)', 'longtext'),
      f('buttons', 'Buttons', 'list'), f('sent_by', 'Sent by', 'choice', { options: ['Automation', 'Sales', 'Account team'] })],
    statuses: [s('draft', 'Draft', ['ready']), s('ready', 'Ready', ['live', 'draft'], { tone: 'good' }), s('live', 'Live', ['retired'], { tone: 'good' }), s('retired', 'Retired', ['draft'], { final: true })] }),
  type({ key: 'decision', name: 'Decision', plural: 'Decision log', icon: 'gavel', summary: 'A decision with who made it, the options, why, and what it locks.',
    titleField: 'decision', initial: 'recorded',
    fields: [f('decision', 'Decision', 'longtext', { required: true }), f('options', 'Options weighed', 'list'), f('why', 'Why', 'longtext'), f('decided_by', 'Decided by', 'text'), f('locks', 'What it locks', 'text')],
    statuses: [s('recorded', 'Recorded', ['reversed'], { tone: 'good' }), s('reversed', 'Reversed', [], { final: true, tone: 'bad' })] }),
  // --- Work records (the modules) ---------------------------------------------------------------------------------------
  type({ key: 'doc', name: 'Document', plural: 'Documents', icon: 'file-text', summary: 'A document with named sections, draft and final, versions and comments.',
    titleField: 'title', initial: 'draft',
    fields: [f('title', 'Title', 'text', { required: true }), f('template', 'Template', 'text'), f('sections', 'Sections', 'json'), f('drive_url', 'Drive copy', 'url')],
    statuses: [s('draft', 'Draft', ['final']), s('final', 'Final', ['draft'], { final: true, tone: 'good' })] }),
  type({ key: 'meeting', name: 'Meeting', plural: 'Meetings', icon: 'video', summary: 'A meeting, call or interview: when, who, the link, its recording or transcript, tags, summary and follow-ups.',
    titleField: 'title', initial: 'scheduled',
    fields: [f('title', 'Title', 'text', { required: true }), f('at', 'When', 'date'), f('time', 'Time', 'text'), f('people', 'People', 'list'), f('place', 'Place or link', 'url'),
      f('recording_url', 'Recording', 'url'), f('transcript', 'Transcript', 'longtext', { max: 200000 }), f('tags', 'Tagged moments', 'json'), f('summary', 'Summary', 'longtext'),
      f('followups', 'Follow-ups', 'list'), f('score', 'Client score', 'json'), f('notes', 'Notes', 'longtext'), f('adopted', 'Sales Opener adopted', 'choice', { options: ['Yes', 'No', 'Not discussed'] })],
    statuses: [s('scheduled', 'Scheduled', ['held', 'cancelled']), s('held', 'Held', ['transcribed']), s('transcribed', 'Transcript saved', ['summarised'], { tone: 'good' }),
      s('summarised', 'Summarised', [], { final: true, tone: 'good' }), s('cancelled', 'Cancelled', ['scheduled'], { final: true, tone: 'bad' })] }),
  type({ key: 'asset', name: 'Asset', plural: 'Assets', icon: 'clapperboard', summary: 'A deliverable with its Asset ID, type, persona and Big Idea, a tabbed working doc and its dates.',
    titleField: 'name', initial: 'draft',
    code: { pattern: 'PROJECT_ASSET_PERSONA_ANGLE_H01_V01', help: 'Project, asset type, persona, angle, hook number and version' },
    sections: [{ key: 'script', title: 'Script' }, { key: 'shoot_notes', title: 'Videographer notes' }, { key: 'edit_notes', title: 'Editor notes' }, { key: 'copy', title: 'Copy' }, { key: 'design_notes', title: 'Designer notes' }],
    fields: [f('name', 'Name', 'text', { required: true }), f('asset_type', 'Type', 'choice', { options: ['Model Video', 'VOV', 'Image set', 'Carousel', 'Landing page', 'Walkthrough', 'Founder Video', 'Testimonial', 'Brand Film', 'Other'], required: true }),
      f('persona', 'Persona', 'record', { recordType: 'persona' }), f('big_idea', 'Big Idea', 'record', { recordType: 'big_idea' }), f('angle', 'Angle', 'text'), f('hook', 'Hook number', 'number'),
      f('cut', 'Cut', 'choice', { options: ['Master', 'Decision', 'Full', 'Soundbite', 'Teaser', 'Cutdown'] }), f('tabs', 'Working doc', 'json'), f('final_url', 'Final link', 'url'),
      f('ad_ids', 'Ad IDs', 'list'), f('offer_end', 'Offer end date', 'date'), f('verdict', 'Monday verdict', 'choice', { options: ['Winning', 'Working', 'Not working', 'Too early'] }),
      f('dates', 'Dates', 'json'), f('revisions', 'Revisions after the 2 PM session', 'number'), f('consent', 'Consent', 'record', { recordType: 'consent' })],
    statuses: [s('draft', 'Draft', ['sent']), s('sent', 'Sent to client', ['changes', 'confirmed']), s('changes', 'Changes asked', ['sent']), s('confirmed', 'Client confirmed', ['in_production'], { tone: 'good' }),
      s('in_production', 'Shoot / design', ['rough_cut']), s('rough_cut', 'Rough cut', ['final']), s('final', 'Final (frozen)', ['live'], { tone: 'good' }), s('live', 'Live', ['retired'], { tone: 'good' }),
      s('retired', 'Retired', [], { final: true })] }),
  type({ key: 'review', name: 'Review', plural: 'Reviews', icon: 'send', summary: 'Drafts shared with a client or approver: the message, who is tagged, written changes, rounds and the confirmation date.',
    titleField: 'title', initial: 'drafting',
    fields: [f('title', 'What is shared', 'text', { required: true }), f('items', 'Links', 'list'), f('message', 'Message to post', 'longtext'), f('tagged', 'Tagged', 'list'),
      f('channel', 'Where', 'choice', { options: ['Client WhatsApp group', 'Email', 'Meeting', 'Other'] }), f('changes', 'Written changes', 'json'), f('rounds', 'Rounds', 'number'),
      f('sent_on', 'Sent on', 'date'), f('confirmed_on', 'Confirmed on', 'date'), f('approver', 'Approver', 'text')],
    statuses: [s('drafting', 'Drafting', ['sent']), s('sent', 'Sent for review', ['changes', 'confirmed'], { tone: 'warn' }), s('changes', 'Changes asked', ['sent'], { tone: 'warn' }),
      s('confirmed', 'Confirmed', [], { final: true, tone: 'good' })] }),
  type({ key: 'media_set', name: 'Media', plural: 'Media', icon: 'film', summary: 'A cut, photo set or files with versions, timestamped comments, a change list and a freeze.',
    titleField: 'title', initial: 'uploaded',
    fields: [f('title', 'Title', 'text', { required: true }), f('asset', 'Asset', 'record', { recordType: 'asset' }), f('versions', 'Versions', 'json'), f('files', 'Files', 'json'),
      f('stage', 'Stage', 'choice', { options: ['Rough cut', 'Second cut', 'Final', 'Photos'] })],
    statuses: [s('uploaded', 'Uploaded', ['in_review']), s('in_review', 'In review', ['changes', 'final']), s('changes', 'Changes listed', ['uploaded']), s('final', 'Final (frozen)', [], { final: true, tone: 'good' })] }),
  type({ key: 'request', name: 'Request', plural: 'Requests', icon: 'inbox', summary: 'A demand raised (client, type, why) and answered with a committed first-drop date.',
    titleField: 'title', initial: 'raised',
    fields: [f('title', 'What is asked', 'text', { required: true }), f('client', 'Client', 'text'), f('kind', 'Type', 'text'), f('why', 'Why', 'longtext'), f('raised_by', 'Raised by', 'person'),
      f('raised_on', 'Raised on', 'date'), f('owner', 'Who does it', 'person'), f('first_drop', 'First-drop date', 'date'), f('run', 'Run it starts', 'text')],
    statuses: [s('raised', 'Raised', ['answered', 'dropped'], { tone: 'warn' }), s('answered', 'Answered', ['in_work', 'dropped']), s('in_work', 'In work', ['delivered']),
      s('delivered', 'Delivered', [], { final: true, tone: 'good' }), s('dropped', 'Dropped', ['raised'], { final: true })] }),
  type({ key: 'session', name: 'Session', plural: 'Sessions', icon: 'calendar-clock', summary: 'A recurring ritual (a daily review, a weekly meeting): its agenda from the runs, notes, decisions, requests out.',
    titleField: 'title', initial: 'planned',
    fields: [f('title', 'Session', 'text', { required: true }), f('ritual', 'Ritual', 'text'), f('on', 'Date', 'date'), f('time', 'Time', 'text'), f('people', 'People', 'list'), f('agenda', 'Agenda', 'json'),
      f('notes', 'Notes', 'longtext'), f('decisions', 'Decisions', 'list'), f('requests', 'Requests out', 'list')],
    statuses: [s('planned', 'Planned', ['held']), s('held', 'Held', [], { final: true, tone: 'good' })] }),
  type({ key: 'shoot', name: 'Shoot or visit', plural: 'Shoots and visits', icon: 'camera', summary: 'A shoot or visit: date, place, people, needs, call sheet, shot list, consent and casting.',
    titleField: 'title', initial: 'planning',
    fields: [f('title', 'Title', 'text', { required: true }), f('on', 'Date', 'date'), f('call_time', 'Call time', 'text'), f('place', 'Place', 'text'), f('map_url', 'Map link', 'url'),
      f('people', 'People (role, name, contact)', 'list'), f('needs', 'Needs', 'list'), f('shot_list', 'Shot list', 'list'), f('equipment', 'Equipment', 'list'),
      f('call_sheet', 'Call sheet', 'longtext'), f('backups_verified', 'Two verified backups before formatting cards', 'boolean'), f('wrap', 'Wrap report', 'longtext')],
    statuses: [s('planning', 'Planning', ['scheduled']), s('scheduled', 'Scheduled', ['shot', 'planning'], { tone: 'good' }), s('shot', 'Shot', ['wrapped']), s('wrapped', 'Wrapped', [], { final: true, tone: 'good' })] }),
  type({ key: 'talent', name: 'Talent', plural: 'Talent pool', icon: 'star', summary: 'A model, presenter or actor: audition, shortlist, client pick, agreement and usage expiry.',
    titleField: 'name', initial: 'shortlisted',
    fields: [f('name', 'Name', 'text', { required: true }), f('role_in', 'Role', 'text'), f('agency', 'Agency', 'text'), f('audition_url', 'Audition clip', 'url'), f('fee', 'Fee', 'money'),
      f('usage_until', 'Usage until', 'date'), f('backup', 'Backup', 'boolean'), f('child', 'Child artist', 'boolean')],
    statuses: [s('shortlisted', 'Shortlisted', ['picked', 'dropped']), s('picked', 'Client picked', ['signed', 'dropped'], { tone: 'good' }), s('signed', 'Signed', ['released'], { tone: 'good' }),
      s('released', 'Released', [], { final: true }), s('dropped', 'Dropped', ['shortlisted'], { final: true })] }),
  type({ key: 'consent', name: 'Consent', plural: 'Consent and rights', icon: 'file-signature', summary: 'Consent or a licence: who, which channels, name shown, signed when, expires when.',
    titleField: 'who', initial: 'requested',
    fields: [f('who', 'Who', 'text', { required: true }), f('kind', 'Kind', 'choice', { options: ['Testimonial consent', 'Release form', 'Talent agreement', 'Music licence', 'Location permit', 'Other'] }),
      f('channels', 'Channels', 'multi', { options: ['Meta ads', 'YouTube', 'Website', 'WhatsApp', 'Sales deck', 'Site office', 'Print'] }), f('name_shown', 'Name shown', 'boolean'),
      f('signed_on', 'Signed on', 'date'), f('expires_on', 'Expires on', 'date'), f('file_url', 'Signed copy', 'url'), f('child', 'Child artist rules apply', 'boolean')],
    statuses: [s('requested', 'Requested', ['signed', 'withdrawn'], { tone: 'warn' }), s('signed', 'Signed', ['expired', 'withdrawn'], { tone: 'good' }), s('expired', 'Expired', ['signed'], { tone: 'bad' }),
      s('withdrawn', 'Withdrawn', [], { final: true, tone: 'bad' })] }),
  type({ key: 'check', name: 'Check', plural: 'Checks', icon: 'list-checks', summary: 'A quality test or a words, claims and constraints check on a draft: findings, and the person\'s decision.',
    titleField: 'title', initial: 'open',
    fields: [f('title', 'What is checked', 'text', { required: true }), f('target', 'Draft', 'record'), f('findings', 'Findings', 'json'), f('tests', 'Quality test', 'json'), f('decided_by', 'Decided by', 'person')],
    statuses: [s('open', 'Open', ['passed', 'failed']), s('passed', 'Passed', ['open'], { final: true, tone: 'good' }), s('failed', 'Changes needed', ['open'], { tone: 'bad' })] }),
  type({ key: 'library_item', name: 'Library item', plural: 'Libraries', icon: 'library', summary: 'A reference: a swipe file, a reference video, a testimonial, an evidence row.',
    titleField: 'title', initial: 'active',
    fields: [f('title', 'Title', 'text', { required: true }), f('library', 'Library', 'text', { required: true }), f('url', 'Link', 'url'), f('segment', 'Segment', 'text'), f('note', 'Note', 'longtext'), f('tags', 'Tags', 'list')],
    statuses: [s('active', 'In use', ['archived'], { tone: 'good' }), s('archived', 'Archived', ['active'], { final: true })] }),
  type({ key: 'daily_update', name: 'Daily update', plural: 'Daily updates', icon: 'sun', summary: 'What a person works on today, written from their open steps.',
    titleField: 'title', initial: 'draft',
    fields: [f('title', 'Title', 'text', { required: true }), f('on', 'Date', 'date'), f('person', 'Person', 'person'), f('text', 'Update', 'longtext'), f('posted_to', 'Posted to', 'text')],
    statuses: [s('draft', 'Draft', ['posted']), s('posted', 'Posted', [], { final: true, tone: 'good' })] }),
  type({ key: 'pack', name: 'Pack', plural: 'Packs', icon: 'package', summary: 'A hand-over pack: an Activation Pack, a Sales Opener Brief, a Sequence Pack.',
    titleField: 'title', initial: 'draft',
    fields: [f('title', 'Title', 'text', { required: true }), f('pack', 'Pack', 'choice', { options: ['Activation Pack', 'Sales Opener Brief', 'Sequence Pack', 'Presenter Brief Pack', 'Other'] }),
      f('sections', 'Sections', 'json'), f('assets', 'Assets', 'list'), f('sent_on', 'Sent on', 'date'), f('sent_by', 'Sent by', 'person'), f('adopted', 'Adopted', 'choice', { options: ['Yes', 'No', 'Not yet'] })],
    statuses: [s('draft', 'Draft', ['ready']), s('ready', 'Ready', ['sent', 'draft'], { tone: 'good' }), s('sent', 'Sent', [], { final: true, tone: 'good' })] }),
];
export const RECORD_TYPE = new Map(RECORD_TYPES.map((t) => [t.key, t]));

/** The Asset ID: PROJECT_ASSET_PERSONA_ANGLE_H01_V01 (CMA Map #0). Each part upper-case letters and digits only. */
export function assetId(p: { project: string; asset: string; persona?: string | null; angle?: string | null; hook?: number | null; version?: number | null }) {
  const part = (x: string | null | undefined, max: number) => (x ?? '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, max);
  const abbr = (x: string) => { const w = x.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    return w.length > 1 ? w.map((y) => y[0]).join('').slice(0, 6) : part(x, 8); };
  const pad = (n: number | null | undefined) => String(Math.max(1, Math.min(99, Math.round(n ?? 1)))).padStart(2, '0');
  return [abbr(p.project) || 'PROJECT', abbr(p.asset) || 'ASSET', part(p.persona, 8) || 'ALL', part(p.angle, 12) || 'MAIN', `H${pad(p.hook)}`, `V${pad(p.version)}`].join('_');
}

/** A record's data kept to its type: known fields only, each in its type and length. Unknown keys are dropped. */
export function cleanData(t: RecordType, data: unknown): { data: Record<string, unknown>; missing: string[] } {
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {}; const missing: string[] = [];
  for (const fl of t.fields) {
    const x = d[fl.key];
    if (x === undefined || x === null || x === '') { if (fl.required) missing.push(fl.label); continue; }
    const max = fl.max ?? (fl.type === 'longtext' ? 20000 : 500);
    switch (fl.type) {
      case 'number': case 'money': { const n = Number(x); if (Number.isFinite(n)) out[fl.key] = n; break; }
      case 'boolean': out[fl.key] = x === true || x === 'true' || x === 'yes'; break;
      case 'date': if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) out[fl.key] = x; break;
      case 'choice': if (typeof x === 'string' && (!fl.options || fl.options.includes(x))) out[fl.key] = x; break;
      case 'multi': if (Array.isArray(x)) out[fl.key] = x.filter((y) => typeof y === 'string' && (!fl.options || fl.options.includes(y))).slice(0, 30); break;
      case 'list': if (Array.isArray(x)) out[fl.key] = x.map((y) => typeof y === 'string' ? y.slice(0, 2000) : y && typeof y === 'object' ? y : null).filter((y) => y !== null).slice(0, 200); break;
      case 'url': if (typeof x === 'string' && /^(https:\/\/|\/[^/])/.test(x.trim())) out[fl.key] = x.trim().slice(0, 2000); break;
      case 'person': case 'record': if (typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)) out[fl.key] = x; break;
      case 'json': if (typeof x === 'object') out[fl.key] = x; break;
      default: if (typeof x === 'string') out[fl.key] = x.slice(0, max); else if (typeof x === 'number') out[fl.key] = String(x);
    }
    if (fl.required && !(fl.key in out)) missing.push(fl.label);
  }
  return { data: out, missing };
}

/** A company's own record type, kept within limits (fields, statuses that point at statuses that exist). */
export function normalizeRecordType(input: unknown): { type: RecordType } | { error: string } {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const key = String(r.key ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) return { error: 'Give the record type a key: lower-case letters, digits and _' };
  if (RECORD_TYPE.has(key)) return { error: `“${key}” is a built-in record type` };
  const name = String(r.name ?? '').trim().slice(0, 80); if (!name) return { error: 'Name the record type' };
  const FT = ['text', 'longtext', 'number', 'date', 'boolean', 'choice', 'multi', 'person', 'url', 'list', 'record', 'money', 'json'];
  const fields = (Array.isArray(r.fields) ? r.fields : []).slice(0, 40).map((x) => (x ?? {}) as Record<string, unknown>).map((x) => ({
    key: String(x.key ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40), label: String(x.label ?? '').trim().slice(0, 80),
    type: (FT.includes(String(x.type)) ? x.type : 'text') as RecordField['type'], ...(x.required ? { required: true } : {}),
    ...(Array.isArray(x.options) ? { options: x.options.map(String).slice(0, 40) } : {}) })).filter((x) => x.key && x.label);
  if (!fields.length) return { error: 'Give the record type at least one field' };
  const raw = Array.isArray(r.statuses) && r.statuses.length ? r.statuses : [{ key: 'open', label: 'Open', next: ['done'] }, { key: 'done', label: 'Done', next: ['open'], final: true }];
  const statuses = raw.slice(0, 20).map((x) => (x ?? {}) as Record<string, unknown>).map((x) => ({ key: String(x.key ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40),
    label: String(x.label ?? '').trim().slice(0, 60), next: Array.isArray(x.next) ? x.next.map(String) : [], ...(x.final ? { final: true } : {}) })).filter((x) => x.key && x.label);
  const keys = new Set(statuses.map((x) => x.key));
  for (const st of statuses) st.next = st.next.filter((n) => keys.has(n) && n !== st.key);
  if (!statuses.length) return { error: 'Give the record type at least one status' };
  const titleField = fields.some((x) => x.key === r.titleField) ? String(r.titleField) : fields[0].key;
  return { type: { key, name, plural: String(r.plural ?? '').trim().slice(0, 80) || name, icon: String(r.icon ?? 'square').slice(0, 40), summary: String(r.summary ?? '').trim().slice(0, 300),
    fields, statuses, initial: keys.has(String(r.initial)) ? String(r.initial) : statuses[0].key, titleField, builtin: false } };
}
