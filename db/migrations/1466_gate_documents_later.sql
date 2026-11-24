-- migrate:up
-- WELCOME-UNSTUCK (owner, 4 Nov 2026: a new person reached "Nearly there · Still to add: Aadhaar (masked), PAN card.
-- Pulse opens as soon as these are in." with no button at all and could not move). ID documents no longer hold Pulse
-- closed: the gate waits only for the profile itself (details, work, bank, photo). Missing documents stay on the
-- person's list ('later') and on HR → Onboard team, and Pulse keeps reminding; HR still verifies them there.
-- Nobody with a finished profile is ever held at /welcome for a file they may not have to hand.

create or replace function pulse.onboarding_gate(p_files boolean default true) returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); m text[]; core text[]; skip timestamptz; owner boolean;
begin
 if me is null or current_org() is null then return jsonb_build_object('enabled',false,'blocked',false); end if;
 if not onboarding_gate_enabled() then return jsonb_build_object('enabled',false,'blocked',false); end if;
 if not exists(select 1 from person p where p.id=me and p.org_id=current_org() and p.side='staff' and p.status='active')
  or exists(select 1 from agent_member a where a.person_id=me) or is_accountant(me) then
  return jsonb_build_object('enabled',true,'blocked',false);
 end if;
 m:=onboarding_missing(me);
 if not p_files then m:=array_remove(m,'bank'); end if;
 core:=coalesce((select array_agg(x) from unnest(m) x where x not like 'doc:%'),'{}');
 owner:=onboarding_gate_owner();
 select gate_skip_until into skip from pulse_priv.person_onboarding where org_id=current_org() and person_id=me;
 return jsonb_build_object('enabled',true,'blocked',cardinality(core)>0 and not (owner and coalesce(skip>now(),false)),
  'missing',to_jsonb(core),'later',to_jsonb(coalesce((select array_agg(x) from unnest(m) x where x like 'doc:%'),'{}')),
  'canSkip',owner,'skippedUntil',case when owner then skip end);
end $$;

-- migrate:down
-- The 1195 definition comes back by re-running that migration's function body; documents would hold Pulse closed again.
