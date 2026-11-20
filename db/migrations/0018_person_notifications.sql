-- migrate:up
create table pulse_priv.telegram_person (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
 chat_id text not null check(chat_id ~ '^[1-9][0-9]{4,15}$'), verified_by uuid not null references pulse.person(id),
 verified_at timestamptz not null default now(),primary key(org_id,person_id),unique(org_id,chat_id)
);
alter table pulse_priv.telegram_person enable row level security;
alter table pulse_priv.telegram_person force row level security;
create policy tenant_isolation on pulse_priv.telegram_person using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.telegram_person to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.telegram_person for each row execute function pulse.audit_mutation();
create function pulse.telegram_connect(p_person uuid,p_chat text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 if not exists(select 1 from person where id=p_person and side='staff') then raise exception 'staff person missing' using errcode='22023'; end if;
 if p_chat is null then delete from pulse_priv.telegram_person where person_id=p_person;
 update notification set telegram_status='recipient_not_connected' where person_id=p_person and telegram_status in('queued','failed');
 else
 insert into pulse_priv.telegram_person(org_id,person_id,chat_id,verified_by) values(current_org(),p_person,p_chat,current_viewer())
 on conflict(org_id,person_id) do update set chat_id=excluded.chat_id,verified_by=excluded.verified_by,verified_at=now();
 update notification set telegram_status='queued' where person_id=p_person and telegram_status='recipient_not_connected' and created_at>now()-interval '7 days';
 end if;
end $$;
create function pulse.telegram_connections() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'admin required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('personId',person_id,'at',verified_at)) from pulse_priv.telegram_person),'[]');
end $$;
create or replace function pulse.notify_decision() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.status is distinct from old.status and new.status in ('approved','rejected') then
 insert into notification(org_id,person_id,title,href,telegram_status) values(new.org_id,new.person_id,
 case when TG_TABLE_NAME='leave_request' then 'Leave request ' else 'Attendance correction ' end||new.status,'/me',
 case when exists(select 1 from pulse_priv.telegram_person where person_id=new.person_id) then 'queued' else 'recipient_not_connected' end);
 end if; return null;
end $$;
revoke all on function pulse.telegram_connect(uuid,text),pulse.telegram_connections() from public;
grant execute on function pulse.telegram_connect(uuid,text),pulse.telegram_connections() to pulse_api;
-- migrate:down
