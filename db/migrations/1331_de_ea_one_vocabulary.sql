-- migrate:up
-- DE-EA phase 2 (owner, 28 Oct 2026: "words like pods and clients must come from the company's chosen vocabulary"):
-- one vocabulary per company. The team word from Settings → Work (work_settings.team_label) and the words from Settings →
-- Industry & roles (org_pack.words) are read together (services/api/src/work-model.ts orgVocabulary, /api/v0/me
-- `vocabulary`); the pack's or company's own word wins. The neutral default is "Team", not one company's "Pod":
--   * work_settings_get answers "Team" when a company has not named its teams (was "Pod");
--   * work_settings_set stores any word but "Team" (was: any but "Pod"), and naming the team word here also clears a
--     team word the pack set, so the latest choice is the one word the company sees;
--   * the company that chose "Pod" (Estate Autopilots) keeps it as its own setting, so its people see no change.
create or replace function pulse.work_settings_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('businessModel',coalesce(s.business_model,'agency'),'aiAutoAcceptMax',s.ai_auto_accept_max,'teamLabel',coalesce(s.team_label,'Team'),'updatedAt',s.updated_at,
  'updatedBy',(select display_name from person where id=s.updated_by),'canEdit',coalesce(current_viewer() is not null and viewer_is('admin','leadership'),false),
  'reviewBy',coalesce(s.review_by,'assigner'),'reviewScale',coalesce(s.review_scale,'three'),'reviewLeaders',coalesce(s.review_leaders,'acknowledge'),
  'aboveBonus',coalesce(s.above_bonus,25),'helpPoints',coalesce(s.help_points,2),'reviewNudgeHours',coalesce(s.review_nudge_hours,24),
  'autoDone',coalesce(s.auto_done,'on'))
 from (select 1) x left join work_settings s on s.org_id=current_org()
$$;
-- 0420's setter; the default word is "Team" and a team word chosen here replaces the pack's.
create or replace function pulse.work_settings_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur work_settings;v_model text;v_max int;v_team text;v_by text;v_scale text;v_leaders text;v_bonus int;v_help int;v_nudge int;v_auto text;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins choose how Pulse names your work' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' then raise exception 'Choose a setting' using errcode='22023';end if;
 select * into cur from work_settings where org_id=current_org() for update;
 v_model:=case when p ? 'businessModel' then p->>'businessModel' else coalesce(cur.business_model,'agency') end;
 if v_model not in ('agency','product','internal') then raise exception 'Choose agency, product or internal' using errcode='22023';end if;
 begin v_max:=case when p ? 'aiAutoAcceptMax' then nullif(p->>'aiAutoAcceptMax','')::int else cur.ai_auto_accept_max end;
 exception when others then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end;
 if v_max is not null and v_max not between 1 and 100 then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end if;
 -- TASKS-4A's team word (0290) is kept as it was.
 v_team:=case when p ? 'teamLabel' then nullif(initcap(btrim(regexp_replace(coalesce(p->>'teamLabel',''),'\s+',' ','g'))),'') else cur.team_label end;
 if v_team='Team' then v_team:=null;end if;
 if v_team is not null and v_team !~ '^[[:alpha:]][[:alpha:] -]{1,19}$' then raise exception 'Call a team with one or two words, 2 to 20 letters' using errcode='22023';end if;
 v_by:=case when p ? 'reviewBy' then p->>'reviewBy' else coalesce(cur.review_by,'assigner') end;
 if v_by not in ('assigner','head','creator') then raise exception 'Choose who reviews: whoever assigned it, the head or whoever created it' using errcode='22023';end if;
 v_scale:=case when p ? 'reviewScale' then p->>'reviewScale' else coalesce(cur.review_scale,'three') end;
 if v_scale not in ('three','five') then raise exception 'Choose Great, Good, Needs work or a 1 to 5 rating' using errcode='22023';end if;
 v_leaders:=case when p ? 'reviewLeaders' then p->>'reviewLeaders' else coalesce(cur.review_leaders,'acknowledge') end;
 if v_leaders not in ('acknowledge','auto_proof','review') then raise exception 'Choose how leadership''s work is accepted' using errcode='22023';end if;
 v_auto:=case when p ? 'autoDone' then p->>'autoDone' else coalesce(cur.auto_done,'on') end;
 if v_auto not in ('on','ask') then raise exception 'Choose whether Pulse finishes tasks itself or asks' using errcode='22023';end if;
 begin
  v_bonus:=case when p ? 'aboveBonus' then (p->>'aboveBonus')::int else coalesce(cur.above_bonus,25) end;
  v_help:=case when p ? 'helpPoints' then (p->>'helpPoints')::int else coalesce(cur.help_points,2) end;
  v_nudge:=case when p ? 'reviewNudgeHours' then (p->>'reviewNudgeHours')::int else coalesce(cur.review_nudge_hours,24) end;
 exception when others then raise exception 'Enter whole numbers' using errcode='22023';end;
 if v_bonus not between 0 and 100 then raise exception 'The bonus for above and beyond is 0 to 100 percent' using errcode='22023';end if;
 if v_help not between 0 and 10 then raise exception 'Points for helping run from 0 to 10' using errcode='22023';end if;
 if v_nudge not between 4 and 168 then raise exception 'Nudge after 4 hours to 7 days' using errcode='22023';end if;
 insert into work_settings(org_id,business_model,ai_auto_accept_max,team_label,review_by,review_scale,review_leaders,above_bonus,help_points,review_nudge_hours,auto_done,updated_by)
 values(current_org(),v_model,v_max,v_team,v_by,v_scale,v_leaders,v_bonus,v_help,v_nudge,v_auto,current_viewer())
 on conflict(org_id) do update set business_model=excluded.business_model,ai_auto_accept_max=excluded.ai_auto_accept_max,team_label=excluded.team_label,review_by=excluded.review_by,review_scale=excluded.review_scale,
  review_leaders=excluded.review_leaders,above_bonus=excluded.above_bonus,help_points=excluded.help_points,review_nudge_hours=excluded.review_nudge_hours,auto_done=excluded.auto_done,
  updated_by=excluded.updated_by,updated_at=now();
 if p ? 'teamLabel' then update org_pack set words=words-'team'-'teams',updated_at=now() where org_id=current_org() and (words ? 'team' or words ? 'teams');end if;
 perform audit_write('work_settings_set','org',current_org()::text);
 return work_settings_get();
end $$;

-- The company that chose "Pod" keeps it (it was the code default it relied on).
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'estateautopilots';
  if v_org is null then return; end if;
  perform pulse.acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'migration 1331 (DE-EA)', true);
  insert into pulse.work_settings(org_id, team_label) values (v_org, 'Pod')
  on conflict (org_id) do update set team_label = coalesce(pulse.work_settings.team_label, 'Pod');
  perform pulse.acct_leave();
end $$;

-- migrate:down
-- Forward-only: a company's words are kept.
