import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { ConfirmStore } from '../src/confirm.js';
import {
  defineTool,
  cmd,
  opt,
  csv,
  streamTimeout,
  requestTimeout,
  ToolInputError,
  type Deps,
  type ToolSpec,
} from '../src/tools/types.js';
import { enabledTools, executeTool, buildServer, INSTRUCTIONS } from '../src/server.js';
import { coreTools } from '../src/tools/core.js';
import type { UncResult } from '../src/unc/runner.js';

const calls: Array<{ argv: string[]; stdin?: string | Buffer; timeoutMs?: number }> = [];
const reply = (env: unknown, exitCode = 0): UncResult => ({
  exitCode,
  stdout: Buffer.from(JSON.stringify(env)),
  stderr: '',
  timedOut: false,
});

function deps(
  env: NodeJS.ProcessEnv = {},
  respond: (argv: string[]) => UncResult = () => reply({ success: true, data: { ok: 1 } }),
): Deps {
  calls.length = 0;
  return {
    config: loadConfig(env),
    confirm: new ConfirmStore(),
    version: '0.0.0',
    runner: async (argv, opts) => {
      calls.push({ argv, ...opts });
      return respond(argv);
    },
  };
}

const text = (r: { content: unknown[] }) => JSON.parse((r.content[0] as { text: string }).text);

const readTool = defineTool({
  name: 'nas_t_read',
  toolset: 'file',
  title: 'r',
  description: 'd',
  input: { path: z.string().optional() },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => (a.path ? [a.path] : []),
  unscoped: (a) => !a.path,
  build: (a) => ({ argv: cmd(['file', 'ls'], [], a.path ? [a.path] : []) }),
  followUp: () => 'then do y',
});

const writeTool = defineTool({
  name: 'nas_t_write',
  toolset: 'docker',
  title: 'w',
  description: 'd',
  input: { replace: z.boolean().default(false) },
  minRisk: 'write',
  maxRisk: 'admin',
  risk: (a) => (a.replace ? 'admin' : 'write'),
  build: (a) => ({ argv: cmd(['docker', 'pull'], [opt('replace', a.replace)], ['x']), stdin: 'yaml' }),
});

const adminTool = defineTool({
  name: 'nas_t_admin',
  toolset: 'file',
  title: 'a',
  description: 'd',
  input: { paths: z.array(z.string()) },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  nasPaths: (a) => a.paths,
  build: (a) => {
    if (a.paths.length === 0) throw new ToolInputError('paths must not be empty');
    return { argv: cmd(['file', 'rm'], [], a.paths) };
  },
});

const xferTool = defineTool({
  name: 'nas_t_xfer',
  toolset: 'file',
  title: 'x',
  description: 'd',
  input: { local_path: z.string() },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  localPath: (a) => ({ path: a.local_path, mode: 'target' }),
  build: (_a, ctx) => ({ argv: cmd(['file', 'download'], [], ['/r', ctx.localPath!]) }),
});

const rawTool = defineTool({
  name: 'nas_t_raw',
  toolset: 'file',
  title: 'raw',
  description: 'd',
  input: { path: z.string() },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => ({ argv: cmd(['file', 'cat'], [], [a.path]), raw: true, timeoutMs: 1234 }),
  render: (stdout, a) => ({ path: a.path, bytes: stdout.length }),
});

const all: ToolSpec[] = [...coreTools, readTool, writeTool, adminTool, xferTool];

describe('argv helpers', () => {
  it('build argument lists', () => {
    expect(cmd(['file', 'stat'], [undefined, false, '--x'], ['/a'])).toEqual(['file', 'stat', '--x', '--', '/a']);
    expect(cmd(['docker', 'ps'], [])).toEqual(['docker', 'ps']);
    expect(cmd(['docker', 'ps'])).toEqual(['docker', 'ps']);
    expect([
      opt('limit', 5),
      opt('limit', 0),
      opt('recursive', true),
      opt('recursive', false),
      opt('name', undefined),
      opt('name', '-x'),
    ]).toEqual(['--limit=5', '--limit=0', '--recursive', undefined, undefined, '--name=-x']);
    expect([csv('status', ['a', 'b']), csv('status', []), csv('status', undefined)]).toEqual([
      '--status=a,b',
      undefined,
      undefined,
    ]);
    expect(streamTimeout(120)).toEqual({ flag: '--stream-timeout=120', timeoutMs: 135000 });
  });
});

