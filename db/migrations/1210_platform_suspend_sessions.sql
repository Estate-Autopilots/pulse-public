-- migrate:up
-- PULSE-ADMIN (owner, 27 Oct 2026): suspending an organisation ends its sessions inside that organisation (row security
-- lets the console end them only there; 1140 ended none). The tenant-isolation suite checks it.
create or replace function pulse.platform_org_set(p_org uuid, p jsonb, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_changes jsonb := '{}'; v_status text := p ->> 'status'; v_ended int := 0;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if v_status is not null and v_status is distinct from o.status then
    if v_status not in ('active', 'suspended') then raise exception 'Choose active or suspended' using errcode = '22023'; end if;
    if p_org = install_org() then raise exception 'The install''s own organisation cannot be suspended here' using errcode = '22023'; end if;
    if o.status = 'setup' then raise exception 'This organisation is still being set up: finish it under Companies' using errcode = '22023'; end if;
    update org set status = v_status where id = p_org;
    if v_status = 'suspended' then
      perform platform_enter(p_org);
      update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
      get diagnostics v_ended = row_count;
      perform platform_leave();
    end if;
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_array(o.status, v_status), 'sessionsEnded', v_ended);
  end if;
  if p ? 'plan' or p ? 'seatLimit' or p ? 'aiTokensMonth' or p ? 'trialEnds' or p ? 'note' then
    insert into pulse_priv.platform_plan(for_org) values (p_org) on conflict (for_org) do nothing;
    update pulse_priv.platform_plan set
      plan = case when p ? 'plan' then p ->> 'plan' else plan end,
      seat_limit = case when p ? 'seatLimit' then nullif(p ->> 'seatLimit', '')::int else seat_limit end,
      ai_tokens_month = case when p ? 'aiTokensMonth' then nullif(p ->> 'aiTokensMonth', '')::bigint else ai_tokens_month end,
      trial_ends = case when p ? 'trialEnds' then nullif(p ->> 'trialEnds', '')::date else trial_ends end,
      note = case when p ? 'note' then nullif(btrim(p ->> 'note'), '') else note end,
      updated_at = now(), updated_by = (select display_name from person where id = current_viewer())
     where for_org = p_org;
    v_changes := v_changes || (p - 'status');
  end if;
  perform platform_log(case when v_changes ? 'status' then 'org.' || v_status else 'org.plan' end, p_org, 'org', p_org::text, o.name, v_reason, v_changes);
  return v_changes;
end $$;


-- migrate:down
-- 1140's version stays in place on the way down (it ends no sessions); nothing to undo here.
select 1;
