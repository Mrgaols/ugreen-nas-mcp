#!/usr/bin/env node
// Read-only smoke test against a real NAS, through the real MCP protocol.
//
// It calls the read tools, and the *preview* step of two admin tools. It never sends a confirm_token and
// never calls a write tool, so it cannot change anything on the NAS. Tool results are not printed: only
// the name of each check and whether it passed.
//
// Usage: npm run build && npm run live-check     (needs a working `unc` login or UNC_NAS_URL/UNC_NAS_TOKEN)
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

const client = new Client({ name: 'live-check', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    // Settings from the calling shell would change which tools exist, so only the NAS credentials pass through.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('UGREEN_MCP_'))),
      UGREEN_MCP_ACCESS: 'admin',
    },
    stderr: 'ignore',
  }),
);

const results = [];
const allText = [];

/** Calls a tool and returns { isError, text, body }. */
async function callTool(name, args = {}) {
  const started = Date.now();
  let res;
  try {
    res = await client.callTool({ name, arguments: args }, undefined, { timeout: 200_000 });
  } catch (err) {
    return { isError: true, text: String(err), body: { error: String(err) }, ms: Date.now() - started };
  }
  const text = res.content?.[0]?.text ?? '';
  allText.push(text);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // truncated or non-JSON output: keep the text only
  }
  return { isError: res.isError === true, text, body, ms: Date.now() - started };
}

function record(label, status, ms, detail = '') {
  results.push({ label, status });
  const time = ms === undefined ? '' : ` ${String(ms).padStart(6)} ms`;
  console.log(`${status.padEnd(11)} ${label.padEnd(46)}${time}${detail ? '  ' + detail : ''}`);
}

/** Runs one check. `pass` receives the call result and returns true, or a string explaining the failure. */
async function check(label, name, args, pass = (r) => !r.isError) {
  const r = await callTool(name, args);
  const unavailable = r.isError && /not available on this NAS/i.test(r.text);
  if (unavailable) {
    record(label, 'UNAVAILABLE', r.ms, 'this NAS does not provide it');
    return r;
  }
  const verdict = pass(r);
  if (verdict === true) {
    record(label, 'PASS', r.ms);
  } else {
    const why = typeof verdict === 'string' ? verdict : (r.body?.error ?? r.text).toString().slice(0, 200);
    record(label, 'FAIL', r.ms, why + (r.body?.hint && VERBOSE ? ` | hint: ${r.body.hint}` : ''));
  }
  return r;
}

const skip = (label, why) => record(label, 'SKIP', undefined, why);

// --- connection ------------------------------------------------------------------------------
const tools = (await client.listTools()).tools;
record(`tools listed at admin level: ${tools.length}`, tools.length === 45 ? 'PASS' : 'FAIL');

const status = await check('nas_status', 'nas_status', {}, (r) => r.body?.auth?.authenticated === true || 'not authenticated');
if (status.body?.auth?.authenticated !== true) {
  console.log('\nNot logged in, so the remaining checks cannot run.');
  await client.close();
  process.exit(1);
}

// --- file --------------------------------------------------------------------------------------
await check('nas_file_roots', 'nas_file_roots', {});
const home = await check('nas_file_list (personal folder)', 'nas_file_list', { limit: 100 });
const homePath = home.body?.items?.[0]?.path;
const entries = home.body?.items?.[0]?.entries ?? [];

if (homePath) {
  await check('nas_file_stat', 'nas_file_stat', { paths: [homePath] }, (r) => r.body?.items?.[0]?.success === true);
  await check('nas_file_usage quota', 'nas_file_usage', { kind: 'quota', paths: [homePath] });
  await check('nas_file_find (folders, depth 1)', 'nas_file_find', { roots: [homePath], kind: 'dir', max_depth: 1, limit: 5 });
  await check('nas_file_stat (missing path is an error)', 'nas_file_stat', { paths: [`${homePath}/__nas_mcp_live_check_missing__`] }, (r) =>
    r.isError && r.body?.result?.items?.[0]?.success === false ? true : 'expected a per-item failure',
  );
} else {
  skip('nas_file_stat / usage / find', 'personal folder path not returned');
}

const isSmallFile = (e) => e?.type && e.type !== 'FILE_TYPE_DIR' && Number(e.size) > 0 && Number(e.size) < 20_000_000;
let file = entries.find(isSmallFile);
if (!file && homePath) {
  // Nothing suitable at the top level: look a few levels down for one small file.
  const found = await callTool('nas_file_find', { roots: [homePath], kind: 'file', max_depth: 6, limit: 50, timeout_seconds: 90 });
  file = (found.body?.entries ?? []).find(isSmallFile);
}
if (file?.path) {
  await check('nas_file_read (first 64 bytes)', 'nas_file_read', { path: file.path, length: 64 }, (r) =>
    !r.isError && typeof r.body?.content === 'string' && r.body.bytes > 0 ? true : 'no content returned',
  );
  await check('nas_file_checksum md5', 'nas_file_checksum', { algorithm: 'md5', paths: [file.path] });
  await check('nas_file_tags tags_of_paths', 'nas_file_tags', { query: 'tags_of_paths', paths: [file.path] });
} else {
  skip('nas_file_read / checksum', 'no small regular file in the personal folder');
}
await check('nas_file_tags list_tags', 'nas_file_tags', { query: 'list_tags' });
await check('nas_file_list (volume root is refused)', 'nas_file_list', { path: '/volume1' }, (r) =>
  r.isError ? true : 'expected an access error for a volume root',
);

