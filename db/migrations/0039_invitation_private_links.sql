-- migrate:up
-- HR/admin may prepare a private setup link before mailing. It is still single-use, hashed and seven-day scoped.
create function pulse.invitation_link(p_person uuid,p_batch uuid,p_hash text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
 if not viewer_is('admin') and exists(select 1 from role_assignment where person_id=p_person and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then raise exception 'admin manages leadership credentials' using errcode='42501';end if;
 if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid token' using errcode='22023';end if;
 update pulse_priv.staff_invitation set token_hash=p_hash,expires_at=now()+interval '7 days' where person_id=p_person and batch_id=p_batch and status='prepared'
 and exists(select 1 from person where id=p_person and status='active') and not exists(select 1 from login_credential where person_id=p_person and status='disabled');
 if not found then raise exception 'Invitation changed; preview it again' using errcode='40001';end if;
 perform audit_write('prepare_link','staff_invitation',p_person::text);
end $$;
revoke all on function pulse.invitation_link(uuid,uuid,text) from public;
grant execute on function pulse.invitation_link(uuid,uuid,text) to pulse_api;
do $$ declare definition text;begin
 definition:=pg_get_functiondef('pulse.invitation_redeem(text,text)'::regprocedure);
 if position('i.status=''sent''' in definition)=0 then raise exception 'Invitation redeem definition changed';end if;
 execute replace(definition,'i.status=''sent''','i.status in(''sent'',''prepared'')');
end $$;
-- migrate:down
