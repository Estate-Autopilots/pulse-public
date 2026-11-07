-- migrate:up
-- ATT fix (22 Oct 2026, found by the end-to-end run on pulse-dev): when the first moment Pulse is sure someone is at the
-- office is also the moment their arrival has already lasted the dwell, the engine asked "You're at the office. Check
-- in?" (a ping that needs them) and then checked them in by itself three minutes later, leaving the question in the
-- bell. That is the usual Android arrival on the office network: the geofence reports only after Android's own loitering
-- delay (`dwelled`, POLISH-2), together with the office public IP (geofence 50 + network 40 = 90). With automatic
-- check-in on and the signals already sure, the arrival question is never asked: the check-in follows within the dwell.
-- The question stays for everyone else (automatic check-in off, or only one decent signal).
do $$
declare
  definition text := pg_get_functiondef('pulse.presence_decide(timestamptz,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  arrival text := 'if st->>''holdingSince'' is not null and p_now-(st->>''holdingSince'')::timestamptz>=dwell then';
begin
  if position(arrival in definition) = 0 then raise exception 'presence_decide arrival rule changed'; end if;
  execute replace(definition, arrival,
    'if st->>''holdingSince'' is not null and p_now-(st->>''holdingSince'')::timestamptz>=dwell and not (confident and coalesce((p_rules->>''autoCheckIn'')::boolean,false)) then');
end $$;

-- migrate:down
-- Forward-only.
