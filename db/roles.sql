-- =====================================================================================================================
-- Pulse database roles (spec appendix A0). Run ONCE per PostgreSQL cluster by the database administrator (on the
-- first tenant's VPS: root, because eadev has no admin credentials), BEFORE the migrations in db/migrations.
-- Passwords are set out of band (secrets broker / root-only env files); never in git.
-- Done on host-49a12d.internal.example by root on 2026-10-05 (database `pulse`); scratch and CI databases get the same roles from
-- `pulse-migrate --bootstrap-scratch`.
-- =====================================================================================================================
create role pulse_owner   nologin;                 -- owns all objects; migrations run as a login role that is a member
create role pulse_api     nologin;                 -- the TypeScript API
create role pulse_worker  nologin;                 -- collectors, normaliser, projectors, ml jobs
create role pulse_ingest  nologin;                 -- /v1/events and /hooks/*
create role pulse_privacy nologin;                 -- redaction, retention, privacy requests

-- Login roles (one per service), each a member of exactly one group role:
--   create role pulse_migrator_login login password '<secret>' in role pulse_owner;
--   create role pulse_api_login      login password '<secret>' in role pulse_api;
--   create role pulse_worker_login   login password '<secret>' in role pulse_worker;
--   create role pulse_ingest_login   login password '<secret>' in role pulse_ingest;
--   create role pulse_privacy_login  login password '<secret>' in role pulse_privacy;
--   create database pulse owner pulse_owner;
--   \c pulse
--   create extension vector; create extension pg_trgm; create extension pgcrypto;
-- CONNECT per login, never per group role or PUBLIC, so a login for one environment's database (staging, CI, dev:
-- members of the same group roles) can never connect to another's:
--   revoke connect, temporary on database pulse from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
--   grant connect, temporary on database pulse to pulse_migrator_login, pulse_api_login, pulse_worker_login,
--                                                 pulse_ingest_login, pulse_privacy_login;
-- Other environments get their own owner role (pulse_<env>_owner owns database pulse_<env>; its migration login is a
-- member of that role only) and the same revoke from public; watchdog/pulse-root-actions.sh does this on the server.
-- None of these roles has SUPERUSER or BYPASSRLS (ADR-0005).
