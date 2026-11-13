import { describe, it, expect } from 'vitest';
import { ConfirmStore, canonicalJson } from '../src/confirm.js';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(canonicalJson({ a: { d: [2, 1] }, b: 1 }));
  });

  it('is sensitive to array order', () => {
    expect(canonicalJson({ p: ['/a', '/b'] })).not.toBe(canonicalJson({ p: ['/b', '/a'] }));
  });
});

describe('ConfirmStore', () => {
  const args = { paths: ['/a/x'], permanent: false };

  it('issues a 12-hex token valid for 300 seconds', () => {
    const { token, expiresInSeconds } = new ConfirmStore().issue('nas_file_delete', args);
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    expect(expiresInSeconds).toBe(300);
  });

  it('accepts the same tool and args once, regardless of key order', () => {
    const s = new ConfirmStore();
    const { token } = s.issue('nas_file_delete', args);
    expect(s.consume(token, 'nas_file_delete', { permanent: false, paths: ['/a/x'] })).toBe('ok');
    expect(s.consume(token, 'nas_file_delete', args)).toBe('unknown');
  });

  it('rejects changed args or a different tool and burns the token', () => {
    const s = new ConfirmStore();
    const a = s.issue('nas_file_delete', args).token;
    expect(s.consume(a, 'nas_file_delete', { ...args, permanent: true })).toBe('mismatch');
    expect(s.consume(a, 'nas_file_delete', args)).toBe('unknown');
    const b = s.issue('nas_file_delete', args).token;
    expect(s.consume(b, 'nas_file_move', args)).toBe('mismatch');
  });

  it('expires', () => {
    let t = 1_000_000;
    const s = new ConfirmStore({ now: () => t });
    const { token } = s.issue('x', args);
    t += 300_001;
    expect(s.consume(token, 'x', args)).toBe('expired');
  });

  it('rejects an unknown token', () => {
    expect(new ConfirmStore().consume('deadbeef0000', 'x', {})).toBe('unknown');
  });

  it('issues a different token every time', () => {
    const s = new ConfirmStore();
    expect(s.issue('x', args).token).not.toBe(s.issue('x', args).token);
  });
});
