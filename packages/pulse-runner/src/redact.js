const PATTERNS = [
  // AI-EMPLOYEE-POWER: root and shell jobs print anything, so common secret shapes are hidden too.
  /\bpak_[0-9a-f]{8}_[0-9a-f]{20,}/g,
  /\bpat_[A-Za-z0-9_-]{20,}/g,
  /\bpsvc_[0-9a-f-]{36}_[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|https?):\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /\bprc_[A-Za-z0-9_-]+/g,
  /\bpmt_[A-Za-z0-9_-]+/g,
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

const MASK = '[REDACTED]';

/** Removes known secret values and secret-shaped strings from anything leaving the runner. */
export class Redactor {
  constructor(secrets = []) {
    this.secrets = new Set();
    for (const secret of secrets) this.add(secret);
  }

  add(secret) {
    if (typeof secret === 'string' && secret.length >= 6) this.secrets.add(secret);
  }

  string(value) {
    let out = value;
    for (const secret of this.secrets) out = out.split(secret).join(MASK);
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (match, bearer) => (typeof bearer === 'string' ? `${bearer}${MASK}` : MASK));
    }
    return out;
  }

  deep(value) {
    if (typeof value === 'string') return this.string(value);
    if (Array.isArray(value)) return value.map((item) => this.deep(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.string(k), this.deep(v)]));
    }
    return value;
  }
}

export function log(level, message, fields = {}, redactor = new Redactor()) {
  const line = JSON.stringify(redactor.deep({ ts: new Date().toISOString(), level, message, ...fields }));
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}
