-- migrate:up
-- AGREEMENTS (owner, 14 Nov 2026: "In Agreements the right side panel is just empty. It has an agreement where we can
-- make an offer letter, but it does not do anything"). People → Agreements becomes a workspace over the offers People &
-- pay already makes (0440 comp_offer: HR drafts, a founder approves and sends, the person answers), and the person
-- answers an offer the way they accept a policy: term by term in Pulse (2081), with the signed letter filed for them.
--   * agreements_offers(): every offer and where it stands (who for, role, dates, sent / opened / answered, which
--     letters), for pay readers, HR (pay writers) and founders. No amounts: those stay sealed in comp_change.
--   * agreement_offer_signed(): after the person accepted in Pulse (comp_offer_answer, via 'pulse'), the API draws the
--     letter again with their name and the time it was accepted and files it here once, with the key terms they ticked
--     in the offer's timeline (comp_event: kinds and words, never amounts).
--   * agreement_offers_waiting(): whether an offer waits for the viewer (the app's light check on each visit).
--   * agreement_offer_letterhead() / _letter_asset(): the letterhead their letter is drawn on, for that person alone.
--   * comp_letter_visible(): the person also reads that signed copy of their offer.
alter table pulse.comp_offer add column signed_letter_id uuid;

create function pulse.agreements_offers() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null or not (comp_reader() or comp_writer() or comp_is_approver(me)) then
    raise exception 'HR and founders see offers' using errcode = '42501';
  end if;
  return jsonb_build_object('writer', comp_writer(), 'approver', comp_is_approver(me), 'today', lifecycle_today(),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'personId', o.person_id, 'name', p.display_name, 'role', o.role, 'status', o.status,
        'startOn', o.start_on, 'validUntil', o.valid_until, 'probationDays', o.probation_days, 'noticeDays', o.notice_days,
        'createdAt', o.created_at, 'updatedAt', o.updated_at, 'proposedAt', o.proposed_at, 'approvedAt', o.approved_at, 'sentAt', o.sent_at,
        'openedAt', (select max(k.opened_at) from comp_offer_link k where k.org_id = o.org_id and k.offer_id = o.id),
        'answeredAt', o.answered_at, 'answerName', o.answer_name, 'answerVia', o.answer_via,
        'letterId', o.letter_id, 'signedLetterId', o.signed_letter_id,
        'proposedBy', (select display_name from person where id = o.proposed_by), 'approvedBy', (select display_name from person where id = o.approved_by),
        'mine', o.proposed_by = me) order by coalesce(o.answered_at, o.sent_at, o.updated_at) desc)
      from comp_offer o join person p on p.id = o.person_id where o.org_id = current_org()), '[]'));
end $$;

create function pulse.agreement_offer_signed(p_offer uuid, p_terms jsonb, p jsonb) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); o comp_offer; v_id uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
begin
  select * into o from comp_offer where org_id = current_org() and id = p_offer for update;
  if not found or me is null or o.person_id is distinct from me then raise exception 'Offer not found' using errcode = 'P0002'; end if;
  if o.status <> 'accepted' or o.answer_via is distinct from 'pulse' then raise exception 'Accept the offer first' using errcode = '22023'; end if;
  if o.signed_letter_id is not null then return o.signed_letter_id; end if;
  if jsonb_typeof(p_terms) is distinct from 'array' then raise exception 'tick every term before accepting' using errcode = '22023'; end if;
  if jsonb_array_length(p_terms) not between 1 and 20
     or exists (select 1 from jsonb_array_elements(p_terms) t where case when jsonb_typeof(t) <> 'object' then true
       else jsonb_typeof(t -> 'key') is distinct from 'string' or jsonb_typeof(t -> 'title') is distinct from 'string'
         or length(t ->> 'key') not between 2 and 64 or length(t ->> 'title') > 80 end) then
    raise exception 'tick every term before accepting' using errcode = '22023';
  end if;
  perform comp_sealed_check(p -> 'sealed'); perform comp_sealed_check(p -> 'pdf');
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then raise exception 'invalid letter' using errcode = '22023'; end if;
  insert into comp_letter (org_id, id, person_id, kind, subject_type, subject_id, title, s_kid, s_key, s_data, p_kid, p_key, p_data, sha256, pages, issued_by)
    values (current_org(), v_id, o.person_id, 'offer', 'offer', o.id, left(btrim(coalesce(p ->> 'title', 'Offer of employment (accepted)')), 160),
      p -> 'sealed' ->> 'kid', decode(p -> 'sealed' ->> 'key', 'base64'), decode(p -> 'sealed' ->> 'data', 'base64'),
      p -> 'pdf' ->> 'kid', decode(p -> 'pdf' ->> 'key', 'base64'), decode(p -> 'pdf' ->> 'data', 'base64'),
      p ->> 'sha256', coalesce(nullif(p ->> 'pages', '')::int, 1), me);
  update comp_offer set signed_letter_id = v_id, updated_at = now() where id = o.id;
  perform comp_event_add(o.person_id, 'offer.signed', 'offer', o.id,
    jsonb_build_object('letter', v_id, 'terms', (select jsonb_agg(t -> 'title') from jsonb_array_elements(p_terms) t)));
  return v_id;
