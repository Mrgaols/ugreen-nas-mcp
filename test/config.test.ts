import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.access).toBe('read');
    expect([...c.toolsets].sort()).toEqual([
      'app',
      'ctl',
      'docker',
      'download',
      'file',
      'network',
      'search',
      'storage',
      'taskmgr',
    ]);
    expect(c.allowedPaths).toEqual([]);
    expect(c.localDir).toBeNull();
    expect(c.uncBin).toBeNull();
    expect(c.maxOutputChars).toBe(60000);
  });

  it('trims whitespace, ignores case and drops empty list items', () => {
    const c = loadConfig({
      UGREEN_MCP_ACCESS: ' Admin ',
      UGREEN_MCP_TOOLSETS: ' file , Docker ,',
      UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs/, /home/von,',
      UGREEN_MCP_LOCAL_DIR: ' /tmp/nas ',
      UGREEN_MCP_UNC_BIN: ' /opt/unc ',
      UGREEN_MCP_MAX_OUTPUT_CHARS: ' 1000 ',
    });
    expect(c.access).toBe('admin');
    expect([...c.toolsets]).toEqual(['file', 'docker']);
    expect(c.allowedPaths).toEqual(['/volume1/docs', '/home/von']);
    expect(c.localDir).toBe('/tmp/nas');
    expect(c.uncBin).toBe('/opt/unc');
    expect(c.maxOutputChars).toBe(1000);
  });

  it('treats empty and whitespace-only values as unset', () => {
    const c = loadConfig({
      UGREEN_MCP_ACCESS: '',
      UGREEN_MCP_TOOLSETS: '  ',
      UGREEN_MCP_ALLOWED_PATHS: ' , ',
      UGREEN_MCP_LOCAL_DIR: '',
      UGREEN_MCP_UNC_BIN: ' ',
      UGREEN_MCP_MAX_OUTPUT_CHARS: '',
    });
    expect(c.access).toBe('read');
    expect(c.toolsets.size).toBe(9);
    expect(c.allowedPaths).toEqual([]);
    expect(c.localDir).toBeNull();
    expect(c.uncBin).toBeNull();
    expect(c.maxOutputChars).toBe(60000);
  });

  it.each([
    [{ UGREEN_MCP_ACCESS: 'root' }, 'root'],
    [{ UGREEN_MCP_TOOLSETS: 'file,nope' }, 'nope'],
    [{ UGREEN_MCP_ALLOWED_PATHS: 'volume1/docs' }, 'volume1/docs'],
    [{ UGREEN_MCP_ALLOWED_PATHS: '/volume1/../etc' }, '/volume1/../etc'],
    [{ UGREEN_MCP_LOCAL_DIR: 'relative/dir' }, 'relative/dir'],
    [{ UGREEN_MCP_MAX_OUTPUT_CHARS: 'abc' }, 'abc'],
    [{ UGREEN_MCP_MAX_OUTPUT_CHARS: '999' }, '999'],
  ])('rejects %j and names the bad value', (env, bad) => {
    expect(() => loadConfig(env)).toThrowError(ConfigError);
    expect(() => loadConfig(env)).toThrowError(bad);
  });

  it('names the variable in the error', () => {
    expect(() => loadConfig({ UGREEN_MCP_ACCESS: 'root' })).toThrowError('UGREEN_MCP_ACCESS');
    expect(() => loadConfig({ UGREEN_MCP_TOOLSETS: 'nope' })).toThrowError('UGREEN_MCP_TOOLSETS');
  });
});
