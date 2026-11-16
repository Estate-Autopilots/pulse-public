-- migrate:up
-- CONTRACTS-PRO (owner, 15 Nov 2026): contracts drawn as typeset legal documents, and a third way to sign.
-- 1. The letterhead a contract is drawn with: the company's Billing template (design and logo) and its legal name and
--    address, as on its invoices. It is what this company's invoices print for anyone, so it needs no role; the signing
--    link reads it inside the agreement's own company (pulse.contract_sign_bind sets the company first).
-- 2. A signature may be a photo of a signature on paper, cleaned in the browser (paper removed, ink kept, cropped) and
--    kept as a small PNG like a drawing; its kind is 'uploaded', so the record and the signed PDF say how it was made.
--    contract_sign_here and contract_sign_act are 1850's, with only the kind check, the picture and the log line widened.
-- 3. Notifications to the agreement's owner at each step the other side takes through the link (opened, signed, said no,
--    asked for a change, commented) and when everyone has signed: the owner of record (contract_side.owner_person_id, else
--    who made it), as an in-app notification through pulse.notification_emit ('update.self', the pattern Docs uses). A failed
--    notification never blocks signing.
-- 4. Order of signing (pulse.contract_turn), checked in both signing functions.
-- No new tables.

create or replace function pulse.contract_letterhead() returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare t record; s jsonb;
begin
 if current_org() is null then return null; end if;
 select x.design, x.logo_id into t from erp_template x where x.org_id = current_org() and not x.archived
  order by (x.id = (select template_id from erp_template_default where org_id = current_org() and doc_type = 'invoice')) desc, x.created_at limit 1;
 select company into s from erp_settings where org_id = current_org();
 return jsonb_build_object('design', coalesce(t.design, '{}'::jsonb),
  'company', jsonb_build_object('name', coalesce(nullif(s->>'legalName', ''), (select name from org where id = current_org())),
   'lines', coalesce(s->'address', '[]'::jsonb), 'gstin', s->>'gstin'),
  'logo', t.logo_id is not null or exists (select 1 from org_brand where org_id = current_org() and logo_png is not null));
end $$;

