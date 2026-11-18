-- ONBOARD-GATE journey fixture for pulse-dev's demo company (Northstar Realty Media (demo)); synthetic person only.
-- psql -v temp=<issued password> -f onboard-gate-demo.sql. Re-running resets the person to "never signed in".
\set ON_ERROR_STOP 1
begin;
select set_config('pulse.org_id','5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873',true);
-- A password address for the demo company (pulse-dev's own addresses sign in through Access).
insert into pulse.org_domain(host,org_id,sign_in,is_primary,added_by) values
 ('onboard-demo.localhost','5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','password',false,'onboard-gate fixture')
 on conflict do nothing;
insert into pulse.onboarding_gate_setting(org_id,enabled) values('5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873',true)
 on conflict(org_id) do update set enabled=true;
insert into pulse.person(id,org_id,display_name,side,status) values('0b0a7d00-0000-4000-8000-00000000a001','5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','Synthetic Joiner','staff','active')
 on conflict(id) do update set status='active';
insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,joined_on)
 values('5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','0b0a7d00-0000-4000-8000-00000000a001','Video Editor','Pod 2','onboard-gate fixture','synthetic.joiner','2026-10-27')
 on conflict(person_id) do update set skills='{}';
delete from pulse_priv.identity_document where person_id='0b0a7d00-0000-4000-8000-00000000a001';
delete from pulse_priv.hr_contact where person_id='0b0a7d00-0000-4000-8000-00000000a001';
delete from pulse_priv.person_onboarding where person_id='0b0a7d00-0000-4000-8000-00000000a001';
delete from pulse.person_photo where person_id='0b0a7d00-0000-4000-8000-00000000a001';
delete from pulse.login_session where person_id='0b0a7d00-0000-4000-8000-00000000a001';
-- Known to HR already (prefilled): date of birth. Everything else the person adds.
insert into pulse_priv.person_onboarding(org_id,person_id,details) values('5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','0b0a7d00-0000-4000-8000-00000000a001','{"dob":"1998-04-12"}');
-- A synthetic photo (a 1x1 PNG), as if taken on the phone.
insert into pulse.person_photo(org_id,person_id,mime,bytes) values('5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','0b0a7d00-0000-4000-8000-00000000a001','image/png',
 decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64'));
insert into pulse.login_credential(org_id,person_id,password_hash,must_change) values('5d0c2a5e-6f1b-4c1e-9a77-6e6f72746873','0b0a7d00-0000-4000-8000-00000000a001',public.crypt(:'temp',public.gen_salt('bf',10)),true)
 on conflict(person_id) do update set password_hash=excluded.password_hash,must_change=true,status='active',failed_attempts=0,locked_until=null;
commit;