describe('enabledTools', () => {
  const names = (env: NodeJS.ProcessEnv) => enabledTools(loadConfig(env), all).map((t) => t.name);

  it('read level: read tools only, core always present', () => expect(names({})).toEqual(['nas_status', 'nas_t_read']));
  it('write level without a local dir hides transfer tools', () =>
    expect(names({ UGREEN_MCP_ACCESS: 'write' })).toEqual(['nas_status', 'nas_t_read', 'nas_t_write']));
  it('admin level with a local dir registers everything', () =>
    expect(names({ UGREEN_MCP_ACCESS: 'admin', UGREEN_MCP_LOCAL_DIR: '/tmp' })).toHaveLength(5));
  it('toolset filter keeps core', () =>
    expect(names({ UGREEN_MCP_ACCESS: 'admin', UGREEN_MCP_TOOLSETS: 'docker' })).toEqual(['nas_status', 'nas_t_write']));
});

describe('executeTool', () => {
  it('runs a read call with --format=json and attaches next_step', async () => {
    const d = deps();
    const r = await executeTool(readTool, { path: '/volume1/docs' }, d);
    expect(calls[0].argv).toEqual(['--format=json', 'file', 'ls', '--', '/volume1/docs']);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toEqual({ success: true, data: { ok: 1 }, next_step: 'then do y' });
  });

  it('refuses a call above the access level without running unc', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'write' });
    const r = await executeTool(writeTool, { replace: true }, d);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(text(r).error).toContain('admin');
    expect(text(r).hint).toContain('UGREEN_MCP_ACCESS');
  });

  it('previews an admin call with --dry-run and returns a token', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' }, () => reply({ success: true, dry_run: true }));
    const r = await executeTool(adminTool, { paths: ['/a/x'] }, d);
    expect(calls[0].argv).toEqual(['--format=json', '--dry-run', 'file', 'rm', '--', '/a/x']);
    const body = text(r);
    expect(body.status).toBe('confirmation_required');
    expect(body.confirm_token).toMatch(/^[0-9a-f]{12}$/);
    expect(body.expires_in_seconds).toBe(300);
    expect(body.preview).toEqual({ success: true, dry_run: true });
    expect(body.next_step).toContain('confirm_token');
  });

  it('executes with --yes once, then rejects reuse and changed arguments', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const token = text(await executeTool(adminTool, { paths: ['/a/x'] }, d)).confirm_token;
    const done = await executeTool(adminTool, { paths: ['/a/x'], confirm_token: token }, d);
    expect(done.isError).toBeFalsy();
    expect(calls[1].argv).toEqual(['--format=json', '--yes', 'file', 'rm', '--', '/a/x']);

    const reused = await executeTool(adminTool, { paths: ['/a/x'], confirm_token: token }, d);
    expect(reused.isError).toBe(true);

    const t2 = text(await executeTool(adminTool, { paths: ['/a/x'] }, d)).confirm_token;
    const drift = await executeTool(adminTool, { paths: ['/a/y'], confirm_token: t2 }, d);
    expect(drift.isError).toBe(true);
    expect(text(drift).error).toMatch(/do not match/i);
    expect(calls.filter((c) => c.argv.includes('--yes'))).toHaveLength(1);
  });

  it('issues no token when the preview fails', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' }, () => reply({ success: false, error: 'NotFound (HTTP 404)' }, 1));
    const r = await executeTool(adminTool, { paths: ['/a/x'] }, d);
    expect(r.isError).toBe(true);
    expect(text(r).confirm_token).toBeUndefined();
    expect(text(r).error).toBe('NotFound (HTTP 404)');
  });

  it('passes stdin through and treats argument-dependent risk as admin', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    await executeTool(writeTool, { replace: false }, d);
    expect(calls[0]).toMatchObject({ argv: ['--format=json', 'docker', 'pull', '--', 'x'], stdin: 'yaml' });
    await executeTool(writeTool, { replace: true }, d);
    expect(calls[1].argv).toEqual(['--format=json', '--dry-run', 'docker', 'pull', '--replace', '--', 'x']);
    expect(calls[1].stdin).toBe('yaml');
  });

  it('applies schema defaults and rejects invalid arguments', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'write' });
    await executeTool(writeTool, {}, d);
    expect(calls[0].argv).toEqual(['--format=json', 'docker', 'pull', '--', 'x']);
    const bad = await executeTool(writeTool, { replace: 'yes' }, d);
    expect(bad.isError).toBe(true);
    expect(text(bad).error).toContain('replace');
    expect(calls).toHaveLength(1);
  });

  it('enforces the path allowlist and the scope requirement', async () => {
    const d = deps({ UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs' });
    expect((await executeTool(readTool, { path: '/volume1/docs-private' }, d)).isError).toBe(true);
    const unscoped = await executeTool(readTool, {}, d);
    expect(unscoped.isError).toBe(true);
    expect(text(unscoped).hint).toContain('UGREEN_MCP_ALLOWED_PATHS');
    expect(calls).toHaveLength(0);
    expect((await executeTool(readTool, { path: '/volume1/docs/a' }, d)).isError).toBeFalsy();
  });

  it('allows an unscoped call when there is no allowlist', async () => {
    const d = deps();
    expect((await executeTool(readTool, {}, d)).isError).toBeFalsy();
    expect(calls[0].argv).toEqual(['--format=json', 'file', 'ls']);
  });

  it('rejects malformed NAS paths even without an allowlist', async () => {
    const d = deps();
    expect((await executeTool(readTool, { path: '-rf' }, d)).isError).toBe(true);
    expect((await executeTool(readTool, { path: '/a/../b' }, d)).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('resolves local paths inside the configured directory', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'write', UGREEN_MCP_LOCAL_DIR: process.cwd() });
    await executeTool(xferTool, { local_path: 'out.bin' }, d);
    expect(calls[0].argv.at(-1)).toMatch(/[\\/]out\.bin$/);
    const escape = await executeTool(xferTool, { local_path: '../escape.bin' }, d);
    expect(escape.isError).toBe(true);
    expect(text(escape).hint).toContain('UGREEN_MCP_LOCAL_DIR');
  });

  it('refuses transfers when no local directory is configured', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'write' });
    const r = await executeTool(xferTool, { local_path: 'out.bin' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).hint).toContain('UGREEN_MCP_LOCAL_DIR');
    expect(calls).toHaveLength(0);
  });

  it('runs raw calls with --format=raw and renders the bytes', async () => {
    const d = deps({}, () => ({ exitCode: 0, stdout: Buffer.from([1, 2, 3]), stderr: '', timedOut: false }));
    const r = await executeTool(rawTool, { path: '/a.bin' }, d);
    expect(calls[0]).toMatchObject({ argv: ['--format=raw', 'file', 'cat', '--', '/a.bin'], timeoutMs: 1234 });
    expect(text(r)).toEqual({ path: '/a.bin', bytes: 3 });
  });

  it('reports a failed raw call from stderr', async () => {
    const d = deps({}, () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: 'Error: NotFound (HTTP 404)', timedOut: false }));
    const r = await executeTool(rawTool, { path: '/a.bin' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).error).toBe('Error: NotFound (HTTP 404)');
  });

  it('reports tool input errors and never throws', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const r = await executeTool(adminTool, { paths: [] }, d);
    expect(r.isError).toBe(true);
    expect(text(r).error).toBe('paths must not be empty');
  });

  it('returns the install hint when unc is missing', async () => {
    const d = { ...deps(), runner: null };
    const r = await executeTool(readTool, { path: '/a' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).hint).toMatch(/UGREEN_MCP_UNC_BIN/);
  });

  it('surfaces unc failures with a hint', async () => {
    const d = deps({}, () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: 'Error: 尚未登录，请先运行 unc auth login',
      timedOut: false,
    }));
    const r = await executeTool(readTool, { path: '/a' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).hint).toContain('UNC_NAS_TOKEN');
  });

  it('logs the tool name and outcome but never argument values', async () => {
    const lines: string[] = [];
    const d = { ...deps(), log: (line: string) => lines.push(line) };
    await executeTool(readTool, { path: '/volume1/secret-folder' }, d);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('nas_t_read');
    expect(lines[0]).toContain('exit=0');
    expect(lines[0]).not.toContain('secret-folder');
  });
});

