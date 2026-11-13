import { describe, it, expect } from 'vitest';
import { tool, parse, call, riskOf, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_file_mkdir', { paths: ['/home/u/new dir'], parents: true }, ['file', 'mkdir', '--parents', '--', '/home/u/new dir'], 'write'],
  ['nas_file_mkdir', { paths: ['/home/u/a', '/home/u/b'] }, ['file', 'mkdir', '--', '/home/u/a', '/home/u/b'], 'write'],
  ['nas_file_create', { path: '/home/u/a.txt', content: '-hello' }, ['file', 'touch', '--exclusive', '--content=-hello', '--', '/home/u/a.txt'], 'write'],
  ['nas_file_create', { path: '/home/u/empty' }, ['file', 'touch', '--exclusive', '--', '/home/u/empty'], 'write'],
  [
    'nas_file_create',
    { path: '/home/u/b.bin', content: 'AAEC', base64: true },
    ['file', 'touch', '--exclusive', '--content=AAEC', '--base64', '--', '/home/u/b.bin'],
    'write',
  ],
  ['nas_file_copy', { source: '/a/x.txt', destination_dir: '/b' }, ['file', 'cp', '--on-conflict=rename', '--', '/a/x.txt', '/b'], 'write'],
  [
    'nas_file_copy',
    { source: '/a/x.txt', destination_dir: '/b', on_conflict: 'replace' },
    ['file', 'cp', '--on-conflict=replace', '--', '/a/x.txt', '/b'],
    'admin',
  ],
  ['nas_file_restore', { recycle_paths: ['/home/u/#recycle/a.txt'] }, ['file', 'recover-recycle', '--', '/home/u/#recycle/a.txt'], 'write'],
  ['nas_file_tag_edit', { action: 'create_tag', name: '重要', color: '#FF4D4F' }, ['file', 'tag', 'add', '--color=#FF4D4F', '--', '重要'], 'write'],
  ['nas_file_tag_edit', { action: 'create_tag', name: 'x' }, ['file', 'tag', 'add', '--color=#4C8BF5', '--', 'x'], 'write'],
  ['nas_file_tag_edit', { action: 'tag_files', tag_id: 3, paths: ['/a/b'] }, ['file', 'tag', 'file', 'add', '--', '3', '/a/b'], 'write'],
  ['nas_file_tag_edit', { action: 'delete_tags', tag_ids: [3, 4] }, ['file', 'tag', 'delete', '--', '3', '4'], 'admin'],
  ['nas_file_tag_edit', { action: 'untag_files', tag_id: 3, paths: ['/a/b'] }, ['file', 'tag', 'file', 'delete', '--', '3', '/a/b'], 'admin'],
  ['nas_file_move', { source: '/a/x.txt', destination: '/b' }, ['file', 'mv', '--', '/a/x.txt', '/b'], 'admin'],
  [
    'nas_file_move',
    { source: '/a/x.txt', destination: 'y.txt', on_conflict: 'skip' },
    ['file', 'mv', '--on-conflict=skip', '--', '/a/x.txt', 'y.txt'],
    'admin',
  ],
  ['nas_file_delete', { paths: ['/a/x', '/a/y'] }, ['file', 'rm', '--', '/a/x', '/a/y'], 'admin'],
  ['nas_file_delete', { paths: ['/a/x'], permanent: true }, ['file', 'rm', '--permanent', '--', '/a/x'], 'admin'],
  ['nas_file_write', { path: '/a/x.txt', content: 'hi' }, ['file', 'tee', '--', '/a/x.txt'], 'admin'],
  ['nas_file_write', { path: '/a/x.txt', content: 'hi', mode: 'append' }, ['file', 'tee', '--append', '--', '/a/x.txt'], 'admin'],
  ['nas_file_quota_set', { path: '/home/u', quota_mb: 10240 }, ['file', 'quota', 'set', '--quota-mb=10240', '--', '/home/u'], 'admin'],
  ['nas_file_quota_set', { path: '/home/u', quota_mb: 0 }, ['file', 'quota', 'set', '--quota-mb=0', '--', '/home/u'], 'admin'],
];

