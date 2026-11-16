// CHAT-VOICE: voice messages' played state and the transcript hook. The note itself is an ordinary chat file
// (POST /api/v0/chats/:id/files), attached to a message with its length and waveform.
import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (raw: unknown) => UUID.test(String(raw)) ? String(raw) : fail(400, 'Choose a valid conversation or message');
const member = (v: Viewer) => { if (!v.person) fail(403, 'Chats requires your individual employee account'); };
/** Transcripts run on the server's own Whisper worker (tools/voice-transcribe.py). FIX-CHAT-AI (owner, 10 Nov 2026:
 *  "voice-note transcripts in chat aren't working"): production's API never had PULSE_VOICE_TRANSCRIPTS=1, so no
 *  Transcript button showed and nothing was queued, although its worker runs. On unless a server says 0 (no Whisper). */
export const transcriptsOn = () => process.env.PULSE_VOICE_TRANSCRIPTS !== '0';
/** CHAT-VOICE-FIX: a guess shows only when it is English (mostly Latin letters). large-v3-turbo's "translation" of a
 *  Marathi or Hindi note can come back as the same words in Devanagari, garbled; shown as a guess it would be wrong words. */
export const englishGuess = (t: string | null | undefined) => {
  const letters = [...(t ?? '')].filter(ch => /\p{L}/u.test(ch));
  return letters.length > 0 && letters.filter(ch => ch.charCodeAt(0) < 128).length / letters.length >= 0.9 ? t! : null;
};
/** A voice note just sent is transcribed by itself (as WhatsApp does), in a savepoint so a refusal never loses the message. */
export async function queueVoiceTranscript(c: { query: (q: string, v?: unknown[]) => Promise<unknown> }, messageId: string, attachments: unknown[]) {
  if (!transcriptsOn() || !attachments.some((a) => !!a && typeof a === 'object' && !!(a as { voice?: unknown }).voice)) return;
  await c.query('savepoint voice_transcript');
  try { await c.query('select pulse.chat_voice_transcript_request($1)', [messageId]); await c.query('release savepoint voice_transcript'); }
  catch { await c.query('rollback to savepoint voice_transcript'); }
}

export function registerChatVoiceRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/chats/:id/voice', req => tx(req, async (c, v) => {
    member(v);
    const cid = id(req.params.id);
    const rows = (await c.query('select * from pulse.chat_voice_state($1)', [cid])).rows as { message_id: string; played: boolean; played_by: number; transcript: string | null; transcript_state: string | null }[];
    // CHAT-VOICE-FIX (2135): a transcript the server is not sure of is not shown: "unclear", with the English gist.
    const heard = new Map(((await c.query('select message_id, clear, gist from pulse.chat_voice_heard($1)', [cid])).rows as { message_id: string; clear: boolean | null; gist: string | null }[]).map(r => [r.message_id, r]));
    const notes: Record<string, { played: boolean; playedBy: number; transcript: string | null; transcriptState: string | null; gist?: string | null }> = Object.fromEntries(rows.map(r => {
      const h = heard.get(r.message_id), unclear = r.transcript_state === 'done' && h?.clear === false;
      return [r.message_id, { played: r.played, playedBy: r.played_by, transcript: r.transcript_state === 'done' && !unclear ? r.transcript : null,
        transcriptState: unclear ? 'unclear' : r.transcript_state === 'working' ? 'queued' : r.transcript_state, gist: englishGuess(h?.gist) }];
    }));
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