describe('nas_status', () => {
  const status = coreTools[0];

  it('reports auth, unc version and policy without running doctor by default', async () => {
    const d = deps({ UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs' }, (argv) =>
      argv.includes('auth')
        ? reply({ success: true, authenticated: true, username: 'u' })
        : reply({ success: true, version: '0.1.61' }),
    );
    const body = text(await executeTool(status, {}, d));
    expect(calls.map((c) => c.argv)).toEqual([
      ['--format=json', 'auth', 'status', '--check'],
      ['--format=json', 'version'],
    ]);
    expect(body.auth.authenticated).toBe(true);
    expect(body.unc.version).toBe('0.1.61');
    expect(body.policy).toEqual({
      access: 'read',
      toolsets: expect.any(Array),
      allowed_paths: ['/volume1/docs'],
      local_transfer: 'disabled',
      max_output_chars: 60000,
    });
    expect(body.hint).toBeUndefined();
  });

  it('runs doctor on request and hints when not authenticated', async () => {
    const d = deps({}, (argv) =>
      argv.includes('auth') ? reply({ success: true, authenticated: false }) : reply({ success: true }),
    );
    const body = text(await executeTool(status, { doctor: true }, d));
    expect(calls.map((c) => c.argv[1])).toEqual(['auth', 'version', 'doctor']);
    expect(body.policy.allowed_paths).toBe('unrestricted');
    expect(body.hint).toContain('UNC_NAS_TOKEN');
  });

  it('reports a missing unc with the policy still included', async () => {
    const r = await executeTool(status, {}, { ...deps(), runner: null });
    expect(r.isError).toBe(true);
    expect(text(r).hint).toMatch(/UGREEN_MCP_UNC_BIN/);
    expect(text(r).policy.access).toBe('read');
  });
});

describe('buildServer', () => {
  it('lists tools with annotations and a confirm_token parameter on admin-capable tools', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([buildServer(d, all).connect(a), client.connect(b)]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['nas_status', 'nas_t_admin', 'nas_t_read', 'nas_t_write']);
    expect(byName.nas_t_read.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.nas_t_admin.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(byName.nas_t_admin.inputSchema.properties ?? {})).toContain('confirm_token');
    expect(Object.keys(byName.nas_t_write.inputSchema.properties ?? {})).toContain('confirm_token');
    expect(Object.keys(byName.nas_t_read.inputSchema.properties ?? {})).not.toContain('confirm_token');

    const r = await client.callTool({ name: 'nas_t_read', arguments: { path: '/a' } });
    expect(r.isError).toBeFalsy();
    expect(calls[0].argv).toEqual(['--format=json', 'file', 'ls', '--', '/a']);

    const preview = await client.callTool({ name: 'nas_t_admin', arguments: { paths: ['/a/x'] } });
    const token = text(preview as { content: unknown[] }).confirm_token;
    const done = await client.callTool({ name: 'nas_t_admin', arguments: { paths: ['/a/x'], confirm_token: token } });
    expect(done.isError).toBeFalsy();
    expect(calls.at(-1)!.argv).toContain('--yes');
  });
});

