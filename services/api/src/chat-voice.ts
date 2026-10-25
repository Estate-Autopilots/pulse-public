// CHAT-VOICE: voice messages' played state and the transcript hook. The note itself is an ordinary chat file
// (POST /api/v0/chats/:id/files), attached to a message with its length and waveform.
import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown) => UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid conversation or message');
const member = (v: Viewer) => { if (!v.person) fail(403, 'Chats requires your individual employee account'); };
/** Transcripts run on the server's own Whisper worker, only where the server switches them on. */
export const transcriptsOn = () => process.env.PULSE_VOICE_TRANSCRIPTS === '1';

export function registerChatVoiceRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/chats/:id/voice', req => tx(req, async (c, v) => {
    member(v);
    const cid = id(req.params.id);
    const rows = (await c.query('select * from pulse.chat_voice_state($1)', [cid])).rows as { message_id: string; played: boolean; played_by: number; transcript: string | null; transcript_state: string | null }[];
    const notes: Record<string, { played: boolean; playedBy: number; transcript: string | null; transcriptState: string | null }> = Object.fromEntries(rows.map(r => [r.message_id, { played: r.played, playedBy: r.played_by, transcript: r.transcript_state === 'done' ? r.transcript : null, transcriptState: r.transcript_state === 'working' ? 'queued' : r.transcript_state }]));
    // WA-NATIVE (1051): a voice note imported from WhatsApp comes with what the server's own Whisper heard (1016).
    for (const r of (await c.query('select message_id, transcript from pulse.wa_native_voice($1)', [cid])).rows as { message_id: string; transcript: string }[])
      notes[r.message_id] = { ...(notes[r.message_id] ?? { played: false, playedBy: 0 }), transcript: r.transcript, transcriptState: 'done' };
    return { transcripts: transcriptsOn(), notes };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/chats/messages/:id/played', req => tx(req, async (c, v) => {
    member(v); await c.query('select pulse.chat_voice_played($1)', [id(req.params.id)]); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/chats/messages/:id/transcript', req => tx(req, async (c, v) => {
    member(v); if (!transcriptsOn()) fail(409, 'Transcripts are not switched on for this Pulse');
    await c.query('select pulse.chat_voice_transcript_request($1)', [id(req.params.id)]); return { ok: true };
  }));
}
