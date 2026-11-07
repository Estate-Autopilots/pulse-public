-- migrate:up
-- R27 remains the only delivery path. Bell rows are independent of ping preferences.
select pulse.check_values_add('pulse.notification'::regclass,'notification_event_type_check','event_type',array['update.posted']);
select pulse.check_values_add('pulse.notification'::regclass,'notification_subject_type_check','subject_type',array['update']);
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type=''update.posted'' then
  return p_subject=''update'' and exists(select 1 from update_post u where u.org_id=current_org() and u.id=p_id and p_person=any(u.audience));
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;

create function pulse.update_post_notify() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare recipient uuid;
begin
 for recipient in select distinct unnest(new.audience) loop
  perform notification_emit(recipient,'update.posted','update',new.id,new.id::text,
   'New update from '||work_first_name(new.on_behalf_id),'/updates/'||new.id,'update');
 end loop;
 return new;
end $$;
revoke all on function pulse.update_post_notify() from public;
create trigger update_post_notify after insert on pulse.update_post
 for each row execute function pulse.update_post_notify();
-- migrate:down
-- Forward-only. Retain the inbox and provider receipts.
