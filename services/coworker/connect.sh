#!/bin/bash
# CHAT-WORK: connect an AI employee's runtime on this company's server (the operator's step; no key is ever shown in
# Pulse). Issues the employee a key as one of the company's admins (pulse.agent_key_issue: 90 days, audited by prefix),
# writes it to a 600 file, and adds the employee to the runtime's config. Then (re)start the runtime.
#
#   services/coworker/connect.sh <env-file with MIGRATE_DATABASE_URL> <owner role> <org code> <username> <config.json>
#   e.g. services/coworker/connect.sh /etc/estate-autopilots/db/pulse_dev.env pulse_dev_owner EA pip.writer ~/.config/pulse-coworker/dev.json
set -euo pipefail
envfile=$1 role=$2 code=$3 user=$4 cfg=$5
set -a; . "$envfile"; set +a
dir=$(dirname "$cfg"); mkdir -p "$dir/keys"; chmod 700 "$dir" "$dir/keys"
q() { PGOPTIONS="-c role=$role" psql "$MIGRATE_DATABASE_URL" -At -q -v ON_ERROR_STOP=1 "$@"; }
org=$(q -c "select id from pulse.org where code='$code'")
[ -n "$org" ] || { echo "no company $code" >&2; exit 1; }
key=$(q -c "select set_config('pulse.org_id','$org',false)" -c "select set_config('pulse.viewer_id',(select r.person_id::text from pulse.role_assignment r join pulse.person p on p.id=r.person_id where r.org_id='$org' and r.role_key='admin' and p.status='active' and p.side='staff' and current_date between r.valid_from and coalesce(r.valid_to,'infinity') order by r.valid_from limit 1),false)" \
  -c "select pulse.agent_key_issue((select person_id from pulse.people_profile where org_id='$org' and username='$user'),'runtime on this server',90)" | tail -1)
[[ "$key" =~ ^pak_ ]] || { echo "could not issue a key for $user" >&2; exit 1; }
umask 077; printf '%s\n' "$key" > "$dir/keys/$user.key"
node -e '
const fs=require("fs");const [cfg,user,file,pulse]=process.argv.slice(1);
const c=fs.existsSync(cfg)?JSON.parse(fs.readFileSync(cfg,"utf8")):{pulse,agents:[],poll:3};
c.agents=c.agents.filter(a=>a.username!==user).concat([{username:user,keyFile:file}]);fs.writeFileSync(cfg,JSON.stringify(c,null,2),{mode:0o600});
' "$cfg" "$user" "$dir/keys/$user.key" "${PULSE_URL:-http://127.0.0.1:3203}"
echo "connected @$user (key ${key:0:12}…, 90 days) in $cfg"
