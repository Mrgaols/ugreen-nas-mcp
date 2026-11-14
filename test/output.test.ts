import { describe, it, expect } from 'vitest';
import {
  redact,
  parseEnvelope,
  isSuccess,
  hintFor,
  failureFromUnc,
  toText,
  ok,
  fail,
  INSTALL_HINT,
} from '../src/output.js';
import type { UncResult } from '../src/unc/runner.js';

const res = (over: Partial<UncResult> & { out?: string } = {}): UncResult => {
  const { out, ...rest } = over;
  return { exitCode: 0, stdout: Buffer.from(out ?? ''), stderr: '', timedOut: false, ...rest };
};

describe('redact', () => {
  it('masks open-platform tokens wherever they appear', () => {
    expect(redact('a ugpoa_v1.AbC-123_x.yz/+= b')).toBe('a ugpoa_v1.*** b');
    expect(redact('{"token":"ugpoa_v1.abc"}')).toBe('{"token":"ugpoa_v1.***"}');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('parseEnvelope / isSuccess', () => {
  it('parses a JSON object', () => {
    const r = res({ out: '{"success":true,"data":{}}' });
    expect(isSuccess(r, parseEnvelope(r))).toBe(true);
  });

  it.each(['', 'not json', '[1,2]', '"str"'])('returns null for %j', (out) => {
    const r = res({ out });
    expect(parseEnvelope(r)).toBeNull();
    expect(isSuccess(r, null)).toBe(false);
  });

  it('is false on success:false, non-zero exit, timeout or spawn error', () => {
    const env = { success: true };
    expect(isSuccess(res(), { success: false })).toBe(false);
    expect(isSuccess(res({ exitCode: 1 }), env)).toBe(false);
    expect(isSuccess(res({ exitCode: null, timedOut: true }), env)).toBe(false);
    expect(isSuccess(res({ exitCode: null, spawnError: 'ENOENT' }), env)).toBe(false);
  });
});

describe('hintFor', () => {
  const h = (over: Partial<UncResult> & { out?: string }) => {
    const r = res(over);
    return hintFor(r, parseEnvelope(r)) ?? '';
  };

  it('missing binary', () => expect(h({ exitCode: null, spawnError: 'ENOENT' })).toBe(INSTALL_HINT));
  it('timeout', () => expect(h({ exitCode: null, timedOut: true })).toMatch(/timeout_seconds|narrow/i));
  it('not logged in', () =>
    expect(h({ exitCode: 1, stderr: 'Error: 尚未登录，请先运行 unc auth login' })).toContain('UNC_NAS_TOKEN'));
  it('401', () =>
    expect(
      h({ exitCode: 1, out: '{"success":false,"error":"Unauthenticated (HTTP 401) x: invalid bearer token"}' }),
    ).toMatch(/token.*(expired|invalid)/i));
  it('403 for a path outside shared folders', () =>
    expect(
      h({
        exitCode: 1,
        out: '{"success":false,"items":[{"success":false,"error":"PermissionDenied (HTTP 403) /x: Err - code: 1301, message: Access not allowed"}]}',
      }),
    ).toContain('nas_file_roots'));
  it('403 for a token without the permission node', () =>
    expect(
      h({
        exitCode: 1,
        out: '{"success":false,"error":"PermissionDenied (HTTP 403) /docker.Docker/ContainerList: 访问令牌未授权该方法"}',
      }),
    ).toMatch(/new access token/i));
  it('429', () =>
    expect(h({ exitCode: 1, out: '{"success":false,"error":"ResourceExhausted (HTTP 429) rate_limited"}' })).toMatch(
      /wait/i,
    ));
  it('compatibility fields win over text matching', () =>
    expect(
      h({
        exitCode: 1,
        out: '{"success":false,"error":"Unimplemented (HTTP 403)","error_detail":{"subtype":"compat_method_not_provided"}}',
      }),
    ).toMatch(/not available on this NAS/i));
  it('compatibility fields inside items are found', () =>
    expect(
      h({
        exitCode: 1,
        out: '{"success":false,"items":[{"success":false,"error":"x","compatibility_hint":{"signal":"grpc_unavailable"}}]}',
      }),
    ).toMatch(/not available on this NAS/i));
  it('no hint for an ordinary failure', () =>
    expect(
      hintFor(res({ exitCode: 1, out: '{"success":false,"error":"NotFound (HTTP 404)"}' }), {
        success: false,
        error: 'NotFound (HTTP 404)',
      }),
    ).toBeUndefined());
});

describe('failureFromUnc', () => {
  it('uses stderr when stdout is not JSON', () => {
    const f = failureFromUnc(res({ exitCode: 1, out: '', stderr: 'Error: unknown flag: --nope\n' }), null);
    expect(f.error).toBe('Error: unknown flag: --nope');
    expect(f.result).toBeUndefined();
  });

  it('says so when unc printed nothing useful', () => {
    expect(failureFromUnc(res({ exitCode: 0, out: 'not json' }), null).error).toMatch(/unexpected output/i);
  });

  it('describes a timeout and a missing binary', () => {
    expect(failureFromUnc(res({ exitCode: null, timedOut: true }), null).error).toMatch(/timed out/i);
    const missing = failureFromUnc(res({ exitCode: null, spawnError: 'ENOENT' }), null);
    expect(missing.error).toMatch(/unc CLI/i);
    expect(missing.hint).toBe(INSTALL_HINT);
  });

  it('keeps per-item results and structured fields', () => {
    const env = {
      success: false,
      items: [{ path: '/a', success: true }, { success: false, error: 'NotFound' }],
      warnings: ['w'],
    };
    const f = failureFromUnc(res({ exitCode: 1, out: JSON.stringify(env), stderr: 'Error: 1/2 个目标失败' }), env);
    expect(f.result).toEqual(env);
    expect(f.warnings).toEqual(['w']);
    expect(f.error).toContain('1/2');
  });

  it('uses the top-level error when present', () => {
    const env = { success: false, error: 'NotFound (HTTP 404) x', error_detail: { a: 1 } };
    const f = failureFromUnc(res({ exitCode: 1, out: JSON.stringify(env) }), env);
    expect(f.error).toBe('NotFound (HTTP 404) x');
    expect(f.error_detail).toEqual({ a: 1 });
    expect(f.hint).toMatch(/not available on this NAS/i);
  });
});

describe('toText / ok / fail', () => {
  it('serialises compactly and redacts', () => {
    expect(toText({ a: 'ugpoa_v1.secret', b: [1] }, 1000)).toBe('{"a":"ugpoa_v1.***","b":[1]}');
  });

  it('truncates into a parseable object that says what is missing', () => {
    const t = toText({ data: 'x'.repeat(5000) }, 1000);
    const body = JSON.parse(t);
    expect(body.truncated).toBe(true);
    expect(body.shown_chars).toBe(1000);
    expect(body.total_chars).toBeGreaterThan(5000);
    expect(body.note).toMatch(/narrow/i);
    expect(body.partial.startsWith('{"data":"xxx')).toBe(true);
    expect(body.partial).toHaveLength(1000);
    expect(t.length).toBeLessThan(1600);
  });

  it('lifts the fields an agent must not lose out of a truncated result', () => {
    const body = JSON.parse(
      toText({ status: 'confirmation_required', confirm_token: 'abc', expires_in_seconds: 300, next_step: 'n', preview: 'x'.repeat(5000) }, 1000),
    );
    expect(body).toMatchObject({ truncated: true, status: 'confirmation_required', confirm_token: 'abc', expires_in_seconds: 300, next_step: 'n' });
    const failure = JSON.parse(toText({ error: 'e', hint: 'h', result: 'x'.repeat(5000) }, 1000));
    expect(failure).toMatchObject({ truncated: true, error: 'e', hint: 'h' });
  });

  it('truncates plain text the same way and still redacts', () => {
    const body = JSON.parse(toText('ugpoa_v1.secret ' + 'y'.repeat(5000), 1000));
    expect(body.truncated).toBe(true);
    expect(body.partial.startsWith('ugpoa_v1.*** yyy')).toBe(true);
  });

  it('builds tool results', () => {
    expect(ok({ a: 1 }, 1000)).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    const f = fail({ error: 'boom', hint: 'do x' }, 1000);
    expect(f.isError).toBe(true);
    expect(JSON.parse((f.content[0] as { text: string }).text)).toEqual({ error: 'boom', hint: 'do x' });
  });
});

describe('review: timeouts, floods and field order', () => {
  it('a request that hit unc\'s own deadline gets advice for reads and for changes', () => {
    const r = res({
      exitCode: 1,
      out: JSON.stringify({ success: false, items: [{ success: false, error: '请求 /x 失败: Post "https://nas/x": context deadline exceeded' }] }),
    });
    const hint = hintFor(r, parseEnvelope(r)) ?? '';
    expect(hint).toMatch(/did not answer in time/i);
    expect(hint).toMatch(/check the current state/i);
  });

  it('a killed process also warns that a change may have been applied', () => {
    const r = res({ exitCode: null, timedOut: true });
    expect(hintFor(r, null)).toMatch(/check the current state/i);
  });

  it('an output flood is reported as such', () => {
    const r = res({ exitCode: null, overflow: true, out: '{"success":true,"data":"xxxx' });
    const f = failureFromUnc(r, parseEnvelope(r));
    expect(f.error).toMatch(/too much output/i);
    expect(f.hint).toMatch(/narrow/i);
    expect(isSuccess(r, null)).toBe(false);
  });

  it('puts the hint before bulky fields so truncation cannot remove it', () => {
    const big = { success: false, error: 'PermissionDenied (HTTP 403) code: 1301', items: [{ success: false, blob: 'x'.repeat(5000) }] };
    const r = res({ exitCode: 1, out: JSON.stringify(big) });
    const textOut = (fail(failureFromUnc(r, parseEnvelope(r)), 1000).content[0] as { text: string }).text;
    const parsed = JSON.parse(textOut);
    expect(parsed.truncated).toBe(true);
    expect(parsed.hint).toMatch(/nas_file_roots/);
  });
});

describe('second review: login wording', () => {
  it('recognises an English not-logged-in message too', () => {
    const r = res({ exitCode: 1, stderr: 'Error: not logged in, run unc auth login first' });
    expect(hintFor(r, null)).toContain('UNC_NAS_TOKEN');
  });
});
