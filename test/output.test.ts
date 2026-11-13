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

  it('truncates with a notice stating both sizes', () => {
    const t = toText({ data: 'x'.repeat(5000) }, 1000);
    expect(t.startsWith('{"data":"xxx')).toBe(true);
    expect(t).toMatch(/\[truncated: showing 1000 of \d+ characters\./);
    expect(t.length).toBeLessThan(1300);
  });

  it('builds tool results', () => {
    expect(ok({ a: 1 }, 1000)).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    const f = fail({ error: 'boom', hint: 'do x' }, 1000);
    expect(f.isError).toBe(true);
    expect(JSON.parse((f.content[0] as { text: string }).text)).toEqual({ error: 'boom', hint: 'do x' });
  });
});