describe('review: request timeout and truncation-safe results', () => {
  const slowAdmin = defineTool({
    name: 'nas_t_slow',
    toolset: 'file',
    title: 's',
    description: 'd',
    input: { paths: z.array(z.string()) },
    minRisk: 'admin',
    maxRisk: 'admin',
    risk: () => 'admin',
    build: (a) => ({ argv: cmd(['file', 'rm'], [], a.paths), ...requestTimeout(300, a.paths.length) }),
    followUp: () => 'verify afterwards',
  });

  it('requestTimeout scales the process limit with the number of requests, up to a ceiling', () => {
    expect(requestTimeout(300)).toEqual({ requestTimeoutSeconds: 300, timeoutMs: 315_000 });
    expect(requestTimeout(300, 2)).toEqual({ requestTimeoutSeconds: 300, timeoutMs: 615_000 });
    expect(requestTimeout(300, 50)).toEqual({ requestTimeoutSeconds: 300, timeoutMs: 1_815_000 });
  });

  it('passes --timeout to unc for the preview and for the real run', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const token = text(await executeTool(slowAdmin, { paths: ['/a/x'] }, d)).confirm_token;
    await executeTool(slowAdmin, { paths: ['/a/x'], confirm_token: token }, d);
    expect(calls[0].argv).toEqual(['--format=json', '--timeout=300', '--dry-run', 'file', 'rm', '--', '/a/x']);
    expect(calls[1].argv).toEqual(['--format=json', '--timeout=300', '--yes', 'file', 'rm', '--', '/a/x']);
    expect(calls[1].timeoutMs).toBe(315_000);
  });

  it('keeps confirm_token readable when the preview is larger than the output limit', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin', UGREEN_MCP_MAX_OUTPUT_CHARS: '1000' }, () =>
      reply({ success: true, dry_run: true, blob: 'x'.repeat(5000) }),
    );
    const r = await executeTool(slowAdmin, { paths: ['/a/x'] }, d);
    const body = text(r);
    expect(body.truncated).toBe(true);
    expect(body.confirm_token).toMatch(/^[0-9a-f]{12}$/);
    expect(body.status).toBe('confirmation_required');
    expect(body.next_step).toContain('confirm_token');
  });

  it('keeps next_step readable when the result is larger than the output limit', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin', UGREEN_MCP_MAX_OUTPUT_CHARS: '1000' }, () =>
      reply({ success: true, blob: 'x'.repeat(5000) }),
    );
    const t = text(await executeTool(slowAdmin, { paths: ['/a/x'] }, d)).confirm_token;
    const done = text(await executeTool(slowAdmin, { paths: ['/a/x'], confirm_token: t }, d));
    expect(done.truncated).toBe(true);
    expect(done.next_step).toBe('verify afterwards');
  });

  it('nas_status keeps the policy readable when the health report is huge', async () => {
    const d = deps({ UGREEN_MCP_MAX_OUTPUT_CHARS: '1000' }, () => reply({ success: true, authenticated: true, blob: 'x'.repeat(5000) }));
    const r = await executeTool(coreTools[0], { doctor: true }, d);
    const body = text(r);
    expect(body.truncated).toBe(true);
    expect(body.partial).toContain('"policy":{"access":"read"');
  });
});

