// WL-QUOTE-LIVE (12 Nov 2026): a client's name as it sounds, so a misheard or other-script name still finds the client.
// The suite's voice notes came back from Whisper as "Desideri" for Desai Dairy, "Shind Hospital" for Sigemo Hospital,
// and in Devanagari for clients saved in Latin letters (देसाई डेयरी); each made a second client. The key keeps a name's
// consonants as they sound (Devanagari letters transliterated, aspirates and vowels dropped, doubled letters once), and
// two names are near when their keys are equal, or one letter apart once a key has six letters or more. It only ever
// suggests ("Did you mean …"); it never picks a client by itself.
const DEVANAGARI: Record<string, string> = {
  'क': 'k', 'ख': 'k', 'ग': 'g', 'घ': 'g', 'ङ': 'n', 'च': 'c', 'छ': 'c', 'ज': 'j', 'झ': 'j', 'ञ': 'n', 'ट': 't', 'ठ': 't', 'ड': 'd', 'ढ': 'd',
  'ण': 'n', 'त': 't', 'थ': 't', 'द': 'd', 'ध': 'd', 'न': 'n', 'प': 'p', 'फ': 'p', 'ब': 'b', 'भ': 'b', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l',
  'ळ': 'l', 'व': 'v', 'श': 's', 'ष': 's', 'स': 's', 'ह': 'h', 'क़': 'k', 'ख़': 'k', 'ग़': 'g', 'ज़': 'j', 'ड़': 'd', 'ढ़': 'd', 'फ़': 'p', 'य़': 'y',
  'ं': 'n', 'ँ': 'n', // the nasal mark is an n (शिंदे = Sigemo)
};
/** The sound key of a name: "Desai Dairy", "Desideri" and "देसाई डेयरी" all give "dsdr". */
export function nameKey(name: string): string {
  let s = '';
  for (const ch of String(name ?? '').normalize('NFC').toLowerCase()) s += DEVANAGARI[ch] ?? ch;
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(m\/s|messrs|shri|shree|sri|smt|dr|the|pvt|ltd|llp|private|limited)\b/g, ' ')
    .replace(/ph/g, 'p').replace(/f/g, 'p').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/c(?!h)/g, 'k').replace(/[^a-z]/g, '').replace(/[aeiouyh]/g, '');
  return s.replace(/(.)\1+/g, '$1');
}
function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** Whether two names sound alike enough to ask "Did you mean …?". */
export function nearName(a: string, b: string): boolean {
  const x = nameKey(a), y = nameKey(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && oneApart(x, y));
}
