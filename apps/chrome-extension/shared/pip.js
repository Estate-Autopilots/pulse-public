// Pip, the Pulse bot (OWNER-PIP, 20 Oct 2026): the Ripple mark come alive. The live point is Pip's round body, the
// mark's two rings are its feelings (they rest, pulse, orbit and spread with the mood) and the live dot sits on its
// shoulder. A few solid shapes, so it animates smoothly and reads at 20 px.
// One geometry for every surface: web, desktop and Chrome render the SVG string; the phone app's widget uses the
// still, inline-coloured version. Moods are pure CSS on the web side, so reduced motion turns them into still poses.

// The island and panel states, then the day's moods the check-in surfaces already ask for.
export const PIP_MOODS = ['idle', 'listening', 'thinking', 'speaking', 'new-message', 'happy', 'concerned', 'sleeping', 'waking', 'in', 'break', 'done', 'celebrate', 'sleepy'];

export const PIP_LABELS = {
  idle: 'Pip, the Pulse bot, waiting for you',
  listening: 'Pip, the Pulse bot, listening',
  thinking: 'Pip, the Pulse bot, thinking',
  speaking: 'Pip, the Pulse bot, telling you what changed',
  'new-message': 'Pip, the Pulse bot, with something new for you',
  happy: 'Pip, the Pulse bot, happy it is done',
  concerned: 'Pip, the Pulse bot, concerned: something needs a look',
  sleeping: 'Pip, the Pulse bot, asleep for the night',
  waking: 'Pip, the Pulse bot, waking up for the workday',
  in: 'Pip, the Pulse bot, happily working alongside you',
  break: 'Pip, the Pulse bot, enjoying a cup of tea on your break',
  done: 'Pip, the Pulse bot, waving goodbye for the day',
  celebrate: 'Pip, the Pulse bot, celebrating with confetti',
  sleepy: 'Pip, the Pulse bot, sleeping',
};

/** The live dot's colour per mood: the "pulse" in Pulse. */
export const PIP_BULB = { idle: '#3ddc97', listening: '#8ff0d2', thinking: '#c9c2ff', speaking: '#3ddc97', 'new-message': '#ff7a59', happy: '#3ddc97', concerned: '#ffb547', sleeping: '#77749a',
  waking: '#ffd38a', in: '#3ddc97', break: '#ffc35c', done: '#b9adff', celebrate: '#ffd34d', sleepy: '#77749a' };

export const PIP_COLORS = {
  light: { bodyA: '#8e73ff', bodyB: '#4f37d0', arc: '#a996ff', eye: '#ffffff', shine: '#ffffff', ring: '#ffffff', shadow: 'rgba(24,20,60,.14)', cup: '#ffffff', cupLine: '#4a35c0', steam: '#9b98b8', z: '#7a68e6', brow: '#ffffff' },
  dark: { bodyA: '#a596ff', bodyB: '#6a55e6', arc: '#8f7dff', eye: '#ffffff', shine: '#ffffff', ring: '#16161b', shadow: 'rgba(0,0,0,.45)', cup: '#eeeef6', cupLine: '#a99cff', steam: '#8d8aa8', z: '#b8adff', brow: '#ffffff' },
};

/** Which face Pip makes in each mood. */
export function pipFace(mood) {
  const m = PIP_MOODS.includes(mood) ? mood : 'idle';
  const happy = m === 'happy' || m === 'done';
  return {
    eyes: happy ? 'happy' : m === 'break' || m === 'sleepy' || m === 'sleeping' ? 'closed' : m === 'celebrate' ? 'star' : 'open',
    mouth: m === 'waking' || m === 'celebrate' || m === 'new-message' ? 'o' : m === 'sleepy' || m === 'sleeping' ? 'none' : m === 'concerned' ? 'wobble' : happy ? 'grin' : m === 'thinking' ? 'flat' : 'smile',
    cheeks: false, brows: m === 'concerned',
    cup: m === 'break', zzz: m === 'sleepy' || m === 'sleeping', confetti: m === 'celebrate', wave: m === 'done',
    dots: m === 'thinking', rings: m === 'listening' || m === 'new-message' || m === 'speaking', bulb: PIP_BULB[m],
  };
}

