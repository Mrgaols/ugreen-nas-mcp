import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_file_roots', {}, ['file', 'ls-root', '--root=shared', '--limit=500'], 'read'],
  ['nas_file_list', {}, ['file', 'ls', '--limit=200', '--stream-timeout=120'], 'read'],
  [
    'nas_file_list',
    { path: '/volume1/照片/a b', recursive: true, limit: 0, timeout_seconds: 300 },
    ['file', 'ls', '--recursive', '--limit=0', '--stream-timeout=300', '--', '/volume1/照片/a b'],
    'read',
  ],
  ['nas_file_read', { path: '/home/u/a.txt' }, ['file', 'cat', '--offset=0', '--length=65536', '--', '/home/u/a.txt'], 'read'],
  [
    'nas_file_read',
    { path: '/home/u/a.txt', offset: 100, length: 50 },
    ['file', 'cat', '--offset=100', '--length=50', '--', '/home/u/a.txt'],
    'read',
  ],
  ['nas_file_stat', { paths: ['/a', '/b c'] }, ['file', 'stat', '--', '/a', '/b c'], 'read'],
  [
    'nas_file_find',
    { roots: ['/volume1/photo'], name: '*.jpg', kind: 'image', min_size: '10K', max_depth: 3 },
    ['file', 'find', '--name=*.jpg', '--category=image', '--min-size=10K', '--maxdepth=3', '--limit=200', '--stream-timeout=120', '--', '/volume1/photo'],
    'read',
  ],
  [
    'nas_file_find',
    { roots: ['/a', '/b'], kind: 'dir', time_field: 'mtime', since: 1700000000, until: 1800000000 },
    ['file', 'find', '--type=d', '--time=mtime', '--since=1700000000', '--until=1800000000', '--limit=200', '--stream-timeout=120', '--', '/a', '/b'],
    'read',
  ],
  [
    'nas_file_find',
    { roots: ['/a'], kind: 'file', max_size: '4M' },
    ['file', 'find', '--type=f', '--max-size=4M', '--limit=200', '--stream-timeout=120', '--', '/a'],
    'read',
  ],
  ['nas_file_usage', { kind: 'du', paths: ['/volume1/photo'], depth: 2 }, ['file', 'du', '-d', '2', '--stream-timeout=120', '--', '/volume1/photo'], 'read'],
  ['nas_file_usage', { kind: 'du', paths: ['/a'] }, ['file', 'du', '--stream-timeout=120', '--', '/a'], 'read'],
  ['nas_file_usage', { kind: 'quota', paths: ['/home/u'] }, ['file', 'quota', 'get', '--', '/home/u'], 'read'],
  ['nas_file_checksum', { algorithm: 'sha256', paths: ['/a/b.iso'] }, ['file', 'sha256sum', '--', '/a/b.iso'], 'read'],
  ['nas_file_checksum', { algorithm: 'md5', paths: ['/a/b.iso'] }, ['file', 'md5sum', '--', '/a/b.iso'], 'read'],
  ['nas_file_tags', { query: 'list_tags' }, ['file', 'tag', 'list'], 'read'],
  ['nas_file_tags', { query: 'tags_of_paths', paths: ['/a/b'] }, ['file', 'tag', 'file', 'get', '--', '/a/b'], 'read'],
  [
    'nas_file_tags',
    { query: 'files_by_tag', tag_ids: [1, 2], scope_path: '/volume1/photo', recursive: true },
    ['file', 'tag', 'file', 'list', '--path=/volume1/photo', '--recursive', '--stream-timeout=120', '--', '1', '2'],
    'read',
  ],
  ['nas_file_tags', { query: 'files_by_tag', tag_ids: [1] }, ['file', 'tag', 'file', 'list', '--stream-timeout=120', '--', '1'], 'read'],
];

