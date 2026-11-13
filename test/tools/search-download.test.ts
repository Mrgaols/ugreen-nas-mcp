import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  [
    'nas_search_files',
    { query: '合同', paths: ['/volume1/docs'], suffix: 'pdf' },
    ['search', 'title', '--path=/volume1/docs', '--recursive', '--suffix=pdf', '--sort-by=name', '--limit=50', '--stream-timeout=120', '--', '合同'],
    'read',
  ],
  [
    'nas_search_files',
    {
      paths: ['/a', '/b'],
      recursive: false,
      classes: ['video', 'image'],
      min_size: '1G',
      modified_from: 1767225600,
      tag_ids: [3],
      sort_by: 'size',
      order: 'desc',
      limit: 20,
      max_results: 500,
    },
    [
      'search', 'title', '--path=/a', '--path=/b', '--class=video,image', '--min-size=1G', '--modified-from=1767225600',
      '--tag-id=3', '--sort-by=size', '--order=desc', '--limit=20', '--max-results=500', '--stream-timeout=120',
    ],
    'read',
  ],
  ['nas_search_files', { query: 'x' }, ['search', 'title', '--sort-by=name', '--limit=50', '--stream-timeout=120', '--', 'x'], 'read'],
  [
    'nas_search_files',
    { query: '-rf', paths: ['/a'], max_size: '4M', modified_to: 1800000000 },
    ['search', 'title', '--path=/a', '--recursive', '--max-size=4M', '--modified-to=1800000000', '--sort-by=name', '--limit=50', '--stream-timeout=120', '--', '-rf'],
    'read',
  ],
  [
    'nas_search_results',
    { task_id: 'abc', offset: 100, sort_by: 'size', order: 'desc' },
    ['search', 'results', '--offset=100', '--limit=50', '--sort-by=size', '--order=desc', '--', 'abc'],
    'read',
  ],
  ['nas_search_results', { task_id: 'abc' }, ['search', 'results', '--offset=0', '--limit=50', '--sort-by=name', '--', 'abc'], 'read'],
  ['nas_search_results', { action: 'cancel', task_id: 'abc' }, ['search', 'cancel', '--', 'abc'], 'read'],
  ['nas_search_results', { action: 'remove', task_id: 'abc' }, ['search', 'rm', '--', 'abc'], 'read'],
  ['nas_download_list', {}, ['download', 'ls'], 'read'],
  ['nas_download_list', { task_ids: ['10086', '10087'] }, ['download', 'status', '--', '10086', '10087'], 'read'],
  [
    'nas_download_create',
    { url: 'magnet:?xt=urn:btih:abc&dn=x', dir: '/volume1/downloads' },
    ['download', 'create', '--dir=/volume1/downloads', '--', 'magnet:?xt=urn:btih:abc&dn=x'],
    'write',
  ],
  ['nas_download_create', { url: 'https://example.com/a.iso' }, ['download', 'create', '--', 'https://example.com/a.iso'], 'write'],
  ['nas_download_control', { action: 'pause', task_ids: ['1'] }, ['download', 'pause', '--', '1'], 'write'],
  ['nas_download_control', { action: 'resume', task_ids: ['1', '2'] }, ['download', 'resume', '--', '1', '2'], 'write'],
  ['nas_download_control', { action: 'retry', all: true }, ['download', 'retry', '--all'], 'admin'],
  ['nas_download_control', { action: 'remove', task_ids: ['1'] }, ['download', 'rm', '--', '1'], 'admin'],
  ['nas_download_control', { action: 'remove', all: true }, ['download', 'rm', '--all'], 'admin'],
];

describe('search and download tools', () => {
  checkRows(rows);

  it('requires exactly one of task_ids and all', () => {
    expect(() => call('nas_download_control', { action: 'pause' })).toThrowError(ToolInputError);
    expect(() => call('nas_download_control', { action: 'pause', task_ids: [] })).toThrowError(ToolInputError);
    expect(() => call('nas_download_control', { action: 'pause', task_ids: ['1'], all: true })).toThrowError(ToolInputError);
  });

  it('rejects impossible search filters', () => {
    tool('nas_search_files');
    expect(() => parse('nas_search_files', { query: 'x', limit: 501 })).toThrow();
    expect(() => parse('nas_search_files', { query: 'x', classes: ['movies'] })).toThrow();
    expect(() => parse('nas_search_files', { query: 'x', min_size: 'big' })).toThrow();
  });

  it('declares scope for the allowlist', () => {
    const s = tool('nas_search_files');
    expect(s.unscoped!(parse('nas_search_files', { query: 'x' }))).toBe(true);
    expect(s.unscoped!(parse('nas_search_files', { paths: ['/a'] }))).toBe(false);
    expect(s.nasPaths!(parse('nas_search_files', { paths: ['/a'] }))).toEqual(['/a']);
    const d = tool('nas_download_create');
    expect(d.unscoped!(parse('nas_download_create', { url: 'https://e.com/a' }))).toBe(true);
    expect(d.nasPaths!(parse('nas_download_create', { url: 'https://e.com/a', dir: '/dl' }))).toEqual(['/dl']);
  });

  it('explains follow-up steps', () => {
    expect(tool('nas_search_files').followUp!(parse('nas_search_files', { query: 'x' }))).toContain('nas_search_results');
    expect(tool('nas_download_create').followUp!(parse('nas_download_create', { url: 'https://e.com/a' }))).toContain('nas_download_list');
    expect(tool('nas_download_control').followUp!(parse('nas_download_control', { action: 'resume', task_ids: ['1'] }))).toContain('nas_download_list');
  });

  it('gives a search the time it was allowed', () => {
    expect(call('nas_search_files', { query: 'x', timeout_seconds: 600 }).timeoutMs).toBe(615000);
  });

  it('sets registration bounds', () => {
    expect([tool('nas_search_files').toolset, tool('nas_search_files').maxRisk]).toEqual(['search', 'read']);
    expect([tool('nas_search_results').toolset, tool('nas_search_results').maxRisk]).toEqual(['search', 'read']);
    expect([tool('nas_download_list').toolset, tool('nas_download_list').maxRisk]).toEqual(['download', 'read']);
    expect([tool('nas_download_create').minRisk, tool('nas_download_create').maxRisk]).toEqual(['write', 'write']);
    expect([tool('nas_download_control').minRisk, tool('nas_download_control').maxRisk]).toEqual(['write', 'admin']);
  });
});