// Geometry (viewBox 0 0 120 120): the body is the mark's point, the arcs are its two rings.
export const PIP_PATHS = {
  body: { cx: 56, cy: 68, r: 30 },
  arcs: ['M56 27A41 41 0 0 1 97 68', 'M56 12A56 56 0 0 1 112 68'],
  shine: 'M37 60c1.5-8.5 7.5-14 15-15.5',
  eyesOpen: [[46, 59], [58.6, 59]],
  eyesHappy: ['M45.4 70q4.4-7.5 8.8 0', 'M58 70q4.4-7.5 8.8 0'],
  eyesClosed: ['M45.4 66q4.4 4.5 8.8 0', 'M58 66q4.4 4.5 8.8 0'],
  brows: ['M44 54l10-2.5', 'M69 54l-10-2.5'],
  star: 'M0-7l2 4.4 4.7.6-3.4 3.2.9 4.7L0 3.6l-4.2 2.3.9-4.7-3.4-3.2L-2-2.6z',
  cup: 'M92 81h15v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7z',
  cupHandle: 'M107 84h2a3 3 0 0 1 0 6h-2',
  steam: ['M97 77q-2.5-4 0-7.5t0-7.5', 'M103 77q-2.5-4 0-7.5t0-7.5'],
  z: 'M0 0h6l-6 7h6',
  confetti: [[14, 24, '#ffd34d'], [104, 10, '#3ddc97'], [6, 62, '#ff8fb1'], [112, 52, '#8ff0d2'], [20, 104, '#a99cff'], [98, 106, '#ffc35c'], [56, 2, '#ff8fb1'], [4, 36, '#8ff0d2']],
};
const POINT = { cx: 77.2, cy: 46.8, r: 5.6 };
const B = PIP_PATHS.body;

let counter = 0;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eyeRect = ([x, y], fill = '') => `<rect x="${x}" y="${y}" width="7.6" height="14" rx="3.8"${fill}/>`;

/**
 * The SVG markup for Pip. Static, built only from constants and the escaped label, so it is safe for innerHTML.
 * size: CSS pixels; still: no motion (the person turned animations down, or a screenshot).
 */
export function pipSvg({ mood = 'idle', size = 72, label, still = false, uid } = {}) {
  const m = PIP_MOODS.includes(mood) ? mood : 'idle';
  const id = uid ?? `pip${++counter}`;
  const f = pipFace(m);
  const P = PIP_PATHS;
  const eyes = f.eyes === 'open'
    ? `<g class="pip-eyes pip-blink">${eyeRect(P.eyesOpen[0])}${eyeRect(P.eyesOpen[1])}</g>`
    : f.eyes === 'star'
      ? `<g class="pip-eyes pip-stars"><path transform="translate(49.8 66) scale(.9)" d="${P.star}"/><path transform="translate(62.4 66) scale(.9)" d="${P.star}"/></g>`
      : `<g class="pip-eyes pip-lines"><path d="${(f.eyes === 'happy' ? P.eyesHappy : P.eyesClosed)[0]}"/><path d="${(f.eyes === 'happy' ? P.eyesHappy : P.eyesClosed)[1]}"/></g>`;
  const brows = f.brows ? `<g class="pip-brows"><path d="${P.brows[0]}"/><path d="${P.brows[1]}"/></g>` : '';
  const cup = f.cup ? `<g class="pip-cup"><path class="pip-steam" d="${P.steam[0]}"/><path class="pip-steam pip-late" d="${P.steam[1]}"/><path class="pip-mug" d="${P.cup}"/><path class="pip-handle" d="${P.cupHandle}"/></g>` : '';
  const hand = f.wave ? '<ellipse class="pip-hand pip-wave" cx="89" cy="78" rx="6.5" ry="8"/>' : '';
  // Each z sits in its own placed group, so the drift animation never replaces the placement.
  const zzz = f.zzz ? `<g class="pip-zzz"><g transform="translate(20 30)"><path d="${P.z}"/></g><g transform="translate(11 20) scale(.8)"><path class="pip-late" d="${P.z}"/></g><g transform="translate(4 11) scale(.6)"><path class="pip-later" d="${P.z}"/></g></g>` : '';
  const confetti = f.confetti ? `<g class="pip-confetti">${P.confetti.map(([x, y, c], i) => `<rect x="${x}" y="${y}" width="5" height="5" rx="${i % 2 ? 2.5 : 1}" fill="${c}"/>`).join('')}</g>` : '';
  const arcs = `<g class="pip-arcs${f.dots ? ' pip-dots' : ''}"><path class="pip-arc" d="${P.arcs[0]}"/><path class="pip-arc pip-arc2" d="${P.arcs[1]}"/></g>`;
  const rings = f.rings ? `<g class="pip-rings" fill="none" stroke="${f.bulb}"><circle cx="${B.cx}" cy="${B.cy}" r="${B.r}"/><circle class="pip-late" cx="${B.cx}" cy="${B.cy}" r="${B.r}"/></g>` : '';
  const point = f.zzz ? '' : `<circle class="pip-glow" cx="${POINT.cx}" cy="${POINT.cy}" r="${POINT.r}" fill="${f.bulb}"/><circle class="pip-bulb" cx="${POINT.cx}" cy="${POINT.cy}" r="${POINT.r}" fill="${f.bulb}"/>`;
  return `<svg class="pip${still ? ' pip-still' : ''}" data-mood="${m}" viewBox="0 0 120 120" width="${size}" height="${size}" role="img" aria-label="${esc(label ?? PIP_LABELS[m])}" focusable="false" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><linearGradient id="${id}-b" x1="0" y1="0" x2="1" y2="1"><stop class="pip-stop-a" offset="0"/><stop class="pip-stop-b" offset="1"/></linearGradient></defs>`
    + `<ellipse class="pip-shadow" cx="${B.cx}" cy="106" rx="22" ry="4"/>` + arcs + rings
    + `<g class="pip-bob">${hand}<circle class="pip-head" cx="${B.cx}" cy="${B.cy}" r="${B.r}" fill="url(#${id}-b)"/><path class="pip-shine" d="${P.shine}"/>`
    + eyes + brows + point + cup + '</g>' + zzz + confetti + '</svg>';
}

