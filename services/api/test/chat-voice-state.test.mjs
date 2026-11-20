// PULSE-BUGS-2 (EA #34, Kazuk 20 Nov 2026: "some voice notes show an inaccurate transcript; others show no transcript
// at all"): what a voice note's bubble is told about its transcript. Words the server is sure of show; words it is not
// sure of, or none at all, say "unclear" (Not clear — listen), never a Transcript button that cannot make another.
import assert from 'node:assert/strict';
import test from 'node:test';
import { noteState } from '../dist/chat-voice.js';

const row = (transcript_state, transcript = null) => ({ played: false, played_by: 0, transcript, transcript_state });

test('sure words show; a note not transcribed yet, being made or failed says so', () => {
  assert.deepEqual(noteState(row('done', 'Shoot at eleven tomorrow'), { clear: true, gist: null }),
    { played: false, playedBy: 0, transcript: 'Shoot at eleven tomorrow', transcriptState: 'done', gist: null });
  assert.equal(noteState(row(null)).transcriptState, null, 'none yet: the bubble offers Transcript');
  assert.equal(noteState(row('queued')).transcriptState, 'queued');
  assert.equal(noteState(row('working')).transcriptState, 'queued', 'the worker has it: Transcribing…');
  assert.equal(noteState(row('failed')).transcriptState, 'failed', 'failed: Try the transcript again');
  assert.equal(noteState(row('done', 'Shoot at eleven tomorrow')).transcript, 'Shoot at eleven tomorrow', 'a transcript from before 2135 (no heard row) shows');
});

test('words the server is not sure of are hidden, with an English gist only', () => {
  assert.deepEqual(noteState(row('done', 'garbled guess'), { clear: false, gist: 'Send the proposal today' }),
    { played: false, playedBy: 0, transcript: null, transcriptState: 'unclear', gist: 'Send the proposal today' });
  assert.equal(noteState(row('done', 'garbled'), { clear: false, gist: 'उद्या सकाळी' }).gist, null, 'a guess that is not English is not shown');
});

test('a transcript with no words in it is unclear, not a Transcript button that does nothing', () => {
  for (const words of ['', '   ', null]) {
    const s = noteState(row('done', words), { clear: true, gist: null });
    assert.equal(s.transcriptState, 'unclear', JSON.stringify(words));
    assert.equal(s.transcript, null);
  }
  assert.equal(noteState(row('done', '')).transcriptState, 'unclear', 'also without a heard row');
});

test('played state passes through', () => {
  assert.deepEqual({ ...noteState({ played: true, played_by: 2, transcript: null, transcript_state: null }) },
    { played: true, playedBy: 2, transcript: null, transcriptState: null, gist: null });
});
