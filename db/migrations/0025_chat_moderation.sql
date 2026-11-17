-- migrate:up
-- Organisation admins can moderate company channels. Direct messages remain participant-only.
create or replace function pulse.chat_has(p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select chat_active() and (
 exists(select 1 from chat_member where org_id=current_org() and channel_id=p_channel and person_id=current_viewer()) or
 viewer_is('admin') and exists(select 1 from chat_channel where id=p_channel and kind<>'direct'))
$$;
-- migrate:down
