-- migrate:up
-- PEOPLE-CONTACTS part 5 (owner, 11 Oct 2026): "open a contact's own profile, like a person's; far more connected
-- data; 'campaigns' there makes no sense". A contact's profile gathers what Pulse already knows (clients, projects,
-- deliveries, files, chats, mail, money) and adds two things of its own:
--  * notes: anyone on the team (not HR-only accounts, decided by the API as for every contact read) writes a dated note
--    about a contact; the author or an admin removes it (kept for the history, hidden).
--  * links Pulse proposes from the data: projects whose Drive files name the contact, and clients whose e-mail domain
--    or name matches. An admin links one with a click (pulse.contact_link); nothing is linked silently.
--  * money: the invoices of the contact's clients, from FIN-LIVE (matched invoice parties) and ERP, only for viewers
--    with the money grants (pulse.money_can), amounts only with money.amount.read; every read is audited.
create table pulse.contact_note (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id) on delete cascade,
 body text not null check (length(btrim(body)) between 1 and 2000),
 author_id uuid,                          -- no foreign key (release smoke cleanup deletes validation people)
 created_at timestamptz not null default now(),
 removed_at timestamptz, removed_by uuid
);
create index contact_note_person on pulse.contact_note(org_id,person_id,created_at desc) where removed_at is null;
alter table pulse.contact_note enable row level security;
alter table pulse.contact_note force row level security;
create policy tenant on pulse.contact_note using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
create policy visible on pulse.contact_note as restrictive for select to pulse_api using (removed_at is null);
grant select on pulse.contact_note to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.contact_note for each row execute function pulse.audit_mutation();

