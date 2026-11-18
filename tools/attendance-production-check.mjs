// Invoked by the normal production smoke with a read-only, tenant-scoped SQL payload on stdin.
// Only masked aggregates leave this process; no IDs, punches, credentials or staff names are printed.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {attendanceStatistics,attendanceSummary} from '../services/api/dist/attendance-statistics.js';
const {entries,from,to}=JSON.parse(readFileSync(0,'utf8'));
const calculated=attendanceStatistics(entries);
const days=[...calculated.days.values()].filter(d=>d.date>=from&&d.date<=to);
const summary=attendanceSummary(days,from,to);
for(const d of days)if(d.eligible){assert.ok(d.minutes>=0&&d.minutes<=720);assert.equal(d.reasons.length,0);}
const byPerson=new Map();for(const d of days)byPerson.set(d.personId,[...(byPerson.get(d.personId)??[]),d]);
for(const rows of byPerson.values()){const s=attendanceSummary(rows,from,to);assert.ok(s.averageMinutes===null||s.averageMinutes<=720);assert.equal(s.workedMinutes,rows.filter(d=>d.eligible).reduce((n,d)=>n+d.minutes,0));}
const scoped=entries.filter(e=>e.date>=from&&e.date<=to);
const long=scoped.filter(e=>e.out&&Date.parse(e.out)-Date.parse(e.in)>720*60000);
for(const e of long)assert.equal(calculated.sessions.get(e.id).eligible,false);
console.log(JSON.stringify({passed:true,readOnly:true,databaseWrites:0,source:'production SQL receipts evaluated by the identical released API eligibility module; no authenticated HTTP walkthrough',masked:true,from,to,recordedPersonDays:summary.recordedDays,eligiblePersonDays:summary.eligibleDays,flaggedSessions:summary.flaggedCount,excludedPersonDays:summary.excludedDays,coverage:summary.coverage,averagesBoundedOrUnknown:true,closedSessionsOver12hExcluded:long.length,closedSessionsAtLeast43hExcluded:long.filter(e=>Date.parse(e.out)-Date.parse(e.in)>=43*3600000).length,filter:summary.filter}));