end $$;

/** Whether an offer waits for the viewer's answer (the app asks on every visit; the letter itself is drawn only then). */
create function pulse.agreement_offers_waiting() returns int language sql stable security definer set search_path = pulse, pg_temp as $$
  select count(*)::int from comp_offer o where o.org_id = current_org() and o.person_id = current_viewer() and o.status = 'sent' and o.valid_until >= lifecycle_today()
$$;

/** The person whose offer waits (or who has just accepted it in Pulse, before its signed copy is filed) reads the
 *  letterhead their letter is drawn on: the same as HR's comp_letterhead / comp_letter_asset (0440), for that alone. */
create function pulse.agreement_offer_letter_allowed() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and exists (select 1 from comp_offer o where o.org_id = current_org() and o.person_id = current_viewer()
    and (o.status = 'sent' or (o.status = 'accepted' and o.answer_via = 'pulse' and o.signed_letter_id is null)))
$$;
create function pulse.agreement_offer_letterhead() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t record; s jsonb;
begin
  if not agreement_offer_letter_allowed() then raise exception 'Letters are for HR and founders' using errcode = '42501'; end if;
  select x.design, x.logo_id, x.signature_id into t from erp_template x where x.org_id = current_org() and not x.archived
    order by (x.id = (select template_id from erp_template_default where org_id = current_org() and doc_type = 'invoice')) desc, x.created_at limit 1;
  select company into s from erp_settings where org_id = current_org();
  return jsonb_build_object('design', coalesce(t.design, '{}'::jsonb), 'company', jsonb_build_object('name', coalesce(nullif(s ->> 'legalName', ''), (select name from org where id = current_org())),
    'lines', coalesce(s -> 'address', '[]'::jsonb)), 'logo', t.logo_id is not null or exists (select 1 from org_brand where org_id = current_org() and logo_png is not null),
    'signature', t.signature_id is not null, 'letters', (select letters from comp_policy_row()));
end $$;
create function pulse.agreement_offer_letter_asset(p_kind text) returns table(bytes bytea, mime text) language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t record;
begin
  if not agreement_offer_letter_allowed() then raise exception 'Letters are for HR and founders' using errcode = '42501'; end if;
  select x.logo_id, x.signature_id into t from erp_template x where x.org_id = current_org() and not x.archived
    order by (x.id = (select template_id from erp_template_default where org_id = current_org() and doc_type = 'invoice')) desc, x.created_at limit 1;
  if p_kind = 'signature' then return query select a.bytes, a.mime from erp_asset a where a.id = t.signature_id;
  elsif p_kind = 'logo' then
    return query select a.bytes, a.mime from erp_asset a where a.id = t.logo_id;
    if not found then return query select b.logo_png, 'image/png'::text from org_brand b where b.org_id = current_org() and b.logo_png is not null; end if;
  end if;
end $$;

create or replace function pulse.comp_letter_visible(l pulse.comp_letter) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select l.kind <> 'offer' or exists (select 1 from comp_offer o where o.id = l.subject_id and (o.letter_id = l.id or o.signed_letter_id = l.id)
    and o.status in ('sent', 'accepted', 'declined', 'expired'))
$$;

revoke all on function pulse.agreements_offers(), pulse.agreement_offer_signed(uuid, jsonb, jsonb), pulse.agreement_offers_waiting(), pulse.agreement_offer_letter_allowed(),
  pulse.agreement_offer_letterhead(), pulse.agreement_offer_letter_asset(text) from public;
grant execute on function pulse.agreements_offers(), pulse.agreement_offer_signed(uuid, jsonb, jsonb), pulse.agreement_offers_waiting(), pulse.agreement_offer_letter_allowed(),
  pulse.agreement_offer_letterhead(), pulse.agreement_offer_letter_asset(text) to pulse_api;

-- migrate:down
-- Forward-only: signed offer letters people accepted are kept.