describe('file write tools', () => {
  checkRows(rows);

  it('builds transfers from the resolved local path', () => {
    const ctx = { localPath: '/L/r.pdf' };
    expect(call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/volume1/docs/' }, ctx).argv).toEqual([
      'file', 'upload', '--on-conflict=rename', '--stream-timeout=600', '--', '/L/r.pdf', '/volume1/docs/',
    ]);
    expect(
      call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/volume1/docs/', on_conflict: 'replace', verify: true }, ctx).argv,
    ).toEqual(['file', 'upload', '--on-conflict=replace', '--verify', '--stream-timeout=600', '--', '/L/r.pdf', '/volume1/docs/']);
    expect(riskOf('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' })).toBe('write');
    expect(riskOf('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/', on_conflict: 'replace' })).toBe('admin');

    expect(call('nas_file_download', { remote_path: '/volume1/docs/r.pdf' }, ctx).argv).toEqual([
      'file', 'download', '--stream-timeout=600', '--', '/volume1/docs/r.pdf', '/L/r.pdf',
    ]);
    expect(call('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'resume' }, ctx).argv).toContain('--continue');
    expect(call('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'overwrite' }, ctx).argv).toContain('--force');
    expect(riskOf('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'overwrite' })).toBe('write');
    expect(call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' }, ctx).timeoutMs).toBe(615000);
  });

  it('refuses to build a transfer without a resolved local path', () => {
    expect(() => call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' })).toThrowError();
    expect(() => call('nas_file_download', { remote_path: '/d/r.pdf' })).toThrowError();
  });

  it('declares which local path to resolve', () => {
    expect(tool('nas_file_upload').localPath!(parse('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' }))).toEqual({
      path: 'r.pdf',
      mode: 'existing-file',
    });
    expect(tool('nas_file_download').localPath!(parse('nas_file_download', { remote_path: '/volume1/docs/报告 v2.pdf' }))).toEqual({
      path: '报告 v2.pdf',
      mode: 'target',
    });
    expect(
      tool('nas_file_download').localPath!(parse('nas_file_download', { remote_path: '/d/r.pdf', local_path: 'x/y.pdf' })),
    ).toEqual({ path: 'x/y.pdf', mode: 'target' });
  });

  it('sends file content through stdin, never argv', () => {
    const c = call('nas_file_write', { path: '/a/x.txt', content: 'top secret' });
    expect(c.stdin).toBe('top secret');
    expect(c.argv.join(' ')).not.toContain('top secret');
  });

  it('declares paths for the allowlist', () => {
    const mv = tool('nas_file_move');
    expect(mv.nasPaths!(parse('nas_file_move', { source: '/a/x', destination: 'y.txt' }))).toEqual(['/a/x']);
    expect(mv.nasPaths!(parse('nas_file_move', { source: '/a/x', destination: '/b' }))).toEqual(['/a/x', '/b']);
    expect(tool('nas_file_copy').nasPaths!(parse('nas_file_copy', { source: '/a/x', destination_dir: '/b' }))).toEqual(['/a/x', '/b']);
    expect(tool('nas_file_upload').nasPaths!(parse('nas_file_upload', { local_path: 'r', remote_path: '/d/' }))).toEqual(['/d/']);
    expect(tool('nas_file_download').nasPaths!(parse('nas_file_download', { remote_path: '/d/r.pdf' }))).toEqual(['/d/r.pdf']);
    expect(tool('nas_file_mkdir').nasPaths!(parse('nas_file_mkdir', { paths: ['/a', '/b'] }))).toEqual(['/a', '/b']);
    expect(tool('nas_file_create').nasPaths!(parse('nas_file_create', { path: '/a' }))).toEqual(['/a']);
    expect(tool('nas_file_restore').nasPaths!(parse('nas_file_restore', { recycle_paths: ['/h/#recycle/a'] }))).toEqual(['/h/#recycle/a']);
    expect(tool('nas_file_delete').nasPaths!(parse('nas_file_delete', { paths: ['/a'] }))).toEqual(['/a']);
    expect(tool('nas_file_write').nasPaths!(parse('nas_file_write', { path: '/a', content: 'x' }))).toEqual(['/a']);
    expect(tool('nas_file_quota_set').nasPaths!(parse('nas_file_quota_set', { path: '/a', quota_mb: 1 }))).toEqual(['/a']);
    expect(tool('nas_file_tag_edit').nasPaths!(parse('nas_file_tag_edit', { action: 'tag_files', tag_id: 1, paths: ['/a'] }))).toEqual(['/a']);
    expect(tool('nas_file_tag_edit').nasPaths!(parse('nas_file_tag_edit', { action: 'delete_tags', tag_ids: [1] }))).toEqual([]);
  });

  it('validates combinations and sizes', () => {
    expect(() => call('nas_file_tag_edit', { action: 'create_tag' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tag_edit', { action: 'tag_files', tag_id: 3 })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tag_edit', { action: 'untag_files', paths: ['/a'] })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tag_edit', { action: 'delete_tags' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_move', { source: '/a/x', destination: 'sub/y.txt' })).toThrowError(ToolInputError);
    expect(() => parse('nas_file_tag_edit', { action: 'create_tag', name: 'x', color: 'red' })).toThrow();
    expect(() => parse('nas_file_create', { path: '/a', content: '字'.repeat(40000) })).toThrow();
    expect(() => parse('nas_file_delete', { paths: [] })).toThrow();
    expect(() => parse('nas_file_quota_set', { path: '/a', quota_mb: -1 })).toThrow();
  });

  it('sets registration bounds', () => {
    for (const n of ['nas_file_copy', 'nas_file_tag_edit', 'nas_file_upload']) {
      expect([tool(n).minRisk, tool(n).maxRisk]).toEqual(['write', 'admin']);
    }
    for (const n of ['nas_file_mkdir', 'nas_file_create', 'nas_file_restore', 'nas_file_download']) {
      expect([tool(n).minRisk, tool(n).maxRisk]).toEqual(['write', 'write']);
    }
    for (const n of ['nas_file_move', 'nas_file_delete', 'nas_file_write', 'nas_file_quota_set']) {
      expect([tool(n).minRisk, tool(n).maxRisk]).toEqual(['admin', 'admin']);
    }
    expect(tool('nas_file_upload').localPath).toBeDefined();
    expect(tool('nas_file_download').localPath).toBeDefined();
    expect(tool('nas_file_copy').localPath).toBeUndefined();
  });

  it('tells the agent what to do after a delete', () => {
    expect(tool('nas_file_delete').followUp!(parse('nas_file_delete', { paths: ['/a'] }))).toContain('final_path');
    expect(tool('nas_file_delete').followUp!(parse('nas_file_delete', { paths: ['/a'], permanent: true }))).toBeUndefined();
  });
});

describe('review: slow requests and rename targets', () => {
  it('gives data-sized operations a longer unc request timeout', () => {
    expect(tool('nas_file_copy')).toBeDefined();
    expect(call('nas_file_copy', { source: '/a/x', destination_dir: '/b' })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 315_000 });
    expect(call('nas_file_move', { source: '/a/x', destination: '/b' })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 315_000 });
    expect(call('nas_file_delete', { paths: ['/a/x', '/a/y', '/a/z'] })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 915_000 });
  });

  it('lets the caller raise the checksum timeout and scales it per file', () => {
    expect(call('nas_file_checksum', { algorithm: 'sha256', paths: ['/a', '/b'] })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 615_000 });
    expect(call('nas_file_checksum', { algorithm: 'sha256', paths: ['/a'], timeout_seconds: 900 })).toMatchObject({ requestTimeoutSeconds: 900, timeoutMs: 915_000 });
  });

  it('refuses "." and ".." as a new name', () => {
    expect(() => call('nas_file_move', { source: '/a/x', destination: '..' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_move', { source: '/a/x', destination: '.' })).toThrowError(ToolInputError);
  });
});
