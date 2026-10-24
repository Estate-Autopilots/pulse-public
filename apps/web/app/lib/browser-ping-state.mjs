export function browserPingStatus({ supported, webPushKey, permission }) {
  if (!supported) return 'This browser does not support pings with the page closed. In-page pings work while Pulse is open.';
  if (!webPushKey) return 'Browser pings are awaiting server activation. In-page pings work while Pulse is open.';
  if (permission === 'denied') return 'Notifications are blocked in this browser. Allow them in site settings.';
  if (permission !== 'granted') return 'Enable browser pings to receive updates with the page closed.';
  return null; // The successful enrolment response supplies the enabled state.
}
