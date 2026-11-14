import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner, killActiveChildren } from '../src/unc/runner.js';
import { locateUnc, candidateNames, DEFAULT_FALLBACK_DIRS } from '../src/unc/locate.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-unc.mjs', import.meta.url));
const run = (mode?: string) => createRunner(FAKE, { ...process.env, FAKE_UNC_MODE: mode ?? 'echo' });

describe('createRunner', () => {
  it('passes argv verbatim and delivers stdin', async () => {
    const argv = ['--format=json', 'file', 'stat', '--', '-rf', '/volume1/照片/a b.jpg', '*.txt', '$(id)', '--content=-x'];
    const r = await run()(argv, { stdin: 'héllo\n' });
    const env = JSON.parse(r.stdout.toString('utf8'));
    expect(r.exitCode).toBe(0);
    expect(env.argv).toEqual(argv);
    expect(env.stdin).toBe('héllo\n');
  });

  it('closes stdin when there is nothing to send', async () => {
    const r = await run()(['x']);
    expect(JSON.parse(r.stdout.toString('utf8')).stdin).toBe('');
  });

  it('reports a non-zero exit without throwing', async () => {
    const r = await run('fail')(['x']);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.toString()).success).toBe(false);
    expect(r.stderr).toContain('Error:');
  });

  it('returns stderr when stdout is empty', async () => {
    const r = await run('stderr-only')(['x']);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain('尚未登录');
  });

  it('returns non-JSON stdout untouched', async () => {
    const r = await run('garbage')(['x']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe('not json at all\n');
  });

  it('kills a hung process at the timeout', async () => {
    const started = Date.now();
    const r = await run('hang')(['x'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not truncate large output', async () => {
    const r = await run('big')(['x']);
    expect(r.stdout.length).toBeGreaterThan(5_000_000);
  });

  it('keeps raw bytes intact', async () => {
    const r = await run('raw')(['x']);
    expect([...r.stdout]).toEqual([0xff, 0xfe, 0x00, 0x68, 0x69]);
  });

  it('reports a missing binary as spawnError', async () => {
    const r = await createRunner('/nonexistent/unc')(['x'], { stdin: 'ignored' });
    expect(r.spawnError).toBe('ENOENT');
    expect(r.exitCode).toBeNull();
  });
});

describe('locateUnc', () => {
  it('uses the explicit path only, without falling back', async () => {
    expect(await locateUnc(FAKE, {})).toBe(FAKE);
    expect(await locateUnc('/nonexistent/unc', { PATH: path.dirname(FAKE) })).toBeNull();
  });

  it('searches PATH, then ~/.local/bin/unc', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nasmcp-loc-'));
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    await mkdir(bin);
    await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.local', 'bin', 'unc'), '#!/bin/sh\n');
    await chmod(path.join(home, '.local', 'bin', 'unc'), 0o755);
    expect(await locateUnc(null, { PATH: bin, HOME: home })).toBe(path.join(home, '.local', 'bin', 'unc'));

    await writeFile(path.join(bin, 'unc'), '#!/bin/sh\n');
    await chmod(path.join(bin, 'unc'), 0o755);
    expect(await locateUnc(null, { PATH: bin, HOME: home })).toBe(path.join(bin, 'unc'));

    expect(await locateUnc(null, { PATH: path.join(root, 'empty'), HOME: path.join(root, 'nohome') }, [])).toBeNull();
  });

  it('falls back to the usual install folders that GUI apps do not have on PATH', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nasmcp-loc-'));
    const brew = path.join(root, 'homebrew', 'bin');
    await mkdir(brew, { recursive: true });
    await writeFile(path.join(brew, 'unc'), '#!/bin/sh\n');
    await chmod(path.join(brew, 'unc'), 0o755);
    const env = { PATH: path.join(root, 'empty'), HOME: path.join(root, 'nohome') };
    expect(await locateUnc(null, env, [path.join(root, 'nothing'), brew])).toBe(path.join(brew, 'unc'));
    expect(DEFAULT_FALLBACK_DIRS).toEqual(expect.arrayContaining(['/usr/local/bin', '/opt/homebrew/bin']));
  });

  it('never picks a .cmd or .bat shim on Windows, which cannot be started without a shell', () => {
    expect(candidateNames('win32')).toEqual(['unc.exe']);
    expect(candidateNames('darwin')).toEqual(['unc']);
  });

  it('ignores a file that is not executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nasmcp-loc-'));
    await writeFile(path.join(root, 'unc'), '#!/bin/sh\n');
    await chmod(path.join(root, 'unc'), 0o644);
    expect(await locateUnc(null, { PATH: root, HOME: path.join(root, 'nohome') }, [])).toBeNull();
  });
});

describe('review: output cap', () => {
  it('stops a process that floods stdout and says so', async () => {
    const runner = createRunner(FAKE, { ...process.env, FAKE_UNC_MODE: 'big' }, { maxOutputBytes: 1_000_000 });
    const r = await runner(['x']);
    expect(r.overflow).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBeLessThan(5_000_000);
  });

  it('leaves output below the cap alone', async () => {
    const runner = createRunner(FAKE, { ...process.env, FAKE_UNC_MODE: 'big' }, { maxOutputBytes: 8_000_000 });
    const r = await runner(['x']);
    expect(r.overflow).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });
});

describe('second review: runner contract', () => {
  it('resolves instead of rejecting when the process cannot even be spawned', async () => {
    const r = await run()(['bad\0arg']);
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeDefined();
    expect(r.stderr).not.toBe('');
  });

  it('stops running children on request', async () => {
    const started = Date.now();
    const pending = run('hang')(['x'], { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(killActiveChildren()).toBeGreaterThanOrEqual(1);
    const r = await pending;
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('accepts raw bytes on stdin', async () => {
    const r = await run()(['x'], { stdin: Buffer.from('héllo') });
    expect(JSON.parse(r.stdout.toString('utf8')).stdin).toBe('héllo');
  });
});
