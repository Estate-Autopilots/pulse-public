#!/bin/bash
# AGENTS-LIVE (7 Nov 2026): keep every AI employee of every organisation connected to production's runtime, without an
# operator remembering to. Root cause it closes: an AI employee was only served when someone ran connect-prod.sh for it
# (Willow Lane's bhrātā never was, so it showed "not connected" and answered nothing), and its 90-day key then expired.
# Each run (root, from pulse-prod-coworker-connect.timer, daily and after each release):
#   - every active, answering (not post-only), switched-on AI employee of every active organisation that no runtime
#     config lists gets a key (services/coworker/connect.sh, issued as one of its organisation's admins, audited by
#     prefix) in <dir>/<org code lower>.json when that file exists (an organisation with its own runtime unit, e.g.
#     wl.json for Willow Lane), else in prod.json;
#   - one whose newest live key ends within 14 days gets a fresh key in the config that lists it (old one revoked);
#   - the runtimes restart only when something changed. Prints what it did; no key is ever printed.
# Install: see services/coworker/prod/README.md (AGENTS-LIVE).
set -euo pipefail
export PATH=/home/eadev/.local/opt/node/bin:$PATH
D=${PULSE_COWORKER_DIR:-/home/eadev/.config/pulse-coworker-prod}
WT=${PULSE_COWORKER_WORKTREE:-/home/eadev/work/pulse/coworker-prod}
HERE=$(cd "$(dirname "$0")/.." && pwd)
CONNECT=$HERE/connect.sh; [ -x "$CONNECT" ] || CONNECT=$WT/services/coworker/connect.sh
. /etc/estate-autopilots/db/pulse.env
tmp=$(mktemp -d); chmod 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT
printf '%s\n' '. /etc/estate-autopilots/db/pulse.env' 'MIGRATE_DATABASE_URL="$PULSE_DATABASE_URL_MIGRATE"' > "$tmp/env"
q() { PGOPTIONS="-c role=pulse_owner" psql "$PULSE_DATABASE_URL_MIGRATE" -At -q -v ON_ERROR_STOP=1 -F '|' "$@"; }
listed=$(node -e 'const fs=require("fs"),d=process.argv[1];for(const f of fs.readdirSync(d).filter(x=>x.endsWith(".json"))){try{for(const a of JSON.parse(fs.readFileSync(d+"/"+f,"utf8")).agents??[])console.log(a.username+"|"+f)}catch{}}' "$D")
# Every organisation's AI employees, read inside that organisation (row security): code|username|days left.
rows() {
  for code in $(q -c "select code from pulse.org where status = 'active' order by code"); do
    q -c "select set_config('pulse.org_id',(select id::text from pulse.org where code='$code'),false)" -c "select o.code, pp.username,
        coalesce((select floor(extract(epoch from max(k.expires_at) - now()) / 86400)::int from pulse_priv.agent_key k where k.person_id = a.person_id and k.revoked_at is null and k.expires_at > now()), -1)
      from pulse.agent_member a join pulse.org o on o.id = a.org_id join pulse.person p on p.id = a.person_id join pulse.people_profile pp on pp.person_id = a.person_id
      where o.code = '$code' and p.status = 'active' and not a.post_only and a.disabled_at is null and pp.username is not null order by a.employee_no" | grep '|' || true
  done
}
changed=0 seen=0
# code|username|days left on its newest live key (-1 = none)
while IFS='|' read -r code user left; do
  [ -n "$user" ] || continue
  seen=$((seen + 1))
  cfg=$(grep -m1 "^$user|" <<<"$listed" | cut -d'|' -f2 || true)
  lc=$(tr 'A-Z' 'a-z' <<<"$code")
  if [ -z "$cfg" ]; then cfg=$([ -f "$D/$lc.json" ] && echo "$lc.json" || echo prod.json); why="not connected"
  elif [ "$left" -ge 0 ] && [ "$left" -lt 14 ]; then why="key ends in $left days"
  elif [ "$left" -lt 0 ]; then why="no live key"
  else continue; fi
  old=$(q -c "select string_agg(k.prefix, ' ') from pulse_priv.agent_key k join pulse.people_profile pp on pp.person_id=k.person_id join pulse.org o on o.id=k.org_id where o.code='$code' and pp.username='$user' and k.revoked_at is null" || true)
  PULSE_URL=http://127.0.0.1:4002 bash "$CONNECT" "$tmp/env" pulse_owner "$code" "$user" "$D/$cfg" >/dev/null
  echo "connected @$user ($code) in $cfg: $why"
  # The older keys of a renewed employee are revoked as one of its organisation's admins (audited).
  if [ "$why" != "not connected" ] && [ -n "$old" ]; then
    for p in $old; do
      q -c "select set_config('pulse.org_id',(select id::text from pulse.org where code='$code'),false)" \
        -c "select set_config('pulse.viewer_id',(select r.person_id::text from pulse.role_assignment r join pulse.person p on p.id=r.person_id join pulse.org o on o.id=r.org_id where o.code='$code' and r.role_key='admin' and p.status='active' and p.side='staff' and current_date between r.valid_from and coalesce(r.valid_to,'infinity') order by r.valid_from limit 1),false)" \
        -c "select pulse.agent_key_revoke('$p')" >/dev/null || echo "could not revoke old key $p of @$user" >&2
    done
  fi
  changed=1
done < <(rows)
[ $seen -gt 0 ] || { echo "no AI employees read (row security?): nothing checked" >&2; exit 1; }
echo "$seen AI employees checked"
chown -R eadev:eadev "$D"; chmod 700 "$D" "$D/keys"; chmod 600 "$D"/*.json "$D"/keys/* 2>/dev/null || true
if [ $changed = 1 ]; then
  for u in pulse-prod-coworker.service pulse-prod-coworker-wl.service; do
    sudo -u eadev XDG_RUNTIME_DIR=/run/user/$(id -u eadev) systemctl --user try-restart "$u" || true
  done
  echo "runtimes restarted"
else echo "every AI employee is connected"; fi
