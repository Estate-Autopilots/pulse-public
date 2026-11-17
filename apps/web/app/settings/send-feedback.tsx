'use client';
import { useState } from 'react';
import { MessageSquareHeart } from 'lucide-react';
import { styles } from '../ui';
import { post } from '../records';
import css from './get-apps.module.css';

/** Send feedback about the Pulse apps: a few words and, if useful, a screenshot (paste it or choose a file). */
export function SendFeedback() {
  const [text, setText] = useState(''), [shot, setShot] = useState<string | null>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const read = (file: File | null | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) { setStatus('Choose a PNG, JPEG or WebP image under 4 MB.'); return; }
    const r = new FileReader(); r.onload = () => setShot(String(r.result)); r.readAsDataURL(file);
  };
  async function send() {
    if (!text.trim()) return;
    setBusy(true); setStatus('');
    try { await post('feedback', { text: text.trim(), screenshot: shot, platform: 'web', page: 'settings-devices' }); setText(''); setShot(null); setStatus('Thank you! The Pulse team will read it.'); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Could not send. Your text is kept.'); }
    finally { setBusy(false); }
  }
  return (
    <article className={`${css.card} ${css.feedback}`} aria-labelledby="send-feedback-title">
      <div className={css.cardHead}><MessageSquareHeart size={22} aria-hidden="true" /><div><h3 id="send-feedback-title">Send feedback</h3><small>Testing the apps? Tell us what worked, what didn’t and what would make Pulse better. It goes straight to the Pulse team.</small></div></div>
      <textarea aria-label="Your feedback" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened, on which device? Paste a screenshot here too."
        onPaste={(e) => { const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/')); if (item) { e.preventDefault(); read(item.getAsFile()); } }} />
      <div className={css.attach}>
        {shot ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the person's own pasted image */}
          <img src={shot} alt="Attached screenshot" />
        </> : null}
        <span>{shot ? 'Screenshot attached.' : 'Optional screenshot: paste one, or choose a file.'}</span>
        <label className={styles.btn}>Choose…<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => read(e.target.files?.[0])} /></label>
        {shot ? <button type="button" className={styles.btn} onClick={() => setShot(null)}>Remove</button> : null}
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending…' : 'Send feedback'}</button>
      </div>
      <p role="status" className={css.attach}>{status}</p>
    </article>
  );
}
