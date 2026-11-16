-- migrate:up
-- TWO-STEP-GUIDE (owner, 30 Oct 2026: "a compulsory setup, most smooth, in a floating window, for all who need it, me
-- included"): who must set up two-step now. The organisation requires it, the person holds admin, HR or leadership (as
-- auth_enforcement), is not the exempt owner, signs in with a Pulse password and has no authenticator yet. Unlike
-- auth_enforcement it does not wait for the grace period: the guided window asks from the first sign-in, and nothing
-- is refused (TWO-STEP-NUDGE).
create function pulse.auth_two_step_due(a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_policy where org_id = current_org() and required and a is distinct from exempt_owner)
     and exists (select 1 from role_assignment where org_id = current_org() and person_id = a and role_key in ('admin', 'hr', 'leadership')
                  and current_date between valid_from and coalesce(valid_to, 'infinity'))
     and exists (select 1 from login_credential where org_id = current_org() and person_id = a and status = 'active')
     and not exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = a and totp is not null)
$$;
revoke all on function pulse.auth_two_step_due(uuid) from public;
grant execute on function pulse.auth_two_step_due(uuid) to pulse_api;

-- Starting setup again keeps the key already waiting, so the phone entry from the first try still works (Datup's two
-- tries on 30 Oct failed when the second start replaced the key his phone held). Only while setup is unfinished and for
-- at most 24 hours; "Start over with a new key" (fresh) always makes a new one. A key waiting from before this
-- migration has no time and is never reused.
alter table pulse_priv.auth_account add column pending_totp_at timestamptz;
create function pulse.auth_totp_pending(r text, a uuid, key_hex text, fresh boolean) returns bytea
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare kept bytea; s bytea;
begin
  if not fresh then
    select pgp_sym_decrypt_bytea(pending_totp, key_hex) into kept from pulse_priv.auth_account
     where org_id = current_org() and realm = r and actor = a and totp is null and pending_totp is not null
       and pending_totp_at > now() - interval '24 hours';
  end if;
  if kept is not null then
    update pulse_priv.auth_account set last_step = -1 where org_id = current_org() and realm = r and actor = a;
    return kept;
  end if;
  s := gen_random_bytes(20);
  insert into pulse_priv.auth_account(org_id, realm, actor, pending_totp, pending_totp_at) values (current_org(), r, a, pgp_sym_encrypt_bytea(s, key_hex), now())
  on conflict (org_id, realm, actor) do update set pending_totp = excluded.pending_totp, pending_totp_at = now(), last_step = -1;
  return s;
end $$;
revoke all on function pulse.auth_totp_pending(text, uuid, text, boolean) from public;
do $$ declare def text := pg_get_functiondef('pulse.auth_account_action'::regproc); fixed text; begin
  fixed := regexp_replace(def, 'secret:=gen_random_bytes\(20\);\s*insert into pulse_priv\.auth_account\(org_id,realm,actor,pending_totp\) values[^;]*;',
                          'secret:=auth_totp_pending(r,a,key_hex,coalesce((b->>''fresh'')::boolean,false));');
  if fixed = def then raise exception 'auth_account_action: the totp-start lines were not found'; end if;
  execute fixed;
end $$;

-- migrate:down
do $$ declare def text := pg_get_functiondef('pulse.auth_account_action'::regproc); fixed text; begin
  fixed := replace(def, 'secret:=auth_totp_pending(r,a,key_hex,coalesce((b->>''fresh'')::boolean,false));',
                   E'secret:=gen_random_bytes(20);\n  insert into pulse_priv.auth_account(org_id,realm,actor,pending_totp) values(current_org(),r,a,pgp_sym_encrypt_bytea(secret,key_hex))\n  on conflict(org_id,realm,actor) do update set pending_totp=excluded.pending_totp,last_step=-1;');
  if fixed <> def then execute fixed; end if;
end $$;
drop function if exists pulse.auth_totp_pending(text, uuid, text, boolean);
alter table pulse_priv.auth_account drop column if exists pending_totp_at;
drop function if exists pulse.auth_two_step_due(uuid);
