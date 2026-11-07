"""R15 native gateway regression using only the release train's synthetic staging person."""
import datetime
import uuid


def verify(conn, call, check, person):
    start = '/api/native/v0/'
    before = []
    taps = {}

    def passed(label, condition):
        check('desktop ' + label, condition)
        before.append({'check': label, 'passed': True})

    def native(path, token=None, body=None):
        return call(start + path, body=body, headers={'Authorization': 'Bearer ' + token} if token else {})

    def pair(platform):
        status, request, _, _ = native('native/pair/start', body={'platform': platform, 'name': 'Release validation desktop'})
        passed(platform + ' pairing begins', status == 200)
        status, pending, _, _ = native('native/pair/poll', body={'pairId': request['pairId'], 'pollSecret': request['pollSecret']})
        passed(platform + ' pairing waits for approval', status == 200 and pending['status'] == 'pending')
        status, _, _, _ = call('/api/v0/native/pair/decide', 'pgs', {'code': request['code'], 'approve': True})
        passed(platform + ' browser approval', status == 200)
        status, device, _, _ = native('native/pair/poll', body={'pairId': request['pairId'], 'pollSecret': request['pollSecret']})
        passed(platform + ' receives own device', status == 200 and device['person']['id'] == person)
        return device

    windows, mac = pair('windows'), pair('macos')
    passed('Access identity cannot authenticate a device', call(start + 'companion', headers={'Cf-Access-Authenticated-User-Email': 'synthetic@example.test'})[0] == 401)
    passed('expired access fails closed', native('companion', 'synthetic-invalid-access')[0] == 401)
    conn.execute("update pulse_priv.native_token set access_until=now()-interval '1 second' where person_id=%s and device_id=%s", (person, windows['deviceId']))
    passed('expired real device access denied', native('companion', windows['accessToken'])[0] == 401)
    status, rotated, _, _ = native('native/refresh', body={'refreshToken': windows['refreshToken']})
    passed('expired access refresh rotates', status == 200 and rotated['accessToken'] != windows['accessToken'])
    windows_token = rotated['accessToken']
    status, companion, _, _ = native('companion', windows_token)
    passed('rotated device can read own day', status == 200)
    attendance_enabled = companion.get('attendanceEnabled') if isinstance(companion, dict) else None
    passed('companion reports attendance gate', isinstance(attendance_enabled, bool))

    def tap(action, token, queue_id=None):
        body = {'via': 'desktop', 'trigger': 'manual', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'queueId': queue_id or str(uuid.uuid4())}
        if action == 'check-in':
            body['mode'] = 'office'
        elif action in ('start', 'end'):
            body['action'] = action
        body = taps.setdefault(body['queueId'], body)
        return native('attendance/break' if action in ('start', 'end') else 'attendance/' + action, token, body)

    if not attendance_enabled:
        before_rows = conn.execute('select count(*) n from pulse.attendance_entry where org_id=pulse.current_org() and person_id=%s', (person,)).fetchone()['n']
        status, refused, _, _ = tap('check-in', windows_token)
        passed('attendance-off check-in refused', status == 403 and refused.get('error') == 'Attendance is off for your organisation.')
        after_rows = conn.execute('select count(*) n from pulse.attendance_entry where org_id=pulse.current_org() and person_id=%s', (person,)).fetchone()['n']
        passed('attendance-off check-in writes no row', after_rows == before_rows)
        return {'checks': before, 'syntheticOnly': True, 'attendanceEnabled': False,
                'transport': 'authorized staging loopback gateway; public host preserved', 'installedApp': False, 'emailsSent': 0}

    # Staging's working week is production's, and check-in refuses a weekly off (Sunday in India): the synthetic person
    # works today by a one-day pattern (no change on a working day), removed with them by the smoke's cleanup().
    conn.execute("""insert into pulse.hr_work_pattern(org_id,person_id,work_days,valid_from,valid_to,reason,changed_by)
        select pulse.current_org(),%s,array[extract(isodow from d)::int],d,d,'Release validation: today is a working day',%s
        from (select (now() at time zone 'Asia/Kolkata')::date d) t""", (person, person))
    status, entry, _, _ = tap('check-in', windows_token)
    passed('Windows check-in', status == 200)
    passed('Mac sees same check-in', native('companion', mac['accessToken'])[1]['state'] == 'in')
    passed('second device cannot duplicate check-in', tap('check-in', mac['accessToken'])[0] == 409)
    queue_id = str(uuid.uuid4())
    passed('Mac queued break', tap('start', mac['accessToken'], queue_id)[0] == 200)
    status, replay, _, _ = tap('start', mac['accessToken'], queue_id)
    passed('repeated queued break applied once', status == 200 and replay.get('replayed') is True)
    passed('Windows sees same break', native('companion', windows_token)[1]['state'] == 'break')
    passed('Windows ends break', tap('end', windows_token)[0] == 200)
    passed('Mac check-out', tap('check-out', mac['accessToken'])[0] == 200)
    passed('My desk parity', call('/api/v0/hr/self', 'pgs')[1]['now']['state'] == 'done')
    rows = conn.execute('select count(*) n from pulse.attendance_entry where person_id=%s', (person,)).fetchone()
    passed('exactly one attendance row', rows['n'] == 1)
    rows = conn.execute('select count(*) n from pulse.attendance_break where person_id=%s', (person,)).fetchone()
    passed('exactly one break row', rows['n'] == 1)
    resume_id = str(uuid.uuid4())
    passed('queued check-in resumes day', tap('check-in', windows_token, resume_id)[1].get('resumed') is True)
    passed('Mac finishes resumed day', tap('check-out', mac['accessToken'])[0] == 200)
    passed('late resume retry is idempotent', tap('check-in', windows_token, resume_id)[1].get('replayed') is True)
    passed('late retry cannot reopen day', native('companion', mac['accessToken'])[1]['state'] == 'done')
    passed('refresh replay denied', native('native/refresh', body={'refreshToken': windows['refreshToken']})[0] == 401)
    passed('replay revokes Windows family', native('companion', windows_token)[0] == 401)
    passed('other device remains independent', native('companion', mac['accessToken'])[0] == 200)
    passed('browser revokes Mac', call('/api/v0/devices/' + mac['deviceId'] + '/revoke', 'pgs', {})[0] == 200)
    passed('revoked device read denied', native('companion', mac['accessToken'])[0] == 401)
    passed('revoked device attendance denied', tap('check-in', mac['accessToken'])[0] == 401)
    passed('revoked refresh denied', native('native/refresh', body={'refreshToken': mac['refreshToken']})[0] == 401)
    return {'checks': before, 'syntheticOnly': True, 'attendanceEnabled': True, 'transport': 'authorized staging loopback gateway; public host preserved', 'installedApp': False, 'emailsSent': 0}