create function pulse.contact_note_add(p_person uuid, p_body text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if current_viewer() is null then raise exception 'Sign in with your own account to write a note' using errcode='42501'; end if;
 if not exists(select 1 from contact_profile where org_id=current_org() and person_id=p_person) then raise exception 'Contact not found' using errcode='22023'; end if;
 if length(btrim(coalesce(p_body,''))) not between 1 and 2000 then raise exception 'A note is 1 to 2000 characters' using errcode='22023'; end if;
 insert into contact_note(org_id,person_id,body,author_id) values(current_org(),p_person,btrim(p_body),current_viewer()) returning id into nid;
 return nid;
end $$;
create function pulse.contact_note_remove(p_id uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update contact_note set removed_at=now(),removed_by=current_viewer() where org_id=current_org() and id=p_id and removed_at is null
  and (author_id=current_viewer() or viewer_is('admin'));
 if not found then raise exception 'Only the author or an admin removes a note' using errcode='42501'; end if;
end $$;

-- Money of a contact's clients. Null without money.read; amounts only with money.amount.read; audited.
create function pulse.contact_money(p_person uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare amounts boolean; clients uuid[];
begin
 if not money_can('money.read') then return null; end if;
 amounts:=money_can('money.amount.read');
 clients:=array(select client_id from client_contact where org_id=current_org() and person_id=p_person);
 perform audit_write('restricted_read','money','contact:'||p_person,array[case when amounts then 'metadata,amount' else 'metadata' end]);
 return jsonb_build_object('amounts',amounts,'invoices',coalesce((select jsonb_agg(x order by x->>'date' desc) from (
   select jsonb_build_object('source','finance','number',r.body->>'number','date',r.body->>'date','client',(select display_name from client where id=mp.client_id),'clientId',mp.client_id,
    'party',r.body->>'client','total',case when amounts then (r.body->>'total')::numeric end,'due',case when amounts then nullif(r.body->>'balanceDue','')::numeric end,
    'status',case when coalesce(nullif(r.body->>'balanceDue','')::numeric,0)<=0 then 'paid' else 'open' end) x
   from pulse_priv.finance_live_record r join pulse_priv.money_party mp on mp.org_id=r.org_id and mp.party_key=value_key(r.body->>'client')
   where r.org_id=current_org() and r.kind='invoice' and not coalesce((r.body->>'test')::boolean,false) and mp.client_id=any(clients)
   union all
   select jsonb_build_object('source','erp','id',d.id,'number',d.number,'date',d.issue_date,'client',(select display_name from client where id=d.client_id),'clientId',d.client_id,
    'total',case when amounts then d.total/100.0 end,'due',case when amounts then (d.total-d.paid-d.credited)/100.0 end,'status',d.status,'type',d.doc_type) x
   from erp_document d where d.org_id=current_org() and d.client_id=any(clients) and d.status not in ('draft','cancelled')
   limit 60) y),'[]'));
end $$;

-- Links Pulse can propose from the data (never applied without an admin's click).
create function pulse.contact_link_suggestions(p_person uuid) returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_who text; v_email text; v_domain text; v_surname text; v_linked uuid[]; v_clients uuid[];
begin
 select p.display_name,cp.email into v_who,v_email from person p join contact_profile cp on cp.person_id=p.id where p.org_id=current_org() and p.id=p_person;
 if v_who is null then return '[]'; end if;
 v_who:=btrim(regexp_replace(regexp_replace(v_who,'^(mr|mrs|ms|dr)\.?\s+','','i'),'\s+',' ','g'));
 v_domain:=nullif(lower(split_part(coalesce(v_email,''),'@',2)),'');
 v_surname:=nullif(split_part(v_who,' ',array_length(string_to_array(v_who,' '),1)),'');
 v_clients:=array(select client_id from client_contact where org_id=current_org() and person_id=p_person);
 v_linked:=array(select project_id from project_contact where org_id=current_org() and person_id=p_person
  union select id from project where org_id=current_org() and client_id=any(v_clients));
 return coalesce((select jsonb_agg(s order by (s->>'score')::numeric desc) from (
  -- Projects whose Drive files name the contact in full (two words or more, at least 6 letters).
  (select jsonb_build_object('kind','project','id',pr.id,'name',coalesce(pr.title,pr.name),'why',count(*)||' Drive file'||case when count(*)=1 then '' else 's' end||' name '||v_who,
    'score',least(0.9,0.5+count(*)*0.05),'sample',(array_agg(coalesce(f.display_name,f.name) order by f.modified_at desc nulls last))[1]) s
   from index_file f join project pr on pr.id=f.project_id
   where f.org_id=current_org() and position(' ' in v_who)>0 and length(v_who)>=6 and pr.id<>all(v_linked)
    and (f.name ilike '%'||v_who||'%' or f.path ilike '%'||v_who||'%')
   group by pr.id order by count(*) desc limit 8)
  union all
  -- Clients with the contact's e-mail domain (not a free mailbox), or whose name carries the contact's surname.
  (select jsonb_build_object('kind','client','id',c.id,'name',c.display_name,
    'why',case when v_domain is not null and (v_domain=any(c.email_domains) or lower(split_part(coalesce(c.email,''),'@',2))=v_domain) then 'Same e-mail domain: '||v_domain else 'The client’s name has '||v_surname end,
    'score',case when v_domain is not null and (v_domain=any(c.email_domains) or lower(split_part(coalesce(c.email,''),'@',2))=v_domain) then 0.85 else 0.45 end) s
   from client c where c.org_id=current_org() and c.id<>all(v_clients) and c.client_type<>'internal'
    and ((v_domain is not null and v_domain not in ('gmail.com','yahoo.com','yahoo.co.in','hotmail.com','outlook.com','rediffmail.com','icloud.com')
      and (v_domain=any(c.email_domains) or lower(split_part(coalesce(c.email,''),'@',2))=v_domain))
     or (v_surname is not null and length(v_surname)>=5 and c.display_name ~* ('\m'||regexp_replace(v_surname,'([.*+?^${}()|\[\]\\])','\\\1','g')||'\M')))
   limit 6)) t),'[]');
end $$;

-- An admin links a contact to a project (as a named contact on it) or to a client.
create function pulse.contact_link(p_person uuid, p_kind text, p_id uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'An organisation admin links contacts' using errcode='42501'; end if;
 if not exists(select 1 from contact_profile where org_id=current_org() and person_id=p_person) then raise exception 'Contact not found' using errcode='22023'; end if;
 if p_kind='project' then
  if not exists(select 1 from project where org_id=current_org() and id=p_id) then raise exception 'Project not found' using errcode='22023'; end if;
  insert into project_contact(org_id,project_id,person_id,role,source) values(current_org(),p_id,p_person,'contact','pulse:suggested') on conflict do nothing;
 elsif p_kind='client' then
  if not exists(select 1 from client where org_id=current_org() and id=p_id) then raise exception 'Client not found' using errcode='22023'; end if;
  insert into client_contact(org_id,client_id,person_id,is_primary) values(current_org(),p_id,p_person,not exists(select 1 from client_contact where client_id=p_id and is_primary)) on conflict do nothing;
 else raise exception 'Link a project or a client' using errcode='22023';
 end if;
 insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
 values(current_org(),'contact',p_person,'link.'||p_kind,null,coalesce((select coalesce(title,name) from project where id=p_id),(select display_name from client where id=p_id)),current_viewer());
end $$;

revoke all on function pulse.contact_note_add(uuid,text),pulse.contact_note_remove(uuid),pulse.contact_money(uuid),pulse.contact_link_suggestions(uuid),pulse.contact_link(uuid,text,uuid) from public;
grant execute on function pulse.contact_note_add(uuid,text),pulse.contact_note_remove(uuid),pulse.contact_money(uuid),pulse.contact_link_suggestions(uuid),pulse.contact_link(uuid,text,uuid) to pulse_api;

-- migrate:down
-- Forward-only: notes are kept.
