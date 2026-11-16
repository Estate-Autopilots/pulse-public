-- migrate:up
-- TWO-STEP-GUIDE (30 Oct 2026): someone signed in through their Pulse account (the organisation switcher, or the account
-- sign-in at an address) proves it is them for account security with the Pulse account's password as well as the
-- organisation's own, so the guided two-step window works for them too. A wrong password is refused as before; a
-- person with no organisation password of their own (old_hash null) is still refused.
create function pulse.auth_account_password_ok(r text, a uuid, pw text) returns boolean
  language sql stable security definer set search_path = pulse, public, pg_temp as $$
  select r = 'staff' and octet_length(coalesce(pw, '')) between 1 and 72 and exists (
    select 1 from pulse_priv.account_member m join pulse_priv.pulse_account pa on pa.id = m.account_id
     where m.person_id = a and m.member_org = current_org() and pa.password_hash is not null and pa.password_hash = crypt(pw, pa.password_hash))
$$;
revoke all on function pulse.auth_account_password_ok(text, uuid, text) from public;
do $$ declare def text := pg_get_functiondef('pulse.auth_account_action'::regproc); fixed text; begin
  fixed := replace(def, 'old_hash<>crypt(coalesce(b->>''current'',''''),old_hash) then', '(old_hash<>crypt(coalesce(b->>''current'',''''),old_hash) and not auth_account_password_ok(r,a,b->>''current'')) then');
  if fixed = def then raise exception 'auth_account_action: the password check was not found'; end if;
  execute fixed;
end $$;

-- migrate:down
do $$ declare def text := pg_get_functiondef('pulse.auth_account_action'::regproc); fixed text; begin
  fixed := replace(def, '(old_hash<>crypt(coalesce(b->>''current'',''''),old_hash) and not auth_account_password_ok(r,a,b->>''current'')) then', 'old_hash<>crypt(coalesce(b->>''current'',''''),old_hash) then');
  if fixed = def then raise exception 'auth_account_action: the password check was not found'; end if;
  execute fixed;
end $$;
drop function if exists pulse.auth_account_password_ok(text, uuid, text);