create or replace function pulse.contract_letterhead_logo() returns table(bytes bytea, mime text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare lid uuid;
begin
 if current_org() is null then return; end if;
 select x.logo_id into lid from erp_template x where x.org_id = current_org() and not x.archived
  order by (x.id = (select template_id from erp_template_default where org_id = current_org() and doc_type = 'invoice')) desc, x.created_at limit 1;
 return query select a.bytes, a.mime from erp_asset a where a.id = lid;
 if not found then return query select b.logo_png, 'image/png'::text from org_brand b where b.org_id = current_org() and b.logo_png is not null; end if;
end $$;

revoke all on function pulse.contract_letterhead(), pulse.contract_letterhead_logo() from public;
grant execute on function pulse.contract_letterhead(), pulse.contract_letterhead_logo() to pulse_api;

alter table pulse.contract_party drop constraint if exists contract_party_sign_kind_check;
alter table pulse.contract_party add constraint contract_party_sign_kind_check check (sign_kind in ('typed', 'drawn', 'uploaded', 'recorded'));

-- 4. Order of signing: when the contract's facts line says "ordered", a party signs only after every party listed before it.
--    The name of the first one still to sign, or null (no order, or it is this party's turn). A facts line that cannot be read
--    means no order (it never blocks signing by mistake).
create or replace function pulse.contract_turn(p_contract uuid, p_party uuid) returns text
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare c contract; m jsonb; f jsonb; mine int; i int; me_name text; waiting text;
begin
 select * into c from contract where org_id = current_org() and id = p_contract;
 if c.id is null or c.body !~ '^<!--\s*pulse:contract\s' or strpos(c.body, '-->') = 0 then return null; end if;
 -- ">" is written \u003e inside the facts, so the first "-->" ends them.
 m := regexp_replace(left(c.body, strpos(c.body, '-->') - 1), '^<!--\s*pulse:contract\s+', '')::jsonb;
 if coalesce((m->>'ordered')::boolean, false) is not true or jsonb_typeof(m->'parties') <> 'array' then return null; end if;
 select lower(btrim(name)) into me_name from contract_party where org_id = current_org() and contract_id = p_contract and party_key = p_party;
 for i in 0 .. jsonb_array_length(m->'parties') - 1 loop
  f := m->'parties'->i;
  if f->>'key' = p_party::text or (f->>'key' is null and lower(btrim(f->>'name')) = me_name) then mine := i; exit; end if;
 end loop;
 if mine is null then return null; end if;
 for i in 0 .. mine - 1 loop
  f := m->'parties'->i;
  select coalesce(nullif(btrim(f->>'name'), ''), p.name) into waiting from contract_party p
   where p.org_id = current_org() and p.contract_id = p_contract and p.party_key <> p_party
     and (p.party_key::text = f->>'key' or (f->>'key' is null and lower(btrim(p.name)) = lower(btrim(f->>'name'))))
     and p.accepted_version is distinct from c.version
   limit 1;
  if waiting is not null then return waiting; end if;
 end loop;
 return null;
exception when others then return null;
end $$;
revoke all on function pulse.contract_turn(uuid, uuid) from public;

create or replace function pulse.contract_sign_here(p_id uuid, p jsonb) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; pt contract_party; mgr boolean := contract_manager(); nm text := btrim(coalesce(p->>'name', '')); k text := coalesce(p->>'kind', 'typed');
  img text := nullif(p->>'image', '');
begin
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found or not contract_can_see(c.id, c.status) then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status <> 'proposed' then raise exception 'Only an agreement waiting for signatures is signed' using errcode = '22023'; end if;
 if coalesce((p->>'agree')::boolean, false) is not true then raise exception 'Tick "I agree" to sign' using errcode = '22023'; end if;
 if length(nm) not between 2 and 160 then raise exception 'Type your full name to sign' using errcode = '22023'; end if;
 if k not in ('typed', 'drawn', 'uploaded') or (k in ('drawn', 'uploaded') and img is null) then raise exception 'Type your name, draw your signature or upload a photo of it' using errcode = '22023'; end if;
 select * into pt from contract_party x where x.org_id = current_org() and x.contract_id = p_id and x.accepted_version is distinct from c.version
   and ((x.kind = 'person' and (x.party_person_id = current_viewer() or (x.party_account is not null and x.party_account = account_of_viewer())))
     or (mgr and x.kind = 'company' and x.party_org = current_org()))
   order by x.position limit 1;
 if not found then raise exception 'There is nothing here for you to sign' using errcode = '42501'; end if;
 if contract_turn(p_id, pt.party_key) is not null then
  raise exception '% signs first. You can sign after them', contract_turn(p_id, pt.party_key) using errcode = '22023'; end if;
 update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = left(nm, 160), accepted_note = 'Signed in Vitals OS',
   signer_name = left(nm, 160), sign_kind = k, sign_image = case when k in ('drawn', 'uploaded') then img end, declined_at = null, declined_note = null
  where org_id = current_org() and id = pt.id;
 perform contract_settle(p_id);
 perform contract_push(p_id);
 perform contract_log_all(p_id, 'signed', pt.party_key, null, format('%s signed for %s (%s)', nm, pt.name, case k when 'drawn' then 'drawn signature' when 'uploaded' then 'photo of their signature, cleaned' else 'typed name' end), 'app', nm);
 return (select status from contract where org_id = current_org() and id = p_id);
end $$;

create or replace function pulse.contract_sign_act(p_hash text, p jsonb, p_ip text, p_agent text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k contract_sign_link; c contract; me contract_party; a text := coalesce(p->>'action', ''); nm text := btrim(coalesce(p->>'name', ''));
  sk text := coalesce(p->>'kind', 'typed'); img text := nullif(p->>'image', ''); txt text := btrim(coalesce(p->>'text', '')); who text;
begin
 perform contract_sign_bind(p_hash);
 select * into k from contract_sign_link where token_hash = p_hash and org_id = current_org() for update;
 if k.token_hash is null or k.revoked_at is not null then raise exception 'This link is not valid any more. Ask for a new one' using errcode = '22023'; end if;
 if k.expires_at < now() then raise exception 'This link has expired. Ask the sender for a new one' using errcode = '22023'; end if;
 select * into c from contract where org_id = current_org() and id = k.contract_id for update;
 select * into me from contract_party where org_id = current_org() and contract_id = c.id and party_key = k.party_key;
 if c.status <> 'proposed' then raise exception 'This agreement is not waiting for an answer' using errcode = '22023'; end if;
 who := coalesce(nullif(left(nm, 160), ''), me.signer_name, me.name);
 if a in ('comment', 'change') then
  if length(txt) not between 2 and 2000 then raise exception 'Write your comment (up to 2000 letters)' using errcode = '22023'; end if;
  perform contract_log(c.id, case when a = 'change' then 'change_asked' else 'commented' end, k.party_key, p->>'clause', txt, 'link', p_ip, p_agent, who);
  return jsonb_build_object('ok', true);
 end if;
 if me.accepted_version = c.version then raise exception 'You already signed this agreement' using errcode = '22023'; end if;
 if a = 'decline' then
  update contract_party set declined_at = now(), declined_note = nullif(left(txt, 1000), '') where org_id = current_org() and id = me.id;
  update contract_sign_link set answered_at = now() where token_hash = p_hash;
  perform contract_log(c.id, 'declined', k.party_key, null, nullif(txt, ''), 'link', p_ip, p_agent, who);
  perform contract_push(c.id);
  return jsonb_build_object('declined', true);
 end if;
 if a <> 'sign' then raise exception 'Sign, say no, or write a comment' using errcode = '22023'; end if;
 if coalesce((p->>'agree')::boolean, false) is not true then raise exception 'Tick "I agree" to sign' using errcode = '22023'; end if;
 if length(nm) not between 2 and 160 then raise exception 'Type your full name to sign' using errcode = '22023'; end if;
 if sk not in ('typed', 'drawn', 'uploaded') or (sk in ('drawn', 'uploaded') and img is null) then raise exception 'Type your name, draw your signature or upload a photo of it' using errcode = '22023'; end if;
 if contract_turn(c.id, k.party_key) is not null then
  raise exception '% signs first. You can sign after them', contract_turn(c.id, k.party_key) using errcode = '22023'; end if;
 update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = left(nm, 160), accepted_note = 'Signed through the link',
   signer_name = left(nm, 160), sign_kind = sk, sign_image = case when sk in ('drawn', 'uploaded') then img end, declined_at = null, declined_note = null
  where org_id = current_org() and id = me.id;
 update contract_sign_link set answered_at = now() where token_hash = p_hash;
 perform contract_log(c.id, 'signed', k.party_key, null, format('%s signed for %s (%s)', nm, me.name, case sk when 'drawn' then 'drawn signature' when 'uploaded' then 'photo of their signature, cleaned' else 'typed name' end),
   'link', p_ip, p_agent, nm);
 perform contract_settle(c.id);
 perform contract_push(c.id);
 return jsonb_build_object('signed', true, 'status', (select status from contract where org_id = current_org() and id = c.id));
end $$;

-- ------------------------------------------------------------------------------------------------ notifications
create or replace function pulse.contract_event_notify() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid; t text; party text; what text;
begin
 if new.via <> 'link' or new.kind not in ('opened', 'signed', 'declined', 'change_asked', 'commented') then return null; end if;
 select coalesce(s.owner_person_id, s.created_by) into who from contract_side s where s.org_id = new.org_id and s.contract_id = new.contract_id;
 if who is null then return null; end if;
 select c.title into t from contract c where c.org_id = new.org_id and c.id = new.contract_id;
 select p.name into party from contract_party p where p.org_id = new.org_id and p.contract_id = new.contract_id and p.party_key = new.party_key;
 what := case new.kind when 'opened' then ' opened ' when 'signed' then ' signed ' when 'declined' then ' said no to '
   when 'change_asked' then ' asked for a change in ' else ' commented on ' end;
 perform notification_emit(who, 'update.self', 'person', who, 'contract:' || new.id::text,
   left(coalesce(nullif(btrim(new.actor_name), ''), party, 'The other side') || what || '“' || coalesce(t, 'your agreement') || '”', 200),
   '/contracts/' || new.contract_id::text, 'update');
 return null;
exception when others then return null;
end $$;
create trigger contract_event_notify after insert on pulse.contract_event for each row execute function pulse.contract_event_notify();

create or replace function pulse.contract_signed_notify() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid;
begin
 if old.signed_at is not null or new.signed_at is null then return null; end if;
 select coalesce(s.owner_person_id, s.created_by) into who from contract_side s where s.org_id = new.org_id and s.contract_id = new.id;
 if who is null then return null; end if;
 perform notification_emit(who, 'update.self', 'person', who, 'contract-signed:' || new.id::text || ':' || new.version::text,
   left('Everyone signed “' || new.title || '”. The signed copy is ready.', 200), '/contracts/' || new.id::text, 'update');
 return null;
exception when others then return null;
end $$;
create trigger contract_signed_notify after update of signed_at on pulse.contract for each row execute function pulse.contract_signed_notify();
revoke all on function pulse.contract_event_notify(), pulse.contract_signed_notify() from public;

-- migrate:down
-- Forward-only, like 1850: signatures made with a photo are kept.
