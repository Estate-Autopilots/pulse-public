-- migrate:up
-- Advertise each supported/denied/unavailable source without inventing capability or resource measurements.
alter table pulse.native_device add column capabilities jsonb not null default '{}';
alter table pulse.native_ack add column at timestamptz not null default now();
alter table pulse.native_batch add column at timestamptz not null default now();
create function pulse.native_prune() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare raw integer;acks integer;batches integer;tokens integer;begin
 delete from native_event e where e.org_id=current_org() and (e.at<now()-interval '7 days' or exists(
 select 1 from native_permission p join pulse_priv.fair_notice n on n.id=p.notice_id and n.org_id=p.org_id
 where p.id=e.consent_receipt and p.org_id=e.org_id and (n.withdrawn_at is not null or e.at<now()-greatest(1,least(7,(n.body->>'rawDays')::int))*interval '1 day')));
 get diagnostics raw=row_count;
 delete from native_ack where org_id=current_org() and at<now()-interval '7 days';get diagnostics acks=row_count;
 delete from native_batch where org_id=current_org() and at<now()-interval '7 days';get diagnostics batches=row_count;
 delete from pulse_priv.native_token where org_id=current_org() and refresh_until<now()-interval '7 days';get diagnostics tokens=row_count;
 return jsonb_build_object('eventsRemoved',raw,'sourceAcksRemoved',acks,'batchesRemoved',batches,'expiredTokensRemoved',tokens);
end $$;
revoke all on function pulse.native_prune() from public;grant execute on function pulse.native_prune() to pulse_worker;
create function pulse.native_is_staff() returns boolean language sql security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from person where org_id=current_org() and id=current_viewer() and side='staff' and status='active')
$$;
revoke all on function pulse.native_is_staff() from public;grant execute on function pulse.native_is_staff() to pulse_api;
create function pulse.native_project_allowed(pr uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform delivery_access(pr,false);return true;exception when insufficient_privilege then return false;end $$;
revoke all on function pulse.native_project_allowed(uuid) from public;grant execute on function pulse.native_project_allowed(uuid) to pulse_api;
-- migrate:down
