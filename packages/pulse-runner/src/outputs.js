import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class OutputRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OutputRefused';
    this.code = code;
  }
}

/**
 * Reads a declared output safely. The agent controls the workdir, and the runner reads with
 * access to its own credential, so a symlink or hard link here could otherwise exfiltrate it.
 * Call this only after every job process has exited.
 */
export function readOutput(workDir, relPath, maxBytes) {
  const realWork = fs.realpathSync(workDir);
  const target = path.join(realWork, relPath);
  if (!target.startsWith(`${realWork}${path.sep}`)) throw new OutputRefused('outside', 'path is outside the workdir');

  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') throw new OutputRefused('missing', 'file does not exist');
    throw err;
  }
  if (real !== target) throw new OutputRefused('symlink', 'path goes through a symlink');

  // O_NONBLOCK stops a FIFO left by the agent from hanging the runner.
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(target, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new OutputRefused('not_regular', 'not a regular file');
    if (stat.nlink !== 1) throw new OutputRefused('hard_link', 'file has more than one hard link');
    if (stat.size > maxBytes) throw new OutputRefused('too_large', `file is over the ${maxBytes} byte limit`);
    const bytes = fs.readFileSync(fd);
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}
