import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { riskAllows, normalizeNasPath, assertNasPathAllowed, resolveLocalPath, PolicyError } from '../src/policy.js';

describe('riskAllows', () => {
  it('orders read < write < admin', () => {
    expect(riskAllows('read', 'read')).toBe(true);
    expect(riskAllows('read', 'write')).toBe(false);
    expect(riskAllows('write', 'admin')).toBe(false);
    expect(riskAllows('admin', 'write')).toBe(true);
  });
});

describe('normalizeNasPath', () => {
  it.each([
    ['/volume1/docs', '/volume1/docs'],
    ['/volume1//docs/', '/volume1/docs'],
    ['/', '/'],
    ['/volume1/照片/a b.jpg', '/volume1/照片/a b.jpg'],
    ['/a/..b/...', '/a/..b/...'],
  ])('%j -> %j', (input, out) => expect(normalizeNasPath(input)).toBe(out));

  it.each(['volume1/docs', '', './a', '-rf', '/volume1/../etc', '/a/..', '/a\0b'])('rejects %j', (p) =>
    expect(() => normalizeNasPath(p)).toThrowError(PolicyError),
  );
});

describe('assertNasPathAllowed', () => {
  const allowed = ['/volume1/docs', '/home/von'];

  it('accepts a prefix and its descendants', () => {
    expect(assertNasPathAllowed('/volume1/docs', allowed)).toBe('/volume1/docs');
    expect(assertNasPathAllowed('/volume1/docs/a/b.txt', allowed)).toBe('/volume1/docs/a/b.txt');
    expect(assertNasPathAllowed('/home/von/', allowed)).toBe('/home/von');
  });

  it.each(['/volume1/docs-private/x', '/volume1', '/volume1/doc', '/home/vonx', '/'])('rejects %s', (p) =>
    expect(() => assertNasPathAllowed(p, allowed)).toThrowError(PolicyError),
  );

  it('empty allowlist is unrestricted but still validates shape', () => {
    expect(assertNasPathAllowed('/anything', [])).toBe('/anything');
    expect(() => assertNasPathAllowed('relative', [])).toThrowError(PolicyError);
  });

  it('names UGREEN_MCP_ALLOWED_PATHS in the hint', () => {
    expect.assertions(1);
    try {
      assertNasPathAllowed('/etc', allowed);
    } catch (e) {
      expect((e as PolicyError).hint).toContain('UGREEN_MCP_ALLOWED_PATHS');
    }
  });
});

describe('resolveLocalPath', () => {
  let root: string;
  let dir: string;
  let outside: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'nasmcp-')));
    dir = path.join(root, 'share');
    outside = path.join(root, 'outside');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(dir, 'a.txt'), 'a');
    await writeFile(path.join(outside, 'secret.txt'), 's');
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    await symlink(outside, path.join(dir, 'linkdir'));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('resolves relative and absolute paths inside the directory', async () => {
    expect(await resolveLocalPath('a.txt', dir, 'existing-file')).toBe(path.join(dir, 'a.txt'));
    expect(await resolveLocalPath(path.join(dir, 'a.txt'), dir, 'existing-file')).toBe(path.join(dir, 'a.txt'));
    expect(await resolveLocalPath('sub/new.bin', dir, 'target')).toBe(path.join(dir, 'sub', 'new.bin'));
  });

  it.each([
    ['../outside/secret.txt', 'existing-file'],
    ['link.txt', 'existing-file'],
    ['missing.txt', 'existing-file'],
    ['sub', 'existing-file'],
    ['linkdir/new.bin', 'target'],
    ['nodir/new.bin', 'target'],
    ['../x.bin', 'target'],
  ] as const)('rejects %s (%s)', async (p, mode) => {
    await expect(resolveLocalPath(p, dir, mode)).rejects.toThrowError(PolicyError);
  });

  it('rejects an absolute path outside the directory', async () => {
    await expect(resolveLocalPath(path.join(outside, 'secret.txt'), dir, 'existing-file')).rejects.toThrowError(
      PolicyError,
    );
  });

  it('names UGREEN_MCP_LOCAL_DIR in the hint', async () => {
    await expect(resolveLocalPath('../x.bin', dir, 'target')).rejects.toMatchObject({
      hint: expect.stringContaining('UGREEN_MCP_LOCAL_DIR'),
    });
  });
});

describe('review: allowlist root and symlinked download targets', () => {
  it('treats "/" in the allowlist as every path', () => {
    expect(assertNasPathAllowed('/volume1/docs/a.txt', ['/'])).toBe('/volume1/docs/a.txt');
  });

  it('refuses a download target that is a symlink, dangling or not', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'nasmcp-link-')));
    const dir = path.join(root, 'share');
    const outside = path.join(root, 'outside');
    await mkdir(dir);
    await mkdir(outside);
    await writeFile(path.join(outside, 'victim.txt'), 'v');
    await symlink(path.join(outside, 'victim.txt'), path.join(dir, 'existing-link'));
    await symlink(path.join(outside, 'not-there-yet'), path.join(dir, 'dangling-link'));
    await writeFile(path.join(dir, 'plain.bin'), 'p');
    try {
      await expect(resolveLocalPath('existing-link', dir, 'target')).rejects.toThrowError(PolicyError);
      await expect(resolveLocalPath('dangling-link', dir, 'target')).rejects.toThrowError(PolicyError);
      expect(await resolveLocalPath('plain.bin', dir, 'target')).toBe(path.join(dir, 'plain.bin'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('second review: transfer directory at the filesystem root', () => {
  it('accepts paths below a root directory', async () => {
    const fsRoot = path.parse(process.cwd()).root;
    const here = await realpath(tmpdir());
    expect(await resolveLocalPath(path.join(here, 'new-file.bin'), fsRoot, 'target')).toBe(path.join(here, 'new-file.bin'));
  });
});
