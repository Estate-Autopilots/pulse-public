-- migrate:up
-- FEATURES-1024 (bug found by CONNECT, 23 Oct 2026): an "insert … on conflict" of an organisation that already exists
-- (the Drive collector upserts its organisation row every run) ran org_handle_default (0920) as if it were new and
-- reserved a fresh handle for it each time: estateautopilots2 … estateautopilots185 on dev, two every ten minutes.
-- An organisation that already exists keeps its handle and reserves nothing; the leaked reservations (the org's own
-- handle followed by digits, never its current handle) are released. Only objects from 0920 are used.
create or replace function pulse.org_handle_default() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if tg_op = 'INSERT' and exists (select 1 from org where id = new.id) then return new; end if;
  if tg_op = 'INSERT' and new.handle is null then new.handle := handle_suggest(new.name); end if;
  if new.handle is not null and not exists (select 1 from pulse_priv.handle_name where handle = new.handle) then
    insert into pulse_priv.handle_name(handle, kind, ref) values (new.handle, 'org', new.id);
  end if;
  return new;
end $$;
revoke all on function pulse.org_handle_default() from public;

delete from pulse_priv.handle_name h
 using pulse.org o
 where h.kind = 'org' and h.ref = o.id and o.handle is not null and h.handle <> o.handle
   and left(h.handle, length(o.handle)) = o.handle and substr(h.handle, length(o.handle) + 1) ~ '^[0-9]+$';

-- migrate:down
-- Forward-only.
