import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { enabledTools } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-unc.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const count = (env: NodeJS.ProcessEnv) => enabledTools(loadConfig(env), ALL_TOOLS).length;

describe('tool catalogue', () => {
  it('has 46 uniquely named, documented tools', () => {
    expect(ALL_TOOLS).toHaveLength(46);
    expect(new Set(ALL_TOOLS.map((t) => t.name)).size).toBe(46);
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^nas_[a-z_]+$/);
      expect(t.title.length, t.name).toBeGreaterThan(3);
      expect(t.description.length, t.name).toBeGreaterThanOrEqual(60);
      expect(t.description.length, t.name).toBeLessThanOrEqual(1600);
      expect(t.description, t.name).not.toMatch(/[一-鿿]/);
    }
  });

  it('registers the documented number of tools per level', () => {
    expect(count({})).toBe(25);
    expect(count({ UGREEN_MCP_ACCESS: 'write' })).toBe(33);
    expect(count({ UGREEN_MCP_ACCESS: 'write', UGREEN_MCP_LOCAL_DIR: '/tmp' })).toBe(35);
    expect(count({ UGREEN_MCP_ACCESS: 'admin' })).toBe(44);
    expect(count({ UGREEN_MCP_ACCESS: 'admin', UGREEN_MCP_LOCAL_DIR: '/tmp' })).toBe(46);
    expect(count({ UGREEN_MCP_TOOLSETS: 'file' })).toBe(9);
    expect(count({ UGREEN_MCP_TOOLSETS: 'network,taskmgr' })).toBe(3);
  });

  it('keeps risk bounds consistent', () => {
    const order = { read: 0, write: 1, admin: 2 } as const;
    for (const t of ALL_TOOLS) expect(order[t.minRisk], t.name).toBeLessThanOrEqual(order[t.maxRisk]);
  });

  it('only exposes read-only tools at the default level', () => {
    for (const t of enabledTools(loadConfig({}), ALL_TOOLS)) expect(t.minRisk, t.name).toBe('read');
  });
});

