-- migrate:up
-- FEATURES-1024 (AI-EMP-V2 "proposals do not expire yet; the state expired is reserved"): what an AI employee asked a
-- person to approve and nobody answered for three days is closed as Expired (its card says so; nothing is posted or
-- created later from a stale ask). Each AI employee's runtime closes its own once an hour. A waiting "needs more
-- budget" ask that expires leaves its work waiting as it was (it is tried again after its two weeks). Additive; only
-- objects from this repository's migrations are used (0952, 0988).
create function pulse.agent_proposals_expire() returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); n int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  update agent_proposal set state = 'expired' where org_id = current_org() and agent_id = me and state = 'pending' and created_at < now() - interval '72 hours';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function pulse.agent_proposals_expire() from public;
grant execute on function pulse.agent_proposals_expire() to pulse_api;

-- migrate:down
-- Forward-only.