describe('second review: pipeline', () => {
  const rawTool = defineTool({
    name: 'nas_t_raw',
    toolset: 'file',
    title: 'r',
    description: 'd',
    input: { path: z.string(), name: z.string().optional() },
    minRisk: 'read',
    maxRisk: 'read',
    risk: () => 'read',
    build: (a, ctx) => ({ argv: cmd(['file', 'cat'], [opt('length', ctx.maxOutputChars)], [a.path, ...(a.name ? [a.name] : [])]), raw: true }),
  });

  it('does not return a flooded raw result as success', async () => {
    const d = deps({}, () => ({ exitCode: null, stdout: Buffer.from('partial'), stderr: '', timedOut: false, overflow: true }));
    const r = await executeTool(rawTool, { path: '/a' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/too much output/i);
  });

  it('tells build how much output fits', async () => {
    const d = deps({ UGREEN_MCP_MAX_OUTPUT_CHARS: '5000' }, () => ({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false }));
    await executeTool(rawTool, { path: '/a' }, d);
    expect(calls[0].argv).toContain('--length=5000');
  });

  it('refuses a NUL character in any argument with a readable error, without running unc', async () => {
    const d = deps();
    const r = await executeTool(rawTool, { path: '/a', name: 'bad\0name' }, d);
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/NUL/);
    expect(text(r).error).not.toMatch(/Internal error/);
    expect(calls).toHaveLength(0);
  });

  it('nas_status passes on the real reason when the login check itself failed', async () => {
    const d = deps({}, () => ({ exitCode: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true }));
    const body = text(await executeTool(coreTools[0], {}, d));
    expect(body.hint).toMatch(/did not finish in time/i);
    expect(body.hint).not.toContain('unc auth login');
  });

  it('uses the hint the server was started with when unc is missing', async () => {
    const d = { ...deps(), runner: null, missingUncHint: 'UGREEN_MCP_UNC_BIN points to /x/unc, which is not an executable file.' };
    expect(text(await executeTool(rawTool, { path: '/a' }, d)).hint).toContain('/x/unc');
    expect(text(await executeTool(coreTools[0], {}, d)).hint).toContain('/x/unc');
  });

  it('marks a tool as destructive only when it can never be read-only', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const server = buildServer(d);
    await server.connect(serverT);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientT);
    const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.nas_storage_info.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.nas_storage_info.inputSchema.properties).not.toHaveProperty('confirm_token');
    expect(byName.nas_storage_smart.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.nas_storage_smart.inputSchema.properties).toHaveProperty('confirm_token');
    await client.close();
  });
});