/**
 * Pip with every colour written into the markup (no stylesheet): for the phone app's widget and the icon scripts.
 * Still pose; the host animates the whole image if it wants to.
 */
export function pipStaticSvg({ mood = 'idle', theme = 'light', size = 72, blink = false } = {}) {
  const m = PIP_MOODS.includes(mood) ? mood : 'idle';
  const c = PIP_COLORS[theme === 'dark' ? 'dark' : 'light'];
  const f = pipFace(m);
  const P = PIP_PATHS;
  const line = (d, col = c.eye) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  const eyes = blink || f.eyes === 'closed' ? P.eyesClosed.map((d) => line(d)).join('')
    : f.eyes === 'happy' ? P.eyesHappy.map((d) => line(d)).join('')
      : f.eyes === 'star' ? `<path transform="translate(49.8 66) scale(.9)" d="${P.star}" fill="${c.eye}"/><path transform="translate(62.4 66) scale(.9)" d="${P.star}" fill="${c.eye}"/>`
        : eyeRect(P.eyesOpen[0], ` fill="${c.eye}"`) + eyeRect(P.eyesOpen[1], ` fill="${c.eye}"`);
  const brows = f.brows ? P.brows.map((d) => line(d, c.brow)).join('') : '';
  const cup = f.cup ? `<path d="${P.steam[0]}" fill="none" stroke="${c.steam}" stroke-width="2" stroke-linecap="round" stroke-opacity=".7"/><path d="${P.steam[1]}" fill="none" stroke="${c.steam}" stroke-width="2" stroke-linecap="round" stroke-opacity=".7"/><path d="${P.cup}" fill="${c.cup}" stroke="${c.cupLine}" stroke-width="2"/><path d="${P.cupHandle}" fill="none" stroke="${c.cupLine}" stroke-width="2.2" stroke-linecap="round"/>` : '';
  const zzz = f.zzz ? `<g fill="none" stroke="${c.z}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path transform="translate(20 30)" d="${P.z}"/><path transform="translate(11 20) scale(.8)" d="${P.z}"/><path transform="translate(4 11) scale(.6)" d="${P.z}"/></g>` : '';
  const confetti = f.confetti ? P.confetti.map(([x, y, col], i) => `<rect x="${x}" y="${y}" width="5" height="5" rx="${i % 2 ? 2.5 : 1}" fill="${col}"/>`).join('') : '';
  const sleepy = f.zzz ? ' stroke-opacity=".35"' : '';
  const arcs = P.arcs.map((d, i) => `<path d="${d}" fill="none" stroke="${c.arc}" stroke-width="7.5" stroke-linecap="round"${i ? ' stroke-opacity=".7"' : ''}${sleepy}/>`).join('');
  const point = f.zzz ? '' : `<circle cx="${POINT.cx}" cy="${POINT.cy}" r="${POINT.r}" fill="${f.bulb}" stroke="${c.ring}" stroke-width="2.6"/>`;
  const hand = f.wave ? `<ellipse cx="89" cy="78" rx="6.5" ry="8" fill="${c.bodyB}" transform="rotate(-30 86 86)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">`
    + `<defs><linearGradient id="pb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bodyA}"/><stop offset="1" stop-color="${c.bodyB}"/></linearGradient></defs>`
    + `<ellipse cx="${B.cx}" cy="106" rx="22" ry="4" fill="${c.shadow}"/>${arcs}${hand}`
    + `<circle cx="${B.cx}" cy="${B.cy}" r="${B.r}" fill="url(#pb)"/><path d="${P.shine}" fill="none" stroke="${c.shine}" stroke-opacity=".45" stroke-width="3.4" stroke-linecap="round"/>`
    + eyes + brows + cup + point + zzz + confetti + '</svg>';
}