// --- search ------------------------------------------------------------------------------------
if (homePath) {
  const search = await check('nas_search_files', 'nas_search_files', { query: 'a', paths: [homePath], limit: 5, max_results: 5, timeout_seconds: 60 });
  const taskId = search.body?.data?.task_id;
  if (taskId && search.body?.data?.task_removed !== true) {
    await check('nas_search_results remove', 'nas_search_results', { action: 'remove', task_id: taskId });
  }
}

// --- docker ------------------------------------------------------------------------------------
const containers = await check('nas_docker_containers', 'nas_docker_containers', {});
await check('nas_docker_images', 'nas_docker_images', {});
const projects = await check('nas_docker_projects', 'nas_docker_projects', {});
await check('nas_docker_check port', 'nas_docker_check', { kind: 'port', port: 65000 });
await check('nas_docker_app_usage', 'nas_docker_app_usage', {});
const containerId = containers.body?.data?.result?.[0]?.container_id;
if (containerId) await check('nas_docker_logs container', 'nas_docker_logs', { target: 'container', id: containerId });
else skip('nas_docker_logs container', 'no containers');
const projectName = projects.body?.data?.projects?.[0]?.project_name;
if (projectName) await check('nas_docker_logs project', 'nas_docker_logs', { target: 'project', id: projectName });
else skip('nas_docker_logs project', 'no Compose projects');

// --- download, app, storage --------------------------------------------------------------------
await check('nas_download_list', 'nas_download_list', {});
const apps = await check('nas_app_list installed (compact)', 'nas_app_list', { filter: 'installed' }, (r) =>
  !r.isError && r.text.length < 60000 && Array.isArray(r.body?.data?.apps) ? true : `unexpected shape or size (${r.text.length} chars)`,
);
const appId = apps.body?.data?.apps?.[0]?.app_id;
if (appId) {
  await check('nas_app_get detail', 'nas_app_get', { app_ids: [appId] });
  await check('nas_app_get status', 'nas_app_get', { view: 'status', app_ids: [appId] });
}
await check('nas_app_list keyword', 'nas_app_list', { keyword: 'docker' });
for (const kind of ['disks', 'pools', 'volumes']) await check(`nas_storage_info ${kind}`, 'nas_storage_info', { kind });

// --- control panel, network, task manager ------------------------------------------------------
await check('nas_users', 'nas_users', {});
await check('nas_users groups', 'nas_users', { kind: 'groups' });
for (const kind of ['identity', 'update_status', 'fan', 'power', 'ups']) await check(`nas_system_info ${kind}`, 'nas_system_info', { kind });
await check('nas_network_info interfaces', 'nas_network_info', {});
await check('nas_network_info general', 'nas_network_info', { kind: 'general' });
await check('nas_performance overview', 'nas_performance', {});
await check('nas_performance processes', 'nas_performance', { kind: 'processes', sort: 'cpu', top: 3 });
await check('nas_performance services', 'nas_performance', { kind: 'services', sort: 'mem', top: 3 });

// --- admin previews: nothing is executed -------------------------------------------------------
if (homePath) {
  await check('preview: delete of a missing path gives no token', 'nas_file_delete', { paths: [`${homePath}/__nas_mcp_live_check_missing__`] }, (r) =>
    r.isError && !r.text.includes('confirm_token') ? true : 'a failed preview must not return a confirm_token',
  );
}
await check('preview: SMART data needs confirmation', 'nas_storage_smart', {}, (r) =>
  r.body?.status === 'confirmation_required' && /^[0-9a-f]{12}$/.test(r.body?.confirm_token ?? '') ? true : 'expected a preview with a confirm_token',
);
await check('a made-up confirm_token is rejected', 'nas_storage_smart', { confirm_token: '000000000000' }, (r) =>
  r.isError ? true : 'a forged token must not execute',
);

// --- secrets -----------------------------------------------------------------------------------
const leaked = allText.some((t) => /ugpoa_v1\.[A-Za-z0-9]/.test(t));
record('no access token in any tool result', leaked ? 'FAIL' : 'PASS');

await client.close();

const tally = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${tally('PASS')} passed, ${tally('FAIL')} failed, ${tally('UNAVAILABLE')} unavailable on this NAS, ${tally('SKIP')} skipped`);
process.exit(tally('FAIL') > 0 ? 1 : 0);