describe('stdio end to end', () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function connect(env: Record<string, string>) {
    client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: { PATH: process.env.PATH ?? '', UGREEN_MCP_UNC_BIN: FAKE, ...env },
        stderr: 'pipe',
      }),
    );
    return client;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (r: any) => JSON.parse(r.content[0].text);

  it('lists 25 tools by default and passes arguments verbatim', async () => {
    const c = await connect({});
    expect((await c.listTools()).tools).toHaveLength(25);
    const r = await c.callTool({ name: 'nas_docker_logs', arguments: { target: 'container', id: '-rf' } });
    expect(body(r).argv).toEqual(['--format=json', 'docker', 'logs', '--', '-rf']);
    const s = await c.callTool({ name: 'nas_file_stat', arguments: { paths: ['/volume1/照片/a b.jpg'] } });
    expect(body(s).argv).toEqual(['--format=json', 'file', 'stat', '--', '/volume1/照片/a b.jpg']);
  });

  it('does not offer write tools at the default level', async () => {
    const c = await connect({});
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('nas_file_delete');
    expect(names).not.toContain('nas_file_mkdir');
    const r = await c.callTool({ name: 'nas_file_delete', arguments: { paths: ['/a'] } }).catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it('runs the two-step confirmation over the wire', async () => {
    const c = await connect({ UGREEN_MCP_ACCESS: 'admin' });
    expect((await c.listTools()).tools).toHaveLength(44);
    const preview = body(await c.callTool({ name: 'nas_file_delete', arguments: { paths: ['/home/u/a.txt'] } }));
    expect(preview.status).toBe('confirmation_required');
    expect(preview.preview.argv).toContain('--dry-run');
    expect(preview.preview.argv).not.toContain('--yes');
    const done = body(
      await c.callTool({ name: 'nas_file_delete', arguments: { paths: ['/home/u/a.txt'], confirm_token: preview.confirm_token } }),
    );
    expect(done.argv).toEqual(['--format=json', '--timeout=300', '--yes', 'file', 'rm', '--', '/home/u/a.txt']);
  });

  it('keeps secrets out of the unc argument list', async () => {
    const c = await connect({ UGREEN_MCP_ACCESS: 'admin' });
    const preview = body(await c.callTool({ name: 'nas_user_create', arguments: { username: 'bob', password: 's3cret-pw' } }));
    expect(preview.preview.stdin).toBe('s3cret-pw');
    expect(preview.preview.argv.join(' ')).not.toContain('s3cret-pw');
  });

  it('exposes transfer tools only with a local directory and confines them to it', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'nasmcp-e2e-')));
    const c = await connect({ UGREEN_MCP_ACCESS: 'write', UGREEN_MCP_LOCAL_DIR: dir });
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('nas_file_download');
    const okCall = body(await c.callTool({ name: 'nas_file_download', arguments: { remote_path: '/volume1/docs/r.pdf' } }));
    expect(okCall.argv.at(-1)).toBe(path.join(dir, 'r.pdf'));
    const escape = await c.callTool({ name: 'nas_file_download', arguments: { remote_path: '/d/r.pdf', local_path: '../r.pdf' } });
    expect(escape.isError).toBe(true);
  });

  it('enforces the NAS path allowlist', async () => {
    const c = await connect({ UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs' });
    const inside = await c.callTool({ name: 'nas_file_list', arguments: { path: '/volume1/docs/2026' } });
    expect(inside.isError).toBeFalsy();
    const outside = await c.callTool({ name: 'nas_file_list', arguments: { path: '/volume1/docs-private' } });
    expect(outside.isError).toBe(true);
    expect(body(outside).hint).toContain('UGREEN_MCP_ALLOWED_PATHS');
    const unscoped = await c.callTool({ name: 'nas_file_list', arguments: {} });
    expect(unscoped.isError).toBe(true);
  });

  it('rejects a call the schema does not allow', async () => {
    const c = await connect({});
    const r = await c.callTool({ name: 'nas_file_read', arguments: { path: '/a', length: 99999999 } }).catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
  });

  it('surfaces unc failures as tool errors with a hint', async () => {
    const c = await connect({ FAKE_UNC_MODE: 'stderr-only' });
    const r = await c.callTool({ name: 'nas_file_roots', arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).hint).toContain('UNC_NAS_TOKEN');
  });

  it('reports output that is not JSON instead of crashing', async () => {
    const c = await connect({ FAKE_UNC_MODE: 'garbage' });
    const r = await c.callTool({ name: 'nas_file_roots', arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/unexpected output/i);
    const again = await c.callTool({ name: 'nas_status', arguments: {} });
    expect(again.content).toBeDefined();
  });

  it('truncates oversized output', async () => {
    const c = await connect({ FAKE_UNC_MODE: 'big', UGREEN_MCP_MAX_OUTPUT_CHARS: '2000' });
    const r = await c.callTool({ name: 'nas_file_roots', arguments: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (r as any).content[0].text as string;
    expect(text.length).toBeLessThan(2300);
    expect(text).toContain('[truncated: showing 2000 of');
  });

  it('starts without unc and explains how to fix it', async () => {
    const c = await connect({ UGREEN_MCP_UNC_BIN: '/nonexistent/unc' });
    expect((await c.listTools()).tools).toHaveLength(25);
    const r = await c.callTool({ name: 'nas_status', arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).hint).toContain('UGREEN_MCP_UNC_BIN');
    const other = await c.callTool({ name: 'nas_file_roots', arguments: {} });
    expect(other.isError).toBe(true);
    expect(body(other).hint).toContain('UGREEN_MCP_UNC_BIN');
  });

  it('exits with code 2 on invalid configuration and prints nothing on stdout', () => {
    const p = spawnSync(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? '', UGREEN_MCP_ACCESS: 'root' },
      encoding: 'utf8',
    });
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('UGREEN_MCP_ACCESS');
    expect(p.stdout).toBe('');
  });

  it('exits with code 2 when the local transfer directory does not exist', () => {
    const p = spawnSync(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? '', UGREEN_MCP_LOCAL_DIR: '/nonexistent/nas-mcp-dir' },
      encoding: 'utf8',
    });
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('UGREEN_MCP_LOCAL_DIR');
  });
});
