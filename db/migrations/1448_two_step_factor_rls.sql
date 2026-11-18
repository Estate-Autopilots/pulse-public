-- migrate:up
-- TWO-STEP-FACTORS: the passkey and WebAuthn-challenge tables keep each organisation's rows under its own row security,
-- like the other private sign-in tables (0104): forced, the current organisation only. Reached only through the
-- SECURITY DEFINER functions of the factors migration; no grants to any runtime role.
alter table pulse_priv.auth_passkey enable row level security;
alter table pulse_priv.auth_passkey force row level security;
create policy tenant on pulse_priv.auth_passkey using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse_priv.auth_webauthn enable row level security;
alter table pulse_priv.auth_webauthn force row level security;
create policy tenant on pulse_priv.auth_webauthn using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- migrate:down
drop policy if exists tenant on pulse_priv.auth_webauthn;
alter table pulse_priv.auth_webauthn no force row level security;
alter table pulse_priv.auth_webauthn disable row level security;
drop policy if exists tenant on pulse_priv.auth_passkey;
alter table pulse_priv.auth_passkey no force row level security;
alter table pulse_priv.auth_passkey disable row level security;
