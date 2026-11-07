-- migrate:up
-- RELEASE-5: a kind of work for setting things up and running the office, so Pip reads "Add the office Wi-Fi and IP in
-- Office presence, and test arrival check-in with 2 people" as HR and operations' setup and admin work. Before, the
-- first kind whose words appeared won, and client service's "check-in with" (a call) caught Pulse's own attendance
-- check-in: the owner's task read as client service, 15 minutes, 1 point.
-- "Setup and admin" sits after the creative kinds and before client service, with words only office and tool set-up
-- uses (Wi-Fi, IP, Office presence, geofences, check-in settings, routers, internet, printers, laptops, Workspace and
-- e-mail accounts, access cards, the holiday list).
-- Every company that already has the shared vocabulary gets it (one it named itself under the same key stays as it is);
-- a new company gets it with the rest on first use.
-- Open work whose kind was read as client service before, that nobody has valued yet and whose title now reads as
-- setup and admin, is read again (on production: the owner's Office presence task). Finished, valued and deleted work
-- keeps its kind; the audit trigger records each change.
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.work_category_seed()'::regprocedure);
 changed:=replace(definition,
  $o$('client_service','Client service',$o$,
  $n$('setup_admin','Setup and admin',array['wi-?fi','ip\M','office presence','geofenc','check-?in settings?','router','internet','broadband','printers?\M','laptops?\M','google workspace','e-?mail accounts?','access cards?','holiday list','office set-?up'],85),
  ('client_service','Client service',$n$);
 if changed=definition then raise exception 'work_category_seed changed shape';end if;
 execute changed;
end $$;
do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 -- Companies in turn (work_category is FORCE RLS: only the company in scope is visible), as 0155 does.
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  continue when not exists(select 1 from pulse.work_category where org_id=o);
  insert into pulse.work_category(org_id,key,label,keywords,position)
  values(o,'setup_admin','Setup and admin',array['wi-?fi','ip\M','office presence','geofenc','check-?in settings?','router','internet','broadband','printers?\M','laptops?\M','google workspace','e-?mail accounts?','access cards?','holiday list','office set-?up'],85)
  on conflict do nothing;
  update pulse.task set category='setup_admin'
   where org_id=o and category='client_service' and deleted_at is null and status in ('open','in_progress','blocked')
     and value_points is null and pulse.work_category_guess(concat_ws(' ',title,deliverable_type))='setup_admin';
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;

-- migrate:down
-- Forward-only.
