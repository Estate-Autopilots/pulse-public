// Pip's island queue (UX-NOTIFY): which arrival opens next. One at a time; a burst (more than three waiting) or more
// than eight in a minute folds into one "N new updates" line; a problem is never folded away, nor the app's own answer to
// what the person just did ("Added", "Assigned to Kabir": RELEASE-4 found them folded into "1 new updates" after a busy
// minute), nor the newest request that needs a decision (EST-1763). Pure, so it is tested.
export const PER_MINUTE = 8;
export const BURST = 3;

/** Urgent actions and immediate confirmations move ahead of informational notices. */
export function hasPriority(item) {
  return item?.priority === 'action' || item?.tone === 'error' || item?.tone === 'success';
}

/** The app's own answer to what the person just did ("Added", "Not saved"). */
const isAnswer = (item) => item?.tone === 'error' || item?.tone === 'success';

/** Keep priority items in arrival order, ahead of normal updates and info notices; an answer (when `incoming` is one)
 *  goes ahead of waiting requests too (RELEASE-2's rule: what the person just did is answered first). */
export function priorityIndex(queue, incoming) {
  const index = queue.findIndex((item) => (isAnswer(incoming) ? !isAnswer(item) : !hasPriority(item)));
  return index < 0 ? queue.length : index;
}

/** A new priority item may interrupt a currently displayed lower-priority item; an answer also interrupts a request on
 *  show, which comes back right after (RELEASE-4: "Assigned to Kabir" waited behind one past five seconds). */
export function shouldPreempt(current, incoming) {
  if (!current) return false;
  if (isAnswer(incoming)) return !isAnswer(current);
  return hasPriority(incoming) && !hasPriority(current);
}

/**
 * queue: items waiting, oldest first ({ id, title, tone? }); shown: when earlier items opened (ms);
 * summary(rest): the folded line for the others. Returns the item to open now (or null) and the new state.
 */
export function nextArrival(queue, shown, now, summary) {
  const recent = shown.filter((t) => t > now - 60000);
  let waiting = queue;
  if (waiting.length > BURST || (waiting.length && recent.length >= PER_MINUTE)) {
    const errors = waiting.filter((i) => i.tone === 'error');
    const answers = waiting.filter((i) => i.tone === 'success');
    // EST-1763: the newest request (Review, Reply) keeps its own line and stays ahead of the app's info notices, as
    // priorityIndex orders them. It used to be folded into "N new updates" while "Your role brief is ready" opened alone.
    const request = waiting.filter((i) => !i.tone && i.priority === 'action').slice(-1);
    const notes = waiting.filter((i) => i.tone && !hasPriority(i));
    const rest = waiting.filter((i) => !i.tone && !request.includes(i));
    waiting = [...errors.slice(-1), ...answers, ...request, ...notes, ...(rest.length > 1 ? [summary(rest)] : rest)];
  }
  const [item = null, ...left] = waiting;
  return { item, queue: left, shown: item ? [...recent, now] : recent };
}
