/** Local lifecycle checks; neither the epoch nor a browsing URL enters an event. */
export function sameSession(a,b){return !!a.session&&a.api===b.api&&a.session===b.session&&a.personId===b.personId&&a.deviceId===b.deviceId&&a.trackingEpoch===b.trackingEpoch;}
export function ownedEvents(events,s,now=Date.now()){return (events??[]).filter(e=>e.personId===s.personId&&e.deviceId===s.deviceId&&Date.parse(e.at)>=now-7*86400000);}
