// Things people want from the companion, under the Today card: "Never marked late by mistake" (one tap asks for the
// late mark to be removed when Pulse saw you at the office first), "Your day, written for you" (an automatic summary,
// shared with your pod head in one tap) and the time wallet (leave, comp-off, next holiday, extra hours).
// Everything comes from GET companion/wallet; nothing is shared without the person's tap.

const element = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text; if (cls) n.className = cls; return n; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const hm = (m) => { const h = Math.floor(m / 60), r = Math.round(m % 60); return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r} min`; };
const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const amount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The day in one or two plain lines, the same text the person can share. */
export function dayText(d, today = new Date()) {
  if (!d) return '';
  const parts = [`in at ${clock(d.checkedInAt)}${d.office ? ` (${d.office})` : ''}`, `${hm(d.workedMinutes)} worked`];
  if (d.breakMinutes) parts.push(`${hm(d.breakMinutes)} on breaks`);
  if (d.deliveries) parts.push(`${d.deliveries} deliver${d.deliveries === 1 ? 'y' : 'ies'}`);
  if (d.checkedOutAt) parts.push(`out at ${clock(d.checkedOutAt)}`);
  const focus = (d.focus ?? []).map((f) => `${f.tool} ${hm(f.minutes)}`).join(', ');
  const date = today.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `My day, ${date}: ${parts.join(', ')}.${focus ? ` Focus: ${focus}.` : ''}`;
}

/** Mount under the Today card. options: call(path, body), onOpen(href). Returns { refresh(state) }. */
export function mountFeatures(root, { call, onOpen = () => {} }) {
  let data = null, shared = null, disputed = null, busy = false;
  const host = element('div', undefined, 'pc-features');
  root.replaceChildren(host);

  function draw(state) {
    host.replaceChildren();
    if (!data) return;
    const { late, day: d, wallet } = data;
    if (late && (late.disputable || late.pending || disputed)) {
      const card = element('section', undefined, 'pc-feature pc-feature-late');
      card.setAttribute('aria-label', 'Never marked late by mistake');
      card.append(element('h3', 'Never marked late by mistake', 'pc-feature-title'));
      if (late.pending || disputed) card.append(element('p', disputed ?? 'Your request to remove today’s late mark is waiting for a quick yes.', 'pc-feature-text'));
      else {
        card.append(element('p', `Marked ${late.minutes} min late, but Pulse saw your ${late.device ?? 'device'} at ${late.office ?? 'the office'} from ${clock(late.arrivedAt)}.`, 'pc-feature-text'));
        const fix = element('button', 'Remove the late mark', 'pc-btn pc-primary pc-feature-btn'); fix.type = 'button';
        fix.addEventListener('click', async () => {
          if (busy) return; busy = true; fix.disabled = true;
          try { await call('companion/late-dispute', {}); disputed = 'Sent with Pulse’s office evidence. Your pod head or HR only needs to approve it.'; }
          catch (e) { disputed = e?.message ?? 'Could not send. Try again in a moment.'; }
          finally { busy = false; draw(state); }
        });
        card.append(fix);
      }
      host.append(card);
    }
    const evening = new Date().getHours() >= 17;
    if (d && (state === 'done' || evening)) {
      const card = element('section', undefined, 'pc-feature pc-feature-day');
      card.setAttribute('aria-label', 'Your day, written for you');
      card.append(element('h3', 'Your day, written for you', 'pc-feature-title'), element('p', dayText(d), 'pc-feature-text'));
      if (d.manager) {
        const first = String(d.manager.name).split(' ')[0];
        const share = element('button', shared ?? `Share with ${first}`, 'pc-btn pc-feature-btn'); share.type = 'button'; share.disabled = !!shared;
        share.addEventListener('click', async () => {
          if (busy || shared) return; busy = true; share.disabled = true;
          try { const dm = await call('chats/direct', { personId: d.manager.id }); await call(`chats/${dm.id}/messages`, { body: dayText(d), clientId: crypto.randomUUID() }); shared = `Shared with ${first} ✓`; }
          catch (e) { share.disabled = false; share.textContent = e?.message ?? 'Could not share'; }
          finally { busy = false; draw(state); }
        });
        card.append(share);
      }
      host.append(card);
    }
    if (wallet) {
      const row = element('section', undefined, 'pc-wallet'); row.setAttribute('aria-label', 'Your time wallet');
      const chip = (text, title) => { const b = element('button', text, 'pc-wallet-chip'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', () => onOpen('/me')); row.append(b); };
      for (const b of wallet.balances.slice(0, 4)) chip(`${b.label} ${amount(b.available)}`, `${b.label}: ${amount(b.available)} days available${b.pending ? `, ${amount(b.pending)} pending` : ''}`);
      if (wallet.nextHoliday) chip(`${day(wallet.nextHoliday.day)} · ${wallet.nextHoliday.name}`, `Next holiday: ${wallet.nextHoliday.name}, ${day(wallet.nextHoliday.day)}`);
      if (wallet.month?.extraMinutes >= 30) chip(`+${hm(wallet.month.extraMinutes)} this month`, `Extra time beyond your shift this month: ${hm(wallet.month.extraMinutes)}`);
      if (row.childElementCount) host.append(row);
    }
  }
  return {
    async refresh(state) {
      try { data = await call('companion/wallet'); } catch { /* keep what we had */ }
      draw(state);
    },
    draw,
  };
}
