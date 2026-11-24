-- migrate:up
-- Explicit account views remain account observations. Personal views accept only qualified uploader evidence.
create function pulse.delivery_matches(p_file text,p_scope text) returns boolean language sql stable security invoker set search_path=pulse,pg_temp as $$
 select p_scope is null or case when p_scope like 'person:%' then
 exists(select 1 from delivery_actor a where a.file_id=p_file and a.actor_id=nullif(substr(p_scope,8),'')::uuid)
 else exists(select 1 from delivery d where d.file_id=p_file and d.uploader_account=p_scope) end
$$;
revoke all on function pulse.delivery_matches(text,text) from public;
grant execute on function pulse.delivery_matches(text,text) to pulse_api,pulse_worker;
-- migrate:down