describe('file read tools', () => {
  checkRows(rows);

  it('validates combinations', () => {
    expect(() => call('nas_file_find', { roots: ['/a'], since: 1 })).toThrowError(ToolInputError);
    expect(() => call('nas_file_usage', { kind: 'quota', paths: ['/a'], depth: 2 })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tags', { query: 'tags_of_paths' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tags', { query: 'files_by_tag' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tags', { query: 'files_by_tag', tag_ids: [1], recursive: true })).toThrowError(ToolInputError);
    expect(() => parse('nas_file_find', { roots: ['/a'], min_size: '10 MB' })).toThrow();
    expect(() => parse('nas_file_read', { path: '/a', length: 2_000_000 })).toThrow();
    expect(() => parse('nas_file_stat', { paths: [] })).toThrow();
  });

  it('declares paths and scope for the allowlist', () => {
    expect(tool('nas_file_list').unscoped!(parse('nas_file_list', {}))).toBe(true);
    expect(tool('nas_file_list').unscoped!(parse('nas_file_list', { path: '/a' }))).toBe(false);
    expect(tool('nas_file_list').nasPaths!(parse('nas_file_list', { path: '/a' }))).toEqual(['/a']);
    expect(tool('nas_file_read').nasPaths!(parse('nas_file_read', { path: '/a.txt' }))).toEqual(['/a.txt']);
    expect(tool('nas_file_stat').nasPaths!(parse('nas_file_stat', { paths: ['/a', '/b'] }))).toEqual(['/a', '/b']);
    expect(tool('nas_file_find').nasPaths!(parse('nas_file_find', { roots: ['/a', '/b'] }))).toEqual(['/a', '/b']);
    expect(tool('nas_file_usage').nasPaths!(parse('nas_file_usage', { kind: 'du', paths: ['/a'] }))).toEqual(['/a']);
    expect(tool('nas_file_checksum').nasPaths!(parse('nas_file_checksum', { algorithm: 'md5', paths: ['/a'] }))).toEqual(['/a']);
    const t = tool('nas_file_tags');
    expect(t.unscoped!(parse('nas_file_tags', { query: 'files_by_tag', tag_ids: [1] }))).toBe(true);
    expect(t.unscoped!(parse('nas_file_tags', { query: 'list_tags' }))).toBe(false);
    expect(t.nasPaths!(parse('nas_file_tags', { query: 'files_by_tag', tag_ids: [1], scope_path: '/s' }))).toEqual(['/s']);
    expect(t.nasPaths!(parse('nas_file_tags', { query: 'tags_of_paths', paths: ['/p'] }))).toEqual(['/p']);
  });

  it('reads raw bytes and decodes them', () => {
    const t = tool('nas_file_read');
    const args = parse('nas_file_read', { path: '/a.txt', offset: 5 });
    expect(call('nas_file_read', { path: '/a.txt' }).raw).toBe(true);
    expect(t.render!(Buffer.from('héllo'), args)).toEqual({ path: '/a.txt', offset: 5, bytes: 6, encoding: 'utf8', content: 'héllo' });
    expect(t.render!(Buffer.from([0xff, 0xfe, 0x00]), args)).toEqual({ path: '/a.txt', offset: 5, bytes: 3, encoding: 'base64', content: '//4A' });
  });

  it('gives slow commands a longer timeout', () => {
    expect(call('nas_file_checksum', { algorithm: 'md5', paths: ['/a'] }).timeoutMs).toBe(315000);
    expect(call('nas_file_list', { timeout_seconds: 300 }).timeoutMs).toBe(315000);
  });

  it('tells the agent where each tool puts its results (verified against a real NAS)', () => {
    // find answers with one envelope for all roots: entries[] at the top level, absent when nothing matches.
    expect(tool('nas_file_find').description).toContain('top-level entries[]');
    expect(tool('nas_file_find').description).not.toContain('items[0].entries');
    // ls and du fan out per path.
    expect(tool('nas_file_list').description).toContain('items[0].entries[]');
    expect(tool('nas_file_usage').description).toContain('items[].entries[]');
  });

  it('is read-only by declaration', () => {
    for (const name of ['nas_file_roots', 'nas_file_list', 'nas_file_read', 'nas_file_stat', 'nas_file_find', 'nas_file_usage', 'nas_file_checksum', 'nas_file_tags']) {
      expect([tool(name).toolset, tool(name).minRisk, tool(name).maxRisk]).toEqual(['file', 'read', 'read']);
    }
  });
});
