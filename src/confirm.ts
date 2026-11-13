import { createHash, randomBytes } from 'node:crypto';

/** JSON with object keys in sorted order, so two argument objects compare equal regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(obj[key]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export type ConsumeResult = 'ok' | 'unknown' | 'expired' | 'mismatch';

interface Entry {
  digest: string;
  expiresAt: number;
}

function digest(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(tool + '\n' + canonicalJson(args))
    .digest('hex');
}

/**
 * Single-use tokens that tie a real execution to the preview that preceded it.
 * Only a digest of the arguments is kept, so secrets passed as arguments are never stored.
 */
export class ConfirmStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.now = opts.now ?? Date.now;
  }

  issue(tool: string, args: Record<string, unknown>): { token: string; expiresInSeconds: number } {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
    const token = randomBytes(6).toString('hex');
    this.entries.set(token, { digest: digest(tool, args), expiresAt: now + this.ttlMs });
    return { token, expiresInSeconds: Math.round(this.ttlMs / 1000) };
  }

  /** Every attempt burns the token, including a failed one. */
  consume(token: string, tool: string, args: Record<string, unknown>): ConsumeResult {
    const entry = this.entries.get(token);
    if (!entry) return 'unknown';
    this.entries.delete(token);
    if (entry.expiresAt <= this.now()) return 'expired';
    return entry.digest === digest(tool, args) ? 'ok' : 'mismatch';
  }
}
