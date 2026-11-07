-- migrate:up
-- UX-TASKS-2: a company gets the shared kinds of work on first use (its first task, domain or category) instead of the
-- moment it is created. Creating a company now writes nothing else, so an organisation that is refused or removed at
-- installation leaves no rows behind (tests/core/test_000_install.py deletes its probe company).
drop trigger work_category_follow_org on pulse.org;
drop function pulse.work_category_follow_org();
create function pulse.work_category_ensure() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is not null and not exists(select 1 from work_category where org_id=current_org()) then perform work_category_seed();end if;
end $$;
create or replace function pulse.task_category_default() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.category is null then
  perform work_category_ensure();
  new.category:=work_category_guess(concat_ws(' ',new.title,new.deliverable_type));
 end if;
 return new;
end $$;
-- Saving a task, proposing a domain and naming a kind of work make sure the vocabulary is there first.
do $$
declare f text;definition text;changed text;needle text;
begin
 foreach f in array array['pulse.task_save(uuid,jsonb)','pulse.work_domain_propose(uuid,jsonb)','pulse.work_category_save(jsonb)'] loop
  definition:=pg_get_functiondef(f::regprocedure);
  needle:=substring(definition from '\$function\$\s*declare');
  if needle is null then raise exception '% changed shape',f;end if;
  changed:=regexp_replace(definition,'\nbegin\n',E'\nbegin\n perform work_category_ensure();\n');
  if changed=definition then raise exception '% changed shape',f;end if;
  execute changed;
 end loop;
end $$;
revoke all on function pulse.work_category_ensure() from public;
grant execute on function pulse.work_category_ensure() to pulse_api,pulse_worker;
-- migrate:down
-- Forward-only.
