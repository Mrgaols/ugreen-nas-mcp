import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ALL_TOOLS } from '../src/tools/index.js';

const ENV = [
  'UNC_NAS_URL',
  'UNC_NAS_TOKEN',
  'UGREEN_MCP_ACCESS',
  'UGREEN_MCP_TOOLSETS',
  'UGREEN_MCP_ALLOWED_PATHS',
  'UGREEN_MCP_LOCAL_DIR',
  'UGREEN_MCP_UNC_BIN',
  'UGREEN_MCP_MAX_OUTPUT_CHARS',
];

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

describe.each(['README.md', 'README.en.md'])('%s', (file) => {
  it('documents every tool and every environment variable', async () => {
    const text = await read(file);
    for (const t of ALL_TOOLS) expect(text, t.name).toContain('`' + t.name + '`');
    for (const v of ENV) expect(text, v).toContain(v);
  });

  it('states the tool counts the server actually registers', async () => {
    const text = await read(file);
    for (const n of ['46', '25', '33', '44']) expect(text, n).toContain(n);
  });

  it('carries no real token', async () => {
    const text = await read(file);
    expect(text).not.toMatch(/ugpoa_v1\.(?!\*\*\*)[A-Za-z0-9]/);
  });

  it('says it is unofficial', async () => {
    expect(await read(file)).toMatch(/非官方|unofficial/i);
  });
});

it('the two READMEs link to each other', async () => {
  expect(await read('README.md')).toContain('README.en.md');
  expect(await read('README.en.md')).toContain('README.md');
});

it('LICENSE is MIT with the project as holder', async () => {
  const text = await read('LICENSE');
  expect(text).toContain('MIT License');
  expect(text).toContain('ugreen-nas-mcp contributors');
});
