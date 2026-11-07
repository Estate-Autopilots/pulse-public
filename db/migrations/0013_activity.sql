-- migrate:up
-- Only an unambiguous upload/create observation may describe an uploader; edit/owner metadata does not.
create view pulse.delivery_actor with (security_invoker=true,security_barrier=true) as
 select org_id,file_id,
 case when count(distinct nullif(actor_account,''))=1 then max(nullif(actor_account,'')) end actor_account,
 case when count(distinct actor_id)=1 and count(distinct nullif(actor_account,''))=1 then (array_agg(actor_id) filter(where actor_id is not null))[1] end actor_id,
 case when count(distinct nullif(actor_account,''))=1 then max(human_attribution) else 'Conflicting / missing uploader observations' end basis
 from pulse.activity_observation where operation in ('upload','create') and file_id is not null group by org_id,file_id;
grant select on pulse.delivery_actor to pulse_api,pulse_worker;
create unique index person_shift_effective on pulse.person_shift(org_id,person_id,mode,valid_from);
create trigger audit_mutation after insert or update or delete on pulse.phase for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.project_location_member for each row execute function pulse.audit_mutation();
-- Imported source folder associations are read-only to staff; only admins can edit the business projection.
create policy index_record_update on pulse.index_file as restrictive for update to pulse_api using(pulse.viewer_is('admin')) with check(pulse.viewer_is('admin'));
create policy delivery_record_update on pulse.delivery as restrictive for update to pulse_api using(pulse.viewer_is('admin')) with check(pulse.viewer_is('admin'));
-- migrate:down
