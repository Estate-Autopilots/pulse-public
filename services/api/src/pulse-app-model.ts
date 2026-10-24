// Pure rules for the Pulse apps round (R15d): screenshot intake for feedback and the plain-language device health
// an admin sees ("is this Mac connected and tracked?"). No activity contents, locations or messages are involved.

export const SCREENSHOT_LIMIT = 4 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/png': b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** A pasted or chosen screenshot as a data URL → bytes and type, or null; anything else is refused. */
export function parseScreenshot(raw: unknown): { type: string; bytes: Buffer } | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = typeof raw === 'string' ? raw.match(DATA_URL) : null;
  if (!m) throw new Error('Attach a PNG, JPEG or WebP screenshot');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > SCREENSHOT_LIMIT) throw new Error('Choose a screenshot under 4 MB');
  if (!MAGIC[m[1]](bytes)) throw new Error('That file is not the image it claims to be');
  return { type: m[1], bytes };
}

export type HealthRow = {
  platform: string; last_seen: string | Date | null; created_at: string | Date; health: string | null; capabilities: Record<string, string>;
  last_attendance: string | Date | null; purposes: string[]; paused: boolean; notice_published: boolean; last_event: string | Date | null;
  presence_consent: boolean; app_version: string | null;
};
const ms = (v: string | Date | null) => (v ? new Date(v).getTime() : 0);
const DAY = 86400000;

/** Plain answers for one device: connected?, attendance from the app?, work activity on or off and why. */
export function deviceStatus(row: HealthRow, now = Date.now()) {
  const seen = ms(row.last_seen);
  const connected = seen > 0 && now - seen < DAY ? 'connected' : seen > 0 && now - seen < 7 * DAY ? 'quiet' : 'not-seen';
  const attendance = ms(row.last_attendance) > now - 14 * DAY ? 'working' : 'none-yet';
  const desktop = ['windows', 'macos'].includes(row.platform);
  const wantsActivity = row.purposes.includes('activity_context') || row.purposes.includes('work_evidence');
  const activity = !desktop ? { state: 'not-applicable', why: 'Work activity is a laptop feature' }
    : !row.notice_published ? { state: 'off', why: 'Notice not published' }
      : !wantsActivity ? { state: 'off', why: 'Not opted in' }
        : row.capabilities?.focus === 'denied' || row.capabilities?.idle === 'denied' ? { state: 'off', why: 'OS permission missing' }
          : row.paused ? { state: 'paused', why: 'Paused after a break or check-out' }
            : { state: 'on', why: ms(row.last_event) > now - DAY ? 'Collecting' : 'On, no events in the last day' };
  const pings = row.capabilities?.push === 'denied' ? 'blocked' : 'ok';
  return { connected, attendance, activity, pings, presence: row.presence_consent ? 'on' : 'off' };
}
