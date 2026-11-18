// DOREVE-2 (AC card 7): a task's circle finishes the task in one click; a double click on the same circle counts once.
/** A tick function with its own memory: `tick(id, finish, now?)` runs `finish` unless the same circle ran < `settle` ms ago. */
export function tickOnce(settle = 400) {
  let last = null;
  return (id, finish, now = Date.now()) => {
    if (last && last.id === id && now - last.at < settle) return false;
    last = { id, at: now };
    finish();
    return true;
  };
}
