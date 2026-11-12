# ugreen-nas-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个通用 MCP server，让任意 MCP 客户端通过 stdio 管理用户自己的绿联 NAS，底层调用绿联官方 `unc` CLI。

**Architecture:** 单个 Node 进程。每个工具是一条声明（`ToolSpec`：schema、风险级别、如何拼 `unc` 参数），`server.ts` 用同一条流水线处理全部工具：校验 → 权限闸门 → 路径检查 → 两段式确认 → `execFile` 调 `unc` → 结果整形。

**Tech Stack:** TypeScript（ESM，Node ≥ 20）、`@modelcontextprotocol/sdk` 1.32、`zod` 4、`vitest` 5。

**Spec:** `docs/superpowers/specs/2026-11-13-ugreen-nas-mcp-design.md`

## Global Constraints

- Node ≥ 20，ESM（`"type": "module"`，`module`/`moduleResolution` 为 `NodeNext`，源码内相对导入带 `.js` 后缀）。
- 运行时依赖只有 `@modelcontextprotocol/sdk` 与 `zod`。
- 版本：`@modelcontextprotocol/sdk ^1.32.2`、`zod ^4.6.7`、`typescript ^7.0.2`、`vitest ^5.1.0`、`@types/node ^22`。若 TS 7 或 zod 4 与 SDK 类型不兼容，退到 `typescript ^5.9` / `zod ^3.25`，并在提交信息里写明。
- 只做 stdio。stdout 只能出现 JSON-RPC；所有日志写 stderr，只记工具名、风险、退出码，不记参数值。
- 调 `unc` 一律 `execFile`，不经 shell。server 前置全局参数 `--format=json`（仅 `nas_file_read` 用 `--format=raw`）、预演时加 `--dry-run`、确认执行时加 `--yes`。
- 用户提供的值只以两种形式进入参数列表：`--` 之后的位置参数，或 `--flag=value`。唯一例外是 `file du` 的 `-d N`（`unc` 只接受分开写）。
- server 不读令牌、不用 `--token`、不读 `~/.unc/auth.json`。所有返回文本都过 `ugpoa_v1.` 令牌脱敏。
- 工具名以 `nas_` 开头。工具描述与 `instructions` 用英文，自行撰写，不照搬绿联 Skill 原文。
- 固定数值：默认访问级别 `read`；输出上限 60000 字符（下限 1000）；确认码 12 位十六进制、有效期 300 秒；流式超时默认 120 秒、上限 1800 秒；一元命令进程超时 60 秒；流式命令进程超时 = 流式超时 + 15 秒。
- 工具总数 46。注册数量：`read` 25；`write` 33（有本机目录 35）；`admin` 44（有本机目录 46）。
- 自动化测试不接触真实 NAS。真机验证只调只读工具和 `admin` 预演，不做真实写入。
- MIT；LICENSE 版权人写 `ugreen-nas-mcp contributors`。
- 只做本地提交，不推送。提交信息以 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>` 结尾。

## Review Focus

规格里隐含、但最容易在真实使用中出问题的五类输入。每一条都已在所属任务里加了测试。

1. **以 `-` 开头、含空格、中文或通配符的值**（如路径 `/volume1/照片/a b.jpg`、容器 ID `-rf`）应原样到达 `unc`，不被当成参数解析。→ Task 4（执行器）、Task 10（`nas_docker_logs`）、Task 13（端到端）。
2. **`unc` 的 stdout 不是 JSON 或为空**（崩溃、被杀、只在 stderr 输出 `Error:`）应返回 `isError` 并带上 stderr 文本，不抛异常、不挂起。→ Task 4、Task 5。
3. **`unc` 卡住不返回**应在超时后被杀掉，结果标明超时并给出建议。→ Task 4、Task 5。
4. **`unc` 没装或不可执行**时 server 仍应正常启动，每个工具（含 `nas_status`）返回带安装指引的错误。→ Task 6、Task 13。
5. **环境变量带空白、为空串、结尾多逗号、含未知名称**应被裁剪或忽略空项；非法值启动即报错并点名出错的值。→ Task 2。

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  .gitignore  LICENSE  README.md  README.en.md
.github/workflows/ci.yml
src/
  index.ts          入口：读配置、定位 unc、启动 stdio
  policy.ts         Risk/Toolset 类型、级别比较、NAS 路径规范化与白名单、本机路径解析
  config.ts         环境变量 → Config
  confirm.ts        确认码
  output.ts         脱敏、截断、错误提示、CallToolResult 构造
  server.ts         enabledTools / executeTool / buildServer / INSTRUCTIONS
  unc/locate.ts     找 unc
  unc/runner.ts     execFile 封装
  tools/types.ts    ToolSpec、Deps、cmd/opt/csv/streamTimeout、ToolInputError
  tools/index.ts    ALL_TOOLS
  tools/core.ts file.ts search.ts download.ts docker.ts app.ts storage.ts ctl.ts network.ts taskmgr.ts
test/
  fixtures/fake-unc.mjs
  policy.test.ts config.test.ts confirm.test.ts runner.test.ts output.test.ts server.test.ts e2e.test.ts
  tools/helpers.ts  tools/<产品>.test.ts
scripts/live-check.mjs
```

---

### Task 1: 脚手架与 policy

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/policy.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const RISKS = ['read', 'write', 'admin'] as const;
  export type Risk = (typeof RISKS)[number];
  export const TOOLSETS = ['file','search','docker','download','app','storage','ctl','network','taskmgr'] as const;
  export type Toolset = (typeof TOOLSETS)[number];
  export class PolicyError extends Error { constructor(message: string, readonly hint: string) }
  export function riskAllows(level: Risk, needed: Risk): boolean;
  export function normalizeNasPath(p: string): string;                                  // throws PolicyError
  export function assertNasPathAllowed(p: string, allowed: readonly string[]): string;  // 返回规范化路径
  export function resolveLocalPath(p: string, localDir: string, mode: 'existing-file' | 'target'): Promise<string>;
  ```

- [ ] **Step 1: 写脚手架文件**

`package.json`：`name` `ugreen-nas-mcp`、`version` `0.1.0`、`type` `module`、`license` `MIT`、`bin` `{ "ugreen-nas-mcp": "dist/index.js" }`、`files` `["dist","README.md","README.en.md","LICENSE"]`、`engines.node` `>=20`；scripts：`build` = `tsc -p tsconfig.json`、`typecheck` = `tsc -p tsconfig.json --noEmit`、`test` = `vitest run`、`live-check` = `node scripts/live-check.mjs`、`prepublishOnly` = `npm run build && npm test`；依赖见 Global Constraints。
`tsconfig.json`：`target` `ES2022`、`module`/`moduleResolution` `NodeNext`、`rootDir` `src`、`outDir` `dist`、`strict` `true`、`skipLibCheck` `true`、`include` `["src"]`。
`vitest.config.ts`：`test.include` = `['test/**/*.test.ts']`、`testTimeout` 20000。
`.gitignore`：`node_modules/`、`dist/`、`*.tgz`、`.DS_Store`。

Run: `npm install`
Expected: 无报错，生成 `package-lock.json`。

- [ ] **Step 2: 写失败的测试 `test/policy.test.ts`**

```ts
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
  it.each(['volume1/docs', '', './a', '-rf', '/volume1/../etc', '/a/..', '/a\0b'])(
    'rejects %j', (p) => expect(() => normalizeNasPath(p)).toThrowError(PolicyError));
});

describe('assertNasPathAllowed', () => {
  const allowed = ['/volume1/docs', '/home/von'];
  it('accepts a prefix and its descendants', () => {
    expect(assertNasPathAllowed('/volume1/docs', allowed)).toBe('/volume1/docs');
    expect(assertNasPathAllowed('/volume1/docs/a/b.txt', allowed)).toBe('/volume1/docs/a/b.txt');
    expect(assertNasPathAllowed('/home/von/', allowed)).toBe('/home/von');
  });
  it.each(['/volume1/docs-private/x', '/volume1', '/volume1/doc', '/home/vonx', '/'])(
    'rejects %s', (p) => expect(() => assertNasPathAllowed(p, allowed)).toThrowError(PolicyError));
  it('empty allowlist is unrestricted but still validates shape', () => {
    expect(assertNasPathAllowed('/anything', [])).toBe('/anything');
    expect(() => assertNasPathAllowed('relative', [])).toThrowError(PolicyError);
  });
  it('names UGREEN_MCP_ALLOWED_PATHS in the hint', () => {
    try { assertNasPathAllowed('/etc', allowed); } catch (e) { expect((e as PolicyError).hint).toContain('UGREEN_MCP_ALLOWED_PATHS'); }
  });
});

describe('resolveLocalPath', () => {
  let root: string, dir: string, outside: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'nasmcp-')));
    dir = path.join(root, 'share'); outside = path.join(root, 'outside');
    await mkdir(path.join(dir, 'sub'), { recursive: true }); await mkdir(outside);
    await writeFile(path.join(dir, 'a.txt'), 'a'); await writeFile(path.join(outside, 'secret.txt'), 's');
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
    ['../outside/secret.txt', 'existing-file'], ['link.txt', 'existing-file'], ['missing.txt', 'existing-file'],
    ['sub', 'existing-file'], ['linkdir/new.bin', 'target'], ['nodir/new.bin', 'target'], ['../x.bin', 'target'],
  ] as const)('rejects %s (%s)', async (p, mode) => {
    await expect(resolveLocalPath(p, dir, mode)).rejects.toThrowError(PolicyError);
  });
  it('rejects an absolute path outside the directory', async () => {
    await expect(resolveLocalPath(path.join(outside, 'secret.txt'), dir, 'existing-file')).rejects.toThrowError(PolicyError);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run test/policy.test.ts`
Expected: FAIL，找不到 `../src/policy.js`。

- [ ] **Step 4: 实现 `src/policy.ts`**

- `normalizeNasPath`：必须以 `/` 开头；拒绝 NUL 和值为 `..` 的段；合并连续 `/`、去掉结尾 `/`（根路径保持 `/`）。`.` 段不处理。
- `assertNasPathAllowed`：先规范化；白名单为空直接返回；否则须等于某前缀或以「前缀 + `/`」开头。
- `resolveLocalPath`：`realpath(localDir)` 作为根。`existing-file`：`realpath` 目标，必须是普通文件且在根内。`target`：`realpath` 父目录，必须存在且在根内，返回「父目录真实路径 + 文件名」。「在根内」= 等于根或以「根 + `path.sep`」开头。
- 所有 `PolicyError` 的 `hint` 说明这是 server 的策略限制，并点名对应环境变量（`UGREEN_MCP_ALLOWED_PATHS` 或 `UGREEN_MCP_LOCAL_DIR`）。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run test/policy.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/policy.ts test/policy.test.ts
git commit -m "feat: scaffold project and add policy primitives"
```

---

### Task 2: 配置

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Risk`, `Toolset`, `TOOLSETS`, `RISKS`, `normalizeNasPath`（Task 1）
- Produces:
  ```ts
  export interface Config {
    access: Risk;
    toolsets: ReadonlySet<Toolset>;
    allowedPaths: readonly string[];  // 已规范化；空数组 = 不限
    localDir: string | null;          // 绝对路径
    uncBin: string | null;            // 显式指定的 unc 路径
    maxOutputChars: number;
  }
  export class ConfigError extends Error {}
  export function loadConfig(env: NodeJS.ProcessEnv): Config;
  ```

- [ ] **Step 1: 写失败的测试 `test/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.access).toBe('read');
    expect([...c.toolsets].sort()).toEqual(['app','ctl','docker','download','file','network','search','storage','taskmgr']);
    expect(c.allowedPaths).toEqual([]);
    expect(c.localDir).toBeNull();
    expect(c.uncBin).toBeNull();
    expect(c.maxOutputChars).toBe(60000);
  });
  it('trims whitespace, ignores case and drops empty list items', () => {
    const c = loadConfig({
      UGREEN_MCP_ACCESS: ' Admin ', UGREEN_MCP_TOOLSETS: ' file , Docker ,',
      UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs/, /home/von,', UGREEN_MCP_LOCAL_DIR: ' /tmp/nas ',
      UGREEN_MCP_UNC_BIN: ' /opt/unc ', UGREEN_MCP_MAX_OUTPUT_CHARS: ' 1000 ',
    });
    expect(c.access).toBe('admin');
    expect([...c.toolsets]).toEqual(['file', 'docker']);
    expect(c.allowedPaths).toEqual(['/volume1/docs', '/home/von']);
    expect(c.localDir).toBe('/tmp/nas');
    expect(c.uncBin).toBe('/opt/unc');
    expect(c.maxOutputChars).toBe(1000);
  });
  it('treats empty and whitespace-only values as unset', () => {
    const c = loadConfig({ UGREEN_MCP_ACCESS: '', UGREEN_MCP_TOOLSETS: '  ', UGREEN_MCP_ALLOWED_PATHS: ' , ',
      UGREEN_MCP_LOCAL_DIR: '', UGREEN_MCP_UNC_BIN: ' ', UGREEN_MCP_MAX_OUTPUT_CHARS: '' });
    expect(c.access).toBe('read'); expect(c.toolsets.size).toBe(9); expect(c.allowedPaths).toEqual([]);
    expect(c.localDir).toBeNull(); expect(c.uncBin).toBeNull(); expect(c.maxOutputChars).toBe(60000);
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
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL，找不到 `../src/config.js`。

- [ ] **Step 3: 实现 `loadConfig`**

每条错误信息包含变量名、出错的值和合法取值。`UGREEN_MCP_LOCAL_DIR` 只校验是绝对路径，目录是否存在由 `index.ts` 在启动时检查。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: parse configuration from environment"
```

---

### Task 3: 确认码

**Files:**
- Create: `src/confirm.ts`
- Test: `test/confirm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function canonicalJson(value: unknown): string;   // 对象键按字典序，数组保持顺序，undefined 值的键省略
  export type ConsumeResult = 'ok' | 'unknown' | 'expired' | 'mismatch';
  export class ConfirmStore {
    constructor(opts?: { ttlMs?: number; now?: () => number });   // 默认 ttlMs 300_000
    issue(tool: string, args: Record<string, unknown>): { token: string; expiresInSeconds: number };
    consume(token: string, tool: string, args: Record<string, unknown>): ConsumeResult;
  }
  ```

- [ ] **Step 1: 写失败的测试 `test/confirm.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { ConfirmStore, canonicalJson } from '../src/confirm.js';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(canonicalJson({ a: { d: [2, 1] }, b: 1 }));
  });
  it('is sensitive to array order', () => {
    expect(canonicalJson({ p: ['/a', '/b'] })).not.toBe(canonicalJson({ p: ['/b', '/a'] }));
  });
});

describe('ConfirmStore', () => {
  const args = { paths: ['/a/x'], permanent: false };
  it('issues a 12-hex token valid for 300 seconds', () => {
    const { token, expiresInSeconds } = new ConfirmStore().issue('nas_file_delete', args);
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    expect(expiresInSeconds).toBe(300);
  });
  it('accepts the same tool and args once, regardless of key order', () => {
    const s = new ConfirmStore();
    const { token } = s.issue('nas_file_delete', args);
    expect(s.consume(token, 'nas_file_delete', { permanent: false, paths: ['/a/x'] })).toBe('ok');
    expect(s.consume(token, 'nas_file_delete', args)).toBe('unknown');
  });
  it('rejects changed args or a different tool and burns the token', () => {
    const s = new ConfirmStore();
    const a = s.issue('nas_file_delete', args).token;
    expect(s.consume(a, 'nas_file_delete', { ...args, permanent: true })).toBe('mismatch');
    expect(s.consume(a, 'nas_file_delete', args)).toBe('unknown');
    const b = s.issue('nas_file_delete', args).token;
    expect(s.consume(b, 'nas_file_move', args)).toBe('mismatch');
  });
  it('expires', () => {
    let t = 1_000_000;
    const s = new ConfirmStore({ now: () => t });
    const { token } = s.issue('x', args);
    t += 300_001;
    expect(s.consume(token, 'x', args)).toBe('expired');
  });
  it('rejects an unknown token', () => {
    expect(new ConfirmStore().consume('deadbeef0000', 'x', {})).toBe('unknown');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/confirm.test.ts`
Expected: FAIL，找不到 `../src/confirm.js`。

- [ ] **Step 3: 实现**

令牌用 `crypto.randomBytes(6).toString('hex')`。内存里只存 `sha256(tool + '\n' + canonicalJson(args))` 与到期时间，不存参数本身。`consume` 无论结果如何都删除该令牌；`issue` 时顺手清理已过期的条目。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/confirm.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/confirm.ts test/confirm.test.ts
git commit -m "feat: add single-use confirmation tokens bound to arguments"
```

---

### Task 4: unc 定位与执行器

**Files:**
- Create: `src/unc/locate.ts`, `src/unc/runner.ts`, `test/fixtures/fake-unc.mjs`
- Test: `test/runner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/unc/runner.ts
  export interface UncResult {
    exitCode: number | null;   // 被杀或未启动时为 null
    stdout: Buffer;
    stderr: string;
    timedOut: boolean;
    spawnError?: string;       // 如 'ENOENT'
  }
  export type UncRunner = (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<UncResult>;
  export function createRunner(uncBin: string, env?: NodeJS.ProcessEnv): UncRunner;   // 永不 reject
  // src/unc/locate.ts
  export function locateUnc(explicit: string | null, env?: NodeJS.ProcessEnv): Promise<string | null>;
  ```

- [ ] **Step 1: 写假的 `unc`：`test/fixtures/fake-unc.mjs`**

文件首行 `#!/usr/bin/env node`，并 `chmod +x`。行为由环境变量 `FAKE_UNC_MODE` 决定：

| 模式 | 行为 |
|---|---|
| 未设或 `echo` | 读完 stdin，stdout 输出 `{"success":true,"argv":[…process.argv.slice(2)],"stdin":"…"}`，退出码 0 |
| `fail` | stdout 输出 `{"success":false,"error":"NotFound (HTTP 404) /x: no such file"}`，stderr 输出 `Error: 1/1 个目标失败`，退出码 1 |
| `stderr-only` | stdout 为空，stderr 输出 `Error: 尚未登录，请先运行 unc auth login，或设置 UNC_NAS_TOKEN + UNC_NAS_URL`，退出码 1 |
| `garbage` | stdout 输出 `not json at all`，退出码 0 |
| `hang` | 60 秒后才退出 |
| `big` | stdout 输出 `{"success":true,"data":"<500 万个 x>"}` |
| `raw` | stdout 原样输出字节 `ff fe 00 68 69`，退出码 0 |

- [ ] **Step 2: 写失败的测试 `test/runner.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../src/unc/runner.js';
import { locateUnc } from '../src/unc/locate.js';

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
    const r = await createRunner('/nonexistent/unc')(['x']);
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
    const bin = path.join(root, 'bin'); const home = path.join(root, 'home');
    await mkdir(bin); await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.local', 'bin', 'unc'), '#!/bin/sh\n'); await chmod(path.join(home, '.local', 'bin', 'unc'), 0o755);
    expect(await locateUnc(null, { PATH: bin, HOME: home })).toBe(path.join(home, '.local', 'bin', 'unc'));
    await writeFile(path.join(bin, 'unc'), '#!/bin/sh\n'); await chmod(path.join(bin, 'unc'), 0o755);
    expect(await locateUnc(null, { PATH: bin, HOME: home })).toBe(path.join(bin, 'unc'));
    expect(await locateUnc(null, { PATH: path.join(root, 'empty'), HOME: path.join(root, 'nohome') })).toBeNull();
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 4: 实现**

- `createRunner`：用 `child_process.spawn(uncBin, argv, { env, stdio: ['pipe','pipe','pipe'], shell: false })`。stdout 收成 `Buffer`，不设大小上限。总是写入 stdin 并关闭（无内容时直接关闭）。超时用 `setTimeout` 加 `child.kill('SIGKILL')`，默认 60000 毫秒。监听 `error` 事件把 `err.code` 放进 `spawnError`。忽略 stdin 的 `EPIPE`。
- `locateUnc`：检查「存在且可执行」（`fs.access` 加 `X_OK`）。Windows 下文件名为 `unc.exe`，PATH 分隔符用 `path.delimiter`，家目录取 `env.HOME ?? env.USERPROFILE`。

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/unc test/fixtures/fake-unc.mjs test/runner.test.ts
git commit -m "feat: add unc locator and shell-free runner"
```

---

### Task 5: 结果整形

**Files:**
- Create: `src/output.ts`
- Test: `test/output.test.ts`

**Interfaces:**
- Consumes: `UncResult`（Task 4）
- Produces:
  ```ts
  import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
  export type Envelope = Record<string, unknown>;
  export const INSTALL_HINT: string;
  export function redact(text: string): string;
  export function parseEnvelope(r: UncResult): Envelope | null;          // stdout 是 JSON 对象才返回
  export function isSuccess(r: UncResult, env: Envelope | null): boolean;
  export function hintFor(r: UncResult, env: Envelope | null): string | undefined;
  export interface Failure { error: string; hint?: string; result?: Envelope; error_detail?: unknown; compatibility_hint?: unknown; warnings?: unknown; [key: string]: unknown }
  export function failureFromUnc(r: UncResult, env: Envelope | null): Failure;
  export function toText(payload: unknown, maxChars: number): string;    // 紧凑 JSON → 脱敏 → 截断
  export function ok(payload: unknown, maxChars: number): CallToolResult;
  export function fail(failure: Failure, maxChars: number): CallToolResult;   // isError: true
  ```

- [ ] **Step 1: 写失败的测试 `test/output.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { redact, parseEnvelope, isSuccess, hintFor, failureFromUnc, toText, ok, fail, INSTALL_HINT } from '../src/output.js';
import type { UncResult } from '../src/unc/runner.js';

const res = (over: Partial<UncResult> & { out?: string }): UncResult => ({
  exitCode: 0, stdout: Buffer.from(over.out ?? ''), stderr: '', timedOut: false, ...over,
});

describe('redact', () => {
  it('masks open-platform tokens wherever they appear', () => {
    expect(redact('a ugpoa_v1.AbC-123_x.yz/+= b')).toBe('a ugpoa_v1.*** b');
    expect(redact('{"token":"ugpoa_v1.abc"}')).toBe('{"token":"ugpoa_v1.***"}');
  });
});

describe('parseEnvelope / isSuccess', () => {
  it('parses a JSON object', () => {
    const r = res({ out: '{"success":true,"data":{}}' });
    expect(isSuccess(r, parseEnvelope(r))).toBe(true);
  });
  it.each(['', 'not json', '[1,2]', '"str"'])('returns null for %j', (out) => {
    const r = res({ out });
    expect(parseEnvelope(r)).toBeNull();
    expect(isSuccess(r, null)).toBe(false);
  });
  it('is false on success:false, non-zero exit, timeout or spawn error', () => {
    const env = { success: true };
    expect(isSuccess(res({}), { success: false })).toBe(false);
    expect(isSuccess(res({ exitCode: 1 }), env)).toBe(false);
    expect(isSuccess(res({ exitCode: null, timedOut: true }), env)).toBe(false);
    expect(isSuccess(res({ exitCode: null, spawnError: 'ENOENT' }), env)).toBe(false);
  });
});

describe('hintFor', () => {
  const h = (over: Partial<UncResult> & { out?: string }) => { const r = res(over); return hintFor(r, parseEnvelope(r)) ?? ''; };
  it('missing binary', () => expect(h({ exitCode: null, spawnError: 'ENOENT' })).toBe(INSTALL_HINT));
  it('timeout', () => expect(h({ exitCode: null, timedOut: true })).toMatch(/timeout_seconds|narrow/i));
  it('not logged in', () => expect(h({ exitCode: 1, stderr: 'Error: 尚未登录，请先运行 unc auth login' })).toContain('UNC_NAS_TOKEN'));
  it('401', () => expect(h({ exitCode: 1, out: '{"success":false,"error":"Unauthenticated (HTTP 401) x: invalid bearer token"}' })).toMatch(/token.*(expired|invalid)/i));
  it('403 for a path outside shared folders', () => expect(h({ exitCode: 1,
    out: '{"success":false,"items":[{"success":false,"error":"PermissionDenied (HTTP 403) /x: Err - code: 1301, message: Access not allowed"}]}' })).toContain('nas_file_roots'));
  it('403 for a token without the permission node', () => expect(h({ exitCode: 1,
    out: '{"success":false,"error":"PermissionDenied (HTTP 403) /docker.Docker/ContainerList: 访问令牌未授权该方法"}' })).toMatch(/new access token/i));
  it('429', () => expect(h({ exitCode: 1, out: '{"success":false,"error":"ResourceExhausted (HTTP 429) rate_limited"}' })).toMatch(/wait/i));
  it('compatibility fields win over text matching', () => expect(h({ exitCode: 1,
    out: '{"success":false,"error":"Unimplemented (HTTP 403)","error_detail":{"subtype":"compat_method_not_provided"}}' })).toMatch(/not available on this NAS/i));
  it('compatibility fields inside items are found', () => expect(h({ exitCode: 1,
    out: '{"success":false,"items":[{"success":false,"error":"x","compatibility_hint":{"signal":"grpc_unavailable"}}]}' })).toMatch(/not available on this NAS/i));
  it('no hint for an ordinary failure', () => expect(hintFor(res({ exitCode: 1, out: '{"success":false,"error":"NotFound (HTTP 404)"}' }),
    { success: false, error: 'NotFound (HTTP 404)' })).toBeUndefined());
});

describe('failureFromUnc', () => {
  it('uses stderr when stdout is not JSON', () => {
    const f = failureFromUnc(res({ exitCode: 1, out: '', stderr: 'Error: unknown flag: --nope\n' }), null);
    expect(f.error).toBe('Error: unknown flag: --nope');
    expect(f.result).toBeUndefined();
  });
  it('says so when unc printed nothing useful', () => {
    expect(failureFromUnc(res({ exitCode: 0, out: 'not json' }), null).error).toMatch(/unexpected output/i);
  });
  it('keeps per-item results and structured fields', () => {
    const env = { success: false, items: [{ path: '/a', success: true }, { success: false, error: 'NotFound' }], warnings: ['w'] };
    const f = failureFromUnc(res({ exitCode: 1, out: JSON.stringify(env), stderr: 'Error: 1/2 个目标失败' }), env);
    expect(f.result).toEqual(env);
    expect(f.warnings).toEqual(['w']);
    expect(f.error).toContain('1/2');
  });
  it('uses the top-level error when present', () => {
    const env = { success: false, error: 'NotFound (HTTP 404) x', error_detail: { a: 1 } };
    const f = failureFromUnc(res({ exitCode: 1, out: JSON.stringify(env) }), env);
    expect(f.error).toBe('NotFound (HTTP 404) x');
    expect(f.error_detail).toEqual({ a: 1 });
  });
});

describe('toText / ok / fail', () => {
  it('serialises compactly and redacts', () => {
    expect(toText({ a: 'ugpoa_v1.secret', b: [1] }, 1000)).toBe('{"a":"ugpoa_v1.***","b":[1]}');
  });
  it('truncates with a notice stating both sizes', () => {
    const t = toText({ data: 'x'.repeat(5000) }, 1000);
    expect(t.startsWith('{"data":"xxx')).toBe(true);
    expect(t).toMatch(/\[truncated: showing 1000 of \d+ characters\./);
    expect(t.length).toBeLessThan(1300);
  });
  it('builds tool results', () => {
    expect(ok({ a: 1 }, 1000)).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    const f = fail({ error: 'boom', hint: 'do x' }, 1000);
    expect(f.isError).toBe(true);
    expect(JSON.parse((f.content[0] as { text: string }).text)).toEqual({ error: 'boom', hint: 'do x' });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/output.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `src/output.ts`**

- `redact` 的模式：`/ugpoa_v1\.[A-Za-z0-9._~+\/=-]+/g` → `ugpoa_v1.***`。
- `hintFor` 的判定顺序（先命中先返回）：`spawnError` → `INSTALL_HINT`；`timedOut`；信封顶层或任一 `items[]` 项含 `error_detail` 或 `compatibility_hint`；然后把顶层 `error`、各项 `error` 与 stderr 拼成一段文本做匹配：`尚未登录` → 登录提示；`HTTP 401` 或 `Unauthenticated`；`HTTP 403` 且含 `code: 1301` → 路径提示；`HTTP 403` 或 `PermissionDenied` → 令牌权限提示；`HTTP 429` → 限流提示。
- 提示文案（英文）要点：
  - `INSTALL_HINT`：未找到绿联官方 `unc` CLI。请用户安装并确保在 PATH 中，或设置 `UGREEN_MCP_UNC_BIN`。这不是 agent 能修的问题。
  - 超时：缩小范围（更深的目录、去掉递归、调低 limit），或调大 `timeout_seconds`。结果不完整。
  - 不兼容：`This feature is not available on this NAS. Do not retry.` 可调 `nas_status` 并带 `doctor: true` 查看细节。
  - 未登录：请用户在 MCP 配置里设置 `UNC_NAS_URL` 和 `UNC_NAS_TOKEN`，或在终端运行 `unc auth login`。
  - 401：`The access token is invalid or expired.` 请用户重新登录或更换令牌，不要重试。
  - 403（1301）：路径不在可访问的共享文件夹内，卷根不可访问，先调 `nas_file_roots`。
  - 403（其他）：令牌缺少该方法的权限节点。请用户在 NAS 上 `create a new access token` 并授予该权限，不要换工具绕过。
  - 429：`Rate limited. Wait a few seconds`，然后用相同参数重试。
- `failureFromUnc` 的 `error`：顶层 `error` 字符串优先；否则 stderr 去首尾空白；两者都没有时写 `unc produced unexpected output (exit code N)` 并附 stdout 前 300 字符。信封含 `items` 时把整个信封放进 `result`。
- 截断提示格式：`\n[truncated: showing {maxChars} of {total} characters. Narrow the request (deeper path, filters, lower limit) to see the rest.]`

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/output.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/output.ts test/output.test.ts
git commit -m "feat: shape unc results with redaction, truncation and hints"
```

---

### Task 6: 工具类型、调用流水线、`nas_status` 与入口

**Files:**
- Create: `src/tools/types.ts`, `src/tools/core.ts`, `src/tools/index.ts`, `src/server.ts`, `src/index.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部导出
- Produces:
  ```ts
  // src/tools/types.ts
  export interface Deps { config: Config; runner: UncRunner | null; confirm: ConfirmStore; version: string }
  export interface UncCall { argv: string[]; stdin?: string; timeoutMs?: number; raw?: boolean }
  export interface BuildContext { localPath?: string }
  export class ToolInputError extends Error {}
  export interface ToolSpec {
    name: string;
    toolset: Toolset | 'core';
    title: string;
    description: string;
    input: z.ZodRawShape;
    minRisk: Risk;                                   // 决定是否注册
    maxRisk: Risk;                                   // 为 admin 时自动加 confirm_token 参数与 destructiveHint
    risk(args: any): Risk;
    nasPaths?(args: any): string[];                  // 需要过白名单的 NAS 路径
    unscoped?(args: any): boolean;                   // 为 true 且设了白名单时拒绝
    localPath?(args: any): { path: string; mode: 'existing-file' | 'target' };   // 存在即表示需要本机目录
    build(args: any, ctx: BuildContext): UncCall;
    render?(stdout: Buffer, args: any): unknown;     // raw 调用的结果
    project?(env: Envelope): unknown;                // 精简输出
    followUp?(args: any): string | undefined;        // 成功后的 next_step
    handler?(args: any, deps: Deps): Promise<CallToolResult>;   // 完全自定义（仅 nas_status）
  }
  export function defineTool<S extends z.ZodRawShape>(spec: /* 同 ToolSpec，回调的 args 类型为 z.infer<z.ZodObject<S>> */): ToolSpec;
  export function cmd(words: string[], flags?: Array<string | false | null | undefined>, positionals?: string[]): string[];
  export function opt(name: string, value: string | number | boolean | undefined): string | undefined;
  export function csv(name: string, values: ReadonlyArray<string | number> | undefined): string | undefined;
  export function streamTimeout(seconds: number): { flag: string; timeoutMs: number };
  // src/tools/index.ts
  export const ALL_TOOLS: ToolSpec[];
  // src/server.ts
  export const INSTRUCTIONS: string;
  export function enabledTools(config: Config, all?: ToolSpec[]): ToolSpec[];
  export function executeTool(spec: ToolSpec, rawArgs: Record<string, unknown>, deps: Deps): Promise<CallToolResult>;
  export function buildServer(deps: Deps, all?: ToolSpec[]): McpServer;
  ```
- 辅助函数的确切行为：
  - `cmd(['file','stat'], [undefined,'--x'], ['/a'])` → `['file','stat','--x','--','/a']`；没有位置参数时不加 `--`。
  - `opt('limit', 5)` → `'--limit=5'`；`opt('recursive', true)` → `'--recursive'`；`false` 或 `undefined` → `undefined`。
  - `csv('status', ['a','b'])` → `'--status=a,b'`；空数组或 `undefined` → `undefined`。
  - `streamTimeout(120)` → `{ flag: '--stream-timeout=120', timeoutMs: 135000 }`。

- [ ] **Step 1: 写失败的测试 `test/server.test.ts`**

测试用一个记录调用的假执行器和四个合成工具，不依赖真实工具。

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { ConfirmStore } from '../src/confirm.js';
import { defineTool, cmd, opt, csv, streamTimeout, ToolInputError, type Deps, type ToolSpec } from '../src/tools/types.js';
import { enabledTools, executeTool, buildServer, INSTRUCTIONS } from '../src/server.js';
import { coreTools } from '../src/tools/core.js';
import type { UncResult } from '../src/unc/runner.js';

const calls: Array<{ argv: string[]; stdin?: string; timeoutMs?: number }> = [];
const reply = (env: unknown, exitCode = 0): UncResult => ({ exitCode, stdout: Buffer.from(JSON.stringify(env)), stderr: '', timedOut: false });
function deps(env: NodeJS.ProcessEnv = {}, respond: (argv: string[]) => UncResult = () => reply({ success: true, data: { ok: 1 } })): Deps {
  calls.length = 0;
  return { config: loadConfig(env), confirm: new ConfirmStore(), version: '0.0.0',
    runner: async (argv, opts) => { calls.push({ argv, ...opts }); return respond(argv); } };
}
const text = (r: { content: unknown[] }) => JSON.parse((r.content[0] as { text: string }).text);

const readTool = defineTool({ name: 'nas_t_read', toolset: 'file', title: 'r', description: 'd', input: { path: z.string().optional() },
  minRisk: 'read', maxRisk: 'read', risk: () => 'read', nasPaths: (a) => (a.path ? [a.path] : []), unscoped: (a) => !a.path,
  build: (a) => ({ argv: cmd(['file', 'ls'], [], a.path ? [a.path] : []) }), followUp: () => 'then do y' });
const writeTool = defineTool({ name: 'nas_t_write', toolset: 'docker', title: 'w', description: 'd', input: { replace: z.boolean().default(false) },
  minRisk: 'write', maxRisk: 'admin', risk: (a) => (a.replace ? 'admin' : 'write'),
  build: (a) => ({ argv: cmd(['docker', 'pull'], [opt('replace', a.replace)], ['x']), stdin: 'yaml' }) });
const adminTool = defineTool({ name: 'nas_t_admin', toolset: 'file', title: 'a', description: 'd', input: { paths: z.array(z.string()) },
  minRisk: 'admin', maxRisk: 'admin', risk: () => 'admin', nasPaths: (a) => a.paths,
  build: (a) => { if (a.paths.length === 0) throw new ToolInputError('paths must not be empty'); return { argv: cmd(['file', 'rm'], [], a.paths) }; } });
const xferTool = defineTool({ name: 'nas_t_xfer', toolset: 'file', title: 'x', description: 'd', input: { local_path: z.string() },
  minRisk: 'write', maxRisk: 'write', risk: () => 'write', localPath: (a) => ({ path: a.local_path, mode: 'target' }),
  build: (_a, ctx) => ({ argv: cmd(['file', 'download'], [], ['/r', ctx.localPath!]) }) });
const all: ToolSpec[] = [...coreTools, readTool, writeTool, adminTool, xferTool];

describe('argv helpers', () => {
  it('build argument lists', () => {
    expect(cmd(['file', 'stat'], [undefined, false, '--x'], ['/a'])).toEqual(['file', 'stat', '--x', '--', '/a']);
    expect(cmd(['docker', 'ps'], [])).toEqual(['docker', 'ps']);
    expect([opt('limit', 5), opt('recursive', true), opt('recursive', false), opt('name', undefined), opt('name', '-x')])
      .toEqual(['--limit=5', '--recursive', undefined, undefined, '--name=-x']);
    expect([csv('status', ['a', 'b']), csv('status', []), csv('status', undefined)]).toEqual(['--status=a,b', undefined, undefined]);
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
    expect(r.isError).toBe(true); expect(calls).toHaveLength(0);
    expect(text(r).error).toContain('admin'); expect(text(r).hint).toContain('UGREEN_MCP_ACCESS');
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
  });
  it('executes with --yes once, then rejects reuse and changed arguments', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const token = text(await executeTool(adminTool, { paths: ['/a/x'] }, d)).confirm_token;
    const done = await executeTool(adminTool, { paths: ['/a/x'], confirm_token: token }, d);
    expect(done.isError).toBeFalsy();
    expect(calls[1].argv).toEqual(['--format=json', '--yes', 'file', 'rm', '--', '/a/x']);
    expect((await executeTool(adminTool, { paths: ['/a/x'], confirm_token: token }, d)).isError).toBe(true);
    const t2 = text(await executeTool(adminTool, { paths: ['/a/x'] }, d)).confirm_token;
    const drift = await executeTool(adminTool, { paths: ['/a/y'], confirm_token: t2 }, d);
    expect(drift.isError).toBe(true);
    expect(calls.filter((c) => c.argv.includes('--yes'))).toHaveLength(1);
  });
  it('issues no token when the preview fails', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' }, () => reply({ success: false, error: 'NotFound (HTTP 404)' }, 1));
    const r = await executeTool(adminTool, { paths: ['/a/x'] }, d);
    expect(r.isError).toBe(true); expect(text(r).confirm_token).toBeUndefined();
  });
  it('passes stdin through and marks param-dependent admin risk', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    await executeTool(writeTool, { replace: false }, d);
    expect(calls[0]).toMatchObject({ argv: ['--format=json', 'docker', 'pull', '--', 'x'], stdin: 'yaml' });
    await executeTool(writeTool, { replace: true }, d);
    expect(calls[1].argv).toEqual(['--format=json', '--dry-run', 'docker', 'pull', '--replace', '--', 'x']);
  });
  it('enforces the path allowlist and the scope requirement', async () => {
    const d = deps({ UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs' });
    expect((await executeTool(readTool, { path: '/volume1/docs-private' }, d)).isError).toBe(true);
    const unscoped = await executeTool(readTool, {}, d);
    expect(unscoped.isError).toBe(true); expect(text(unscoped).hint).toContain('UGREEN_MCP_ALLOWED_PATHS');
    expect(calls).toHaveLength(0);
    expect((await executeTool(readTool, { path: '/volume1/docs/a' }, d)).isError).toBeFalsy();
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
    expect((await executeTool(xferTool, { local_path: '../escape.bin' }, d)).isError).toBe(true);
  });
  it('reports tool input errors and never throws', async () => {
    const d = deps({ UGREEN_MCP_ACCESS: 'admin' });
    const r = await executeTool(adminTool, { paths: [] }, d);
    expect(r.isError).toBe(true); expect(text(r).error).toBe('paths must not be empty');
  });
  it('returns the install hint when unc is missing', async () => {
    const d = { ...deps(), runner: null };
    const r = await executeTool(readTool, { path: '/a' }, d);
    expect(r.isError).toBe(true); expect(text(r).hint).toMatch(/UGREEN_MCP_UNC_BIN/);
  });
  it('surfaces unc failures with a hint', async () => {
    const d = deps({}, () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: 'Error: 尚未登录，请先运行 unc auth login', timedOut: false }));
    const r = await executeTool(readTool, { path: '/a' }, d);
    expect(r.isError).toBe(true); expect(text(r).hint).toContain('UNC_NAS_TOKEN');
  });
});

describe('nas_status', () => {
  const status = coreTools[0];
  it('reports auth, unc version and policy without running doctor by default', async () => {
    const d = deps({ UGREEN_MCP_ALLOWED_PATHS: '/volume1/docs' }, (argv) =>
      argv.includes('auth') ? reply({ success: true, authenticated: true, username: 'u' }) : reply({ success: true, version: '0.1.61' }));
    const body = text(await executeTool(status, {}, d));
    expect(calls.map((c) => c.argv)).toEqual([['--format=json', 'auth', 'status', '--check'], ['--format=json', 'version']]);
    expect(body.auth.authenticated).toBe(true);
    expect(body.unc.version).toBe('0.1.61');
    expect(body.policy).toEqual({ access: 'read', toolsets: expect.any(Array), allowed_paths: ['/volume1/docs'],
      local_transfer: 'disabled', max_output_chars: 60000 });
  });
  it('runs doctor on request and hints when not authenticated', async () => {
    const d = deps({}, (argv) => argv.includes('auth') ? reply({ success: true, authenticated: false }) : reply({ success: true }));
    const body = text(await executeTool(status, { doctor: true }, d));
    expect(calls.map((c) => c.argv[1])).toEqual(['auth', 'version', 'doctor']);
    expect(body.hint).toContain('UNC_NAS_TOKEN');
  });
  it('reports a missing unc with the policy still included', async () => {
    const r = await executeTool(status, {}, { ...deps(), runner: null });
    expect(r.isError).toBe(true);
    expect(text(r).hint).toMatch(/UGREEN_MCP_UNC_BIN/);
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
    expect(Object.keys(byName.nas_t_read.inputSchema.properties ?? {})).not.toContain('confirm_token');
    const r = await client.callTool({ name: 'nas_t_read', arguments: { path: '/a' } });
    expect(r.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 `src/tools/types.ts`、`src/tools/core.ts`、`src/tools/index.ts`**

`coreTools` 只有 `nas_status`：参数 `{ doctor: z.boolean().default(false) }`，`toolset: 'core'`，`minRisk`/`maxRisk` 为 `read`，用 `handler`。依次调用 `auth status --check`、`version`，`doctor: true` 时再调 `doctor`（超时 120000 毫秒）。返回 `{ auth, unc, doctor?, policy, hint? }`；各子项取解析后的信封，解析失败时取 `failureFromUnc` 的结果。`policy.allowed_paths` 在不限时为字符串 `'unrestricted'`；`policy.local_transfer` 为 `'enabled'` 或 `'disabled'`。`auth.authenticated !== true` 时附登录提示。`runner` 为 `null` 时返回 `fail({ error: 'unc CLI not found', hint: INSTALL_HINT, policy })`。
`ALL_TOOLS` 此时等于 `coreTools`，后续任务逐个追加。

- [ ] **Step 4: 实现 `src/server.ts`**

`enabledTools`：保留 `toolset === 'core'` 或在 `config.toolsets` 内的工具；且 `riskAllows(config.access, minRisk)`；且没有 `localPath` 或 `config.localDir` 非空。保持 `all` 的顺序。

`executeTool` 的顺序（任何异常都转成 `fail`，不向外抛）：

1. 有 `handler` 则直接交给它。
2. `runner` 为 `null` → `fail({ error: 'unc CLI not found', hint: INSTALL_HINT })`。
3. 取出 `confirm_token`，其余为 `args`。
4. `risk(args)` 超过 `config.access` → `fail`，`error` 为 `This call needs access level "<risk>" but the server is configured with "<access>".`，`hint` 提到 `UGREEN_MCP_ACCESS`。
5. 白名单非空且 `unscoped(args)` 为真 → `fail`，`hint` 提到 `UGREEN_MCP_ALLOWED_PATHS`。对 `nasPaths(args)` 每一项调 `assertNasPathAllowed`。
6. 有 `localPath` → `resolveLocalPath`，结果放进 `BuildContext`。
7. `build(args, ctx)`。全局参数前缀：`--format=raw` 或 `--format=json`。
8. 风险为 `admin`：
   - 无确认码：加 `--dry-run` 执行。失败 → `fail(failureFromUnc)`。成功 → `ok({ status: 'confirmation_required', preview: <信封>, confirm_token, expires_in_seconds, next_step: 'Nothing has been changed yet. Show this preview to the user. To execute, call this tool again with identical arguments plus confirm_token.' })`。
   - 有确认码：`confirm.consume`。非 `'ok'` → `fail`，`error` 说明原因（unknown / expired / mismatch），`hint` 为 `Call the tool again without confirm_token to get a fresh preview.`。通过 → 加 `--yes` 执行。
9. 其他风险：直接执行。
10. 成功：结果依次取 `render(stdout, args)`、`project(env)`、信封本身；是对象且 `followUp(args)` 有值时加 `next_step`；`ok(...)`。失败：`fail(failureFromUnc)`。
11. 每次调用向 stderr 写一行：`[ugreen-nas-mcp] <工具名> risk=<风险> mode=<run|preview|confirmed> exit=<退出码>`。

`buildServer`：`new McpServer({ name: 'ugreen-nas-mcp', version: deps.version }, { instructions: INSTRUCTIONS })`；对 `enabledTools` 逐个 `registerTool`。`inputSchema` 为 `spec.input`，`maxRisk === 'admin'` 时追加 `confirm_token: z.string().optional().describe('Token returned by the preview call. Omit it to get a preview.')`。`annotations`：`readOnlyHint: maxRisk === 'read'`、`destructiveHint: maxRisk === 'admin'`、`openWorldHint: true`。

`INSTRUCTIONS` 的确切内容：

```
This server manages the user's own UGREEN NAS through the official unc CLI.
- If a call fails with an authentication or connection error, call nas_status.
- File paths start at a shared folder or the personal folder. Volume roots such as /volume1 are not accessible. If you do not know a path, call nas_file_roots (shared folders) or nas_file_list with no path (personal folder).
- Never invent IDs, paths, task IDs or app IDs. Take them from tool results.
- 64-bit integers (sizes, timestamps, task IDs) are JSON strings. Convert them before comparing.
- Some operations are asynchronous: success means "accepted". Verify with the matching list tool before reporting completion.
- After a failed write, check the current state before trying again. Do not retry automatically.
- Tools that delete, overwrite, stop services or change accounts first run as a preview and return a confirm_token. Show the preview to the user, then call the same tool with identical arguments plus confirm_token.
- If server policy rejects a call (access level, allowed paths, local directory), tell the user which environment variable to change. Do not look for another tool to get around it.
```

- [ ] **Step 5: 实现 `src/index.ts`**

首行 `#!/usr/bin/env node`。流程：`loadConfig(process.env)`，`ConfigError` 时向 stderr 输出信息并以退出码 2 结束；`config.localDir` 非空但不是已存在的目录时同样处理；`locateUnc`，找不到时向 stderr 输出 `INSTALL_HINT` 但继续启动（`runner` 为 `null`）；版本号从 `package.json` 读取；`buildServer(...).connect(new StdioServerTransport())`。

- [ ] **Step 6: 运行，确认通过**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: 测试 PASS，类型检查无错误。

- [ ] **Step 7: 提交**

```bash
git add src/tools src/server.ts src/index.ts test/server.test.ts
git commit -m "feat: add tool pipeline, server wiring and nas_status"
```

---

### Task 7: file 只读工具（8 个）

**Files:**
- Create: `src/tools/file.ts`, `test/tools/helpers.ts`
- Modify: `src/tools/index.ts`（追加 `fileTools`）
- Test: `test/tools/file-read.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `cmd`, `opt`, `csv`, `streamTimeout`, `ToolInputError`（Task 6）
- Produces: `export const fileTools: ToolSpec[]`；测试辅助：
  ```ts
  // test/tools/helpers.ts
  export function tool(name: string): ToolSpec;                                   // 从 ALL_TOOLS 取，取不到则抛错
  export function parse(name: string, args: Record<string, unknown>): any;        // z.object(spec.input).parse，应用默认值
  export function call(name: string, args: Record<string, unknown>, ctx?: BuildContext): UncCall;   // parse 后 build
  export function riskOf(name: string, args: Record<string, unknown>): Risk;
  export type Row = [name: string, args: Record<string, unknown>, argv: string[], risk: Risk];
  export function checkRows(rows: Row[]): void;   // 对每行生成一个 it：断言 call(...).argv 与 riskOf(...)
  ```

**参数（zod）：**

| 工具 | 参数 |
|---|---|
| `nas_file_roots` | 无 |
| `nas_file_list` | `path?` string；`recursive` boolean=false；`limit` int 0–10000 = 200；`timeout_seconds` int 1–1800 = 120 |
| `nas_file_read` | `path` string；`offset` int ≥0 = 0；`length` int 1–1048576 = 65536 |
| `nas_file_stat` | `paths` string[] 1–50 |
| `nas_file_find` | `roots` string[] 1–20；`name?` string；`kind?` enum `file dir image video audio archive doc font app`；`min_size?`/`max_size?` 匹配 `^\d+[KMG]?$`；`time_field?` enum `birth mtime atime dtime`；`since?`/`until?` int；`max_depth?` int ≥1；`limit` int 0–10000 = 200；`timeout_seconds` 同上 |
| `nas_file_usage` | `kind` enum `du quota`；`paths` string[] 1–20；`depth?` int ≥1；`timeout_seconds` 同上 |
| `nas_file_checksum` | `algorithm` enum `md5 sha256`；`paths` string[] 1–20 |
| `nas_file_tags` | `query` enum `list_tags tags_of_paths files_by_tag`；`paths?` string[]；`tag_ids?` int[]；`scope_path?` string；`recursive` boolean=false；`timeout_seconds` 同上 |

全部 `minRisk`/`maxRisk` 为 `read`。`nasPaths`：各工具的全部路径参数。
组合校验（不满足时 `build` 抛 `ToolInputError`）：`nas_file_find` 的 `since`/`until` 需要 `time_field`；`nas_file_usage` 的 `depth` 只用于 `du`；`nas_file_tags` 的 `tags_of_paths` 需要 `paths`，`files_by_tag` 需要 `tag_ids`，`recursive` 需要 `scope_path`。`unscoped`：`nas_file_list` 无 `path`；`nas_file_tags` 为 `files_by_tag` 且无 `scope_path`。`nas_file_read` 的 `build` 返回 `raw: true`。`nas_file_checksum` 的 `timeoutMs` 为 300000。

**描述要点（英文撰写，每个工具都要覆盖）：**

| 工具 | 必须写明 |
|---|---|
| `nas_file_roots` | 不知道路径时的起点；返回可访问的共享文件夹 |
| `nas_file_list` | 省略 `path` 列个人文件夹；卷根不可访问；结果在 `items[0].entries[]`；`size` 是字符串；递归很慢，应缩小范围 |
| `nas_file_read` | 只读一段；返回 `encoding` 为 `utf8` 或 `base64`；大文件用 `offset` 分段 |
| `nas_file_stat` | 结果在 `items[]`，逐项看 `success`；`mode` 字段不可靠，不要用来判断权限 |
| `nas_file_find` | `kind` 的含义；大小写带单位；`since`/`until` 是 Unix 秒且需 `time_field`；大范围按文件名找优先用 `nas_search_files` |
| `nas_file_usage` | `du` 是占用，`quota` 的单位是 MB、`"0"` 表示未设置 |
| `nas_file_checksum` | 大文件耗时长 |
| `nas_file_tags` | 三种查询各需哪些参数；`tag_ids` 来自 `list_tags` |

- [ ] **Step 1: 写 `test/tools/helpers.ts` 与失败的测试 `test/tools/file-read.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_file_roots', {}, ['file', 'ls-root', '--root=shared', '--limit=500'], 'read'],
  ['nas_file_list', {}, ['file', 'ls', '--limit=200', '--stream-timeout=120'], 'read'],
  ['nas_file_list', { path: '/volume1/照片/a b', recursive: true, limit: 0, timeout_seconds: 300 },
    ['file', 'ls', '--recursive', '--limit=0', '--stream-timeout=300', '--', '/volume1/照片/a b'], 'read'],
  ['nas_file_read', { path: '/home/u/a.txt' }, ['file', 'cat', '--offset=0', '--length=65536', '--', '/home/u/a.txt'], 'read'],
  ['nas_file_read', { path: '/home/u/a.txt', offset: 100, length: 50 }, ['file', 'cat', '--offset=100', '--length=50', '--', '/home/u/a.txt'], 'read'],
  ['nas_file_stat', { paths: ['/a', '/b c'] }, ['file', 'stat', '--', '/a', '/b c'], 'read'],
  ['nas_file_find', { roots: ['/volume1/photo'], name: '*.jpg', kind: 'image', min_size: '10K', max_depth: 3 },
    ['file', 'find', '--name=*.jpg', '--category=image', '--min-size=10K', '--maxdepth=3', '--limit=200', '--stream-timeout=120', '--', '/volume1/photo'], 'read'],
  ['nas_file_find', { roots: ['/a', '/b'], kind: 'dir', time_field: 'mtime', since: 1700000000, until: 1800000000 },
    ['file', 'find', '--type=d', '--time=mtime', '--since=1700000000', '--until=1800000000', '--limit=200', '--stream-timeout=120', '--', '/a', '/b'], 'read'],
  ['nas_file_find', { roots: ['/a'], kind: 'file', max_size: '4M' },
    ['file', 'find', '--type=f', '--max-size=4M', '--limit=200', '--stream-timeout=120', '--', '/a'], 'read'],
  ['nas_file_usage', { kind: 'du', paths: ['/volume1/photo'], depth: 2 }, ['file', 'du', '-d', '2', '--stream-timeout=120', '--', '/volume1/photo'], 'read'],
  ['nas_file_usage', { kind: 'du', paths: ['/a'] }, ['file', 'du', '--stream-timeout=120', '--', '/a'], 'read'],
  ['nas_file_usage', { kind: 'quota', paths: ['/home/u'] }, ['file', 'quota', 'get', '--', '/home/u'], 'read'],
  ['nas_file_checksum', { algorithm: 'sha256', paths: ['/a/b.iso'] }, ['file', 'sha256sum', '--', '/a/b.iso'], 'read'],
  ['nas_file_checksum', { algorithm: 'md5', paths: ['/a/b.iso'] }, ['file', 'md5sum', '--', '/a/b.iso'], 'read'],
  ['nas_file_tags', { query: 'list_tags' }, ['file', 'tag', 'list'], 'read'],
  ['nas_file_tags', { query: 'tags_of_paths', paths: ['/a/b'] }, ['file', 'tag', 'file', 'get', '--', '/a/b'], 'read'],
  ['nas_file_tags', { query: 'files_by_tag', tag_ids: [1, 2], scope_path: '/volume1/photo', recursive: true },
    ['file', 'tag', 'file', 'list', '--path=/volume1/photo', '--recursive', '--stream-timeout=120', '--', '1', '2'], 'read'],
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
  });
  it('declares paths and scope for the allowlist', () => {
    expect(tool('nas_file_list').unscoped!(parse('nas_file_list', {}))).toBe(true);
    expect(tool('nas_file_list').unscoped!(parse('nas_file_list', { path: '/a' }))).toBe(false);
    expect(tool('nas_file_find').nasPaths!(parse('nas_file_find', { roots: ['/a', '/b'] }))).toEqual(['/a', '/b']);
    const t = tool('nas_file_tags');
    expect(t.unscoped!(parse('nas_file_tags', { query: 'files_by_tag', tag_ids: [1] }))).toBe(true);
    expect(t.unscoped!(parse('nas_file_tags', { query: 'list_tags' }))).toBe(false);
    expect(t.nasPaths!(parse('nas_file_tags', { query: 'files_by_tag', tag_ids: [1], scope_path: '/s' }))).toEqual(['/s']);
  });
  it('reads raw bytes and decodes them', () => {
    const t = tool('nas_file_read'); const args = parse('nas_file_read', { path: '/a.txt', offset: 5 });
    expect(call('nas_file_read', { path: '/a.txt' }).raw).toBe(true);
    expect(t.render!(Buffer.from('héllo'), args)).toEqual({ path: '/a.txt', offset: 5, bytes: 6, encoding: 'utf8', content: 'héllo' });
    expect(t.render!(Buffer.from([0xff, 0xfe, 0x00]), args)).toEqual({ path: '/a.txt', offset: 5, bytes: 3, encoding: 'base64', content: '//4A' });
  });
  it('gives checksums a longer timeout', () => expect(call('nas_file_checksum', { algorithm: 'md5', paths: ['/a'] }).timeoutMs).toBe(300000));
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/file-read.test.ts`
Expected: FAIL，`nas_file_roots` 不在 `ALL_TOOLS` 中。

- [ ] **Step 3: 实现这 8 个工具并追加到 `ALL_TOOLS`**

UTF-8 判定用 `new TextDecoder('utf-8', { fatal: true })`。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/tools/file-read.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/file.ts src/tools/index.ts test/tools
git commit -m "feat: add read-only file tools"
```

---

### Task 8: file 写入与管理工具（11 个）

**Files:**
- Modify: `src/tools/file.ts`
- Test: `test/tools/file-write.test.ts`

**Interfaces:**
- Consumes: 同 Task 7；`BuildContext.localPath`

**参数（zod）：**

| 工具 | 参数 | 风险 |
|---|---|---|
| `nas_file_mkdir` | `paths` string[] 1–20；`parents` boolean=false | write |
| `nas_file_create` | `path` string；`content` string=''，UTF-8 字节数 ≤ 100000；`base64` boolean=false | write |
| `nas_file_copy` | `source` string；`destination_dir` string；`on_conflict` enum `rename skip replace` = `rename` | write；`replace` 为 admin |
| `nas_file_restore` | `recycle_paths` string[] 1–20 | write |
| `nas_file_tag_edit` | `action` enum `create_tag tag_files delete_tags untag_files`；`name?` string；`color?` 匹配 `^#[0-9A-Fa-f]{6}$`；`tag_id?` int ≥1；`tag_ids?` int[]；`paths?` string[] | 前两种 write，后两种 admin |
| `nas_file_upload` | `local_path` string；`remote_path` string；`on_conflict` 同上 = `rename`；`verify` boolean=false；`timeout_seconds` int 1–1800 = 600 | write；`replace` 为 admin |
| `nas_file_download` | `remote_path` string；`local_path?` string；`if_exists` enum `fail overwrite resume` = `fail`；`timeout_seconds` 同上 = 600 | write |
| `nas_file_move` | `source` string；`destination` string；`on_conflict?` enum `rename skip replace` | admin |
| `nas_file_delete` | `paths` string[] 1–50；`permanent` boolean=false | admin |
| `nas_file_write` | `path` string；`content` string，UTF-8 字节数 ≤ 1048576；`mode` enum `overwrite append` = `overwrite` | admin |
| `nas_file_quota_set` | `path` string；`quota_mb` int ≥0 | admin |

`maxRisk`：`nas_file_copy`、`nas_file_tag_edit`、`nas_file_upload` 为 `admin`（`minRisk` 为 `write`）；其余等于表中风险。
`localPath`：上传为 `{ path: local_path, mode: 'existing-file' }`；下载为 `{ path: local_path ?? <remote_path 的最后一段>, mode: 'target' }`。
`nasPaths`：各工具的全部 NAS 路径参数；`nas_file_move` 的 `destination` 不含 `/` 时不计入。
组合校验：`nas_file_tag_edit` 的 `create_tag` 需要 `name`，`tag_files`/`untag_files` 需要 `tag_id` 与 `paths`，`delete_tags` 需要 `tag_ids`。
`create_tag` 未给 `color` 时用 `#4C8BF5`。`nas_file_write` 的内容走 `stdin`。

**描述要点：**

| 工具 | 必须写明 |
|---|---|
| `nas_file_create` | 目标已存在则失败，不覆盖；改已有文件用 `nas_file_write`；大文件用 `nas_file_upload` |
| `nas_file_copy` | `destination_dir` 必须是已存在的目录，不能含新文件名；复制并改名分两步 |
| `nas_file_restore` | 传回收站内的路径（`nas_file_delete` 结果里的 `receipt.final_path`）；回收站是扁平的 |
| `nas_file_upload` / `nas_file_download` | 本机路径限定在用户配置的目录内；默认同名自动改名，实际文件名看 `data.stat.path`；上传无断点续传；下载可 `resume`；与 `nas_download_create`（让 NAS 去下载 URL）不同 |
| `nas_file_move` | `destination` 要么是已存在的目录，要么是不含 `/` 的新文件名（同目录改名）；跨目录并改名分两步 |
| `nas_file_delete` | 默认进回收站并可恢复，记下 `final_path`；`permanent` 不可恢复；不能删共享文件夹根；失败后先查状态再决定 |
| `nas_file_write` | 只能写已存在的文件；`overwrite` 会丢失原内容 |
| `nas_file_quota_set` | 单位 MB；`0` 取消配额；只能对个人或共享文件夹这一级设置；立即生效 |

- [ ] **Step 1: 写失败的测试 `test/tools/file-write.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tool, parse, call, riskOf, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_file_mkdir', { paths: ['/home/u/new dir'], parents: true }, ['file', 'mkdir', '--parents', '--', '/home/u/new dir'], 'write'],
  ['nas_file_create', { path: '/home/u/a.txt', content: '-hello' }, ['file', 'touch', '--exclusive', '--content=-hello', '--', '/home/u/a.txt'], 'write'],
  ['nas_file_create', { path: '/home/u/empty' }, ['file', 'touch', '--exclusive', '--', '/home/u/empty'], 'write'],
  ['nas_file_create', { path: '/home/u/b.bin', content: 'AAEC', base64: true }, ['file', 'touch', '--exclusive', '--content=AAEC', '--base64', '--', '/home/u/b.bin'], 'write'],
  ['nas_file_copy', { source: '/a/x.txt', destination_dir: '/b' }, ['file', 'cp', '--on-conflict=rename', '--', '/a/x.txt', '/b'], 'write'],
  ['nas_file_copy', { source: '/a/x.txt', destination_dir: '/b', on_conflict: 'replace' }, ['file', 'cp', '--on-conflict=replace', '--', '/a/x.txt', '/b'], 'admin'],
  ['nas_file_restore', { recycle_paths: ['/home/u/#recycle/a.txt'] }, ['file', 'recover-recycle', '--', '/home/u/#recycle/a.txt'], 'write'],
  ['nas_file_tag_edit', { action: 'create_tag', name: '重要', color: '#FF4D4F' }, ['file', 'tag', 'add', '--color=#FF4D4F', '--', '重要'], 'write'],
  ['nas_file_tag_edit', { action: 'create_tag', name: 'x' }, ['file', 'tag', 'add', '--color=#4C8BF5', '--', 'x'], 'write'],
  ['nas_file_tag_edit', { action: 'tag_files', tag_id: 3, paths: ['/a/b'] }, ['file', 'tag', 'file', 'add', '--', '3', '/a/b'], 'write'],
  ['nas_file_tag_edit', { action: 'delete_tags', tag_ids: [3, 4] }, ['file', 'tag', 'delete', '--', '3', '4'], 'admin'],
  ['nas_file_tag_edit', { action: 'untag_files', tag_id: 3, paths: ['/a/b'] }, ['file', 'tag', 'file', 'delete', '--', '3', '/a/b'], 'admin'],
  ['nas_file_move', { source: '/a/x.txt', destination: '/b' }, ['file', 'mv', '--', '/a/x.txt', '/b'], 'admin'],
  ['nas_file_move', { source: '/a/x.txt', destination: 'y.txt', on_conflict: 'skip' }, ['file', 'mv', '--on-conflict=skip', '--', '/a/x.txt', 'y.txt'], 'admin'],
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
    expect(call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/volume1/docs/' }, ctx).argv)
      .toEqual(['file', 'upload', '--on-conflict=rename', '--stream-timeout=600', '--', '/L/r.pdf', '/volume1/docs/']);
    expect(call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/volume1/docs/', on_conflict: 'replace', verify: true }, ctx).argv)
      .toEqual(['file', 'upload', '--on-conflict=replace', '--verify', '--stream-timeout=600', '--', '/L/r.pdf', '/volume1/docs/']);
    expect(riskOf('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' })).toBe('write');
    expect(riskOf('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/', on_conflict: 'replace' })).toBe('admin');
    expect(call('nas_file_download', { remote_path: '/volume1/docs/r.pdf' }, ctx).argv)
      .toEqual(['file', 'download', '--stream-timeout=600', '--', '/volume1/docs/r.pdf', '/L/r.pdf']);
    expect(call('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'resume' }, ctx).argv).toContain('--continue');
    expect(call('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'overwrite' }, ctx).argv).toContain('--force');
    expect(riskOf('nas_file_download', { remote_path: '/d/r.pdf', if_exists: 'overwrite' })).toBe('write');
    expect(call('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' }, ctx).timeoutMs).toBe(615000);
  });
  it('declares which local path to resolve', () => {
    expect(tool('nas_file_upload').localPath!(parse('nas_file_upload', { local_path: 'r.pdf', remote_path: '/d/' })))
      .toEqual({ path: 'r.pdf', mode: 'existing-file' });
    expect(tool('nas_file_download').localPath!(parse('nas_file_download', { remote_path: '/volume1/docs/报告 v2.pdf' })))
      .toEqual({ path: '报告 v2.pdf', mode: 'target' });
    expect(tool('nas_file_download').localPath!(parse('nas_file_download', { remote_path: '/d/r.pdf', local_path: 'x/y.pdf' })))
      .toEqual({ path: 'x/y.pdf', mode: 'target' });
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
  });
  it('validates combinations and sizes', () => {
    expect(() => call('nas_file_tag_edit', { action: 'create_tag' })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tag_edit', { action: 'tag_files', tag_id: 3 })).toThrowError(ToolInputError);
    expect(() => call('nas_file_tag_edit', { action: 'delete_tags' })).toThrowError(ToolInputError);
    expect(() => parse('nas_file_tag_edit', { action: 'create_tag', name: 'x', color: 'red' })).toThrow();
    expect(() => parse('nas_file_create', { path: '/a', content: '字'.repeat(40000) })).toThrow();
    expect(() => parse('nas_file_delete', { paths: [] })).toThrow();
  });
  it('sets registration bounds', () => {
    for (const n of ['nas_file_copy', 'nas_file_tag_edit', 'nas_file_upload']) {
      expect([tool(n).minRisk, tool(n).maxRisk]).toEqual(['write', 'admin']);
    }
    for (const n of ['nas_file_move', 'nas_file_delete', 'nas_file_write', 'nas_file_quota_set']) expect(tool(n).minRisk).toBe('admin');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/file-write.test.ts`
Expected: FAIL，`nas_file_mkdir` 不在 `ALL_TOOLS` 中。

- [ ] **Step 3: 实现这 11 个工具**

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/tools`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/file.ts test/tools/file-write.test.ts
git commit -m "feat: add file write and admin tools"
```

---

### Task 9: search 与 download 工具（5 个）

**Files:**
- Create: `src/tools/search.ts`, `src/tools/download.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools/search-download.test.ts`

**Interfaces:**
- Produces: `export const searchTools: ToolSpec[]`、`export const downloadTools: ToolSpec[]`

**参数（zod）：**

| 工具 | 参数 | 风险 |
|---|---|---|
| `nas_search_files` | `query?` string；`paths?` string[] 1–10；`recursive` boolean=true；`classes?` enum[] `app archive audio content-doc dir doc help image other video`；`suffix?` string；`min_size?`/`max_size?` 匹配 `^\d+[KMG]?$`；`modified_from?`/`modified_to?` int；`tag_ids?` int[]；`sort_by` enum `name size modified created accessed class dir-first` = `name`；`order?` enum `asc desc`；`limit` int 1–500 = 50；`max_results?` int ≥1；`timeout_seconds` int 1–1800 = 120 | read |
| `nas_search_results` | `action` enum `page cancel remove` = `page`；`task_id` string；`offset` int ≥0 = 0；`limit` int 1–500 = 50；`sort_by` 同上 = `name`；`order?` | read |
| `nas_download_list` | `task_ids?` string[] | read |
| `nas_download_create` | `url` string；`dir?` string | write |
| `nas_download_control` | `action` enum `pause resume retry remove`；`task_ids?` string[]；`all` boolean=false | write；`remove` 或 `all` 为 admin |

组合校验：`nas_download_control` 必须恰好给出非空的 `task_ids` 或 `all: true` 之一。
`nas_search_files`：`nasPaths` 为 `paths`，`unscoped` 为没有 `paths`；`recursive` 只在给了 `paths` 时生效。`nas_download_create`：`nasPaths` 为 `[dir]`（有则计入），`unscoped` 为没有 `dir`。`nas_download_control` 的 `minRisk` 为 `write`、`maxRisk` 为 `admin`。

**描述要点：**

| 工具 | 必须写明 |
|---|---|
| `nas_search_files` | 按文件名搜，不搜内容；条目在 `data.results.ordered_items[]`；有 `data.next_offset` 就用 `nas_search_results` 翻页；`data.task_removed` 不为 true 时用完要 `remove`；尽量给 `paths` |
| `nas_search_results` | 条目在 `data.ordered_items[]`（没有 `results` 一层）；翻页要带相同的 `sort_by`/`order`；没有 `next_offset` 才算取完，不要用 `total_count` 判断；`remove` 只删搜索任务不动文件 |
| `nas_download_list` | `total_bytes` 可能为负；用 `progress_percent`；`saved_path` 完成前为空；不要高频轮询 |
| `nas_download_create` | 让 NAS 去下载一个 URL，不是下载到本机；记下 `task_id`；没有默认下载目录时必须给 `dir` |
| `nas_download_control` | 必须给 `task_ids` 或 `all: true`；`all` 仅在用户明确要求时使用；`resume`/`retry` 成功只表示重新排队；暂停已完成的任务会整体报错但其余任务已暂停；`remove` 保留已下载文件 |

`followUp`：`nas_search_files` → `If data.next_offset is present, page with nas_search_results using the same sort_by and order. If data.task_removed is not true, release the task with action "remove" when done.`；`nas_download_create` → `The download runs in the background. Check progress with nas_download_list, a few seconds apart.`

- [ ] **Step 1: 写失败的测试 `test/tools/search-download.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_search_files', { query: '合同', paths: ['/volume1/docs'], suffix: 'pdf' },
    ['search', 'title', '--path=/volume1/docs', '--recursive', '--suffix=pdf', '--sort-by=name', '--limit=50', '--stream-timeout=120', '--', '合同'], 'read'],
  ['nas_search_files', { paths: ['/a', '/b'], recursive: false, classes: ['video', 'image'], min_size: '1G', modified_from: 1767225600,
      tag_ids: [3], sort_by: 'size', order: 'desc', limit: 20, max_results: 500 },
    ['search', 'title', '--path=/a', '--path=/b', '--class=video,image', '--min-size=1G', '--modified-from=1767225600', '--tag-id=3',
      '--sort-by=size', '--order=desc', '--limit=20', '--max-results=500', '--stream-timeout=120'], 'read'],
  ['nas_search_files', { query: 'x' }, ['search', 'title', '--sort-by=name', '--limit=50', '--stream-timeout=120', '--', 'x'], 'read'],
  ['nas_search_results', { task_id: 'abc', offset: 100, sort_by: 'size', order: 'desc' },
    ['search', 'results', '--offset=100', '--limit=50', '--sort-by=size', '--order=desc', '--', 'abc'], 'read'],
  ['nas_search_results', { action: 'cancel', task_id: 'abc' }, ['search', 'cancel', '--', 'abc'], 'read'],
  ['nas_search_results', { action: 'remove', task_id: 'abc' }, ['search', 'rm', '--', 'abc'], 'read'],
  ['nas_download_list', {}, ['download', 'ls'], 'read'],
  ['nas_download_list', { task_ids: ['10086', '10087'] }, ['download', 'status', '--', '10086', '10087'], 'read'],
  ['nas_download_create', { url: 'magnet:?xt=urn:btih:abc&dn=x', dir: '/volume1/downloads' },
    ['download', 'create', '--dir=/volume1/downloads', '--', 'magnet:?xt=urn:btih:abc&dn=x'], 'write'],
  ['nas_download_create', { url: 'https://example.com/a.iso' }, ['download', 'create', '--', 'https://example.com/a.iso'], 'write'],
  ['nas_download_control', { action: 'pause', task_ids: ['1'] }, ['download', 'pause', '--', '1'], 'write'],
  ['nas_download_control', { action: 'resume', task_ids: ['1', '2'] }, ['download', 'resume', '--', '1', '2'], 'write'],
  ['nas_download_control', { action: 'retry', all: true }, ['download', 'retry', '--all'], 'admin'],
  ['nas_download_control', { action: 'remove', task_ids: ['1'] }, ['download', 'rm', '--', '1'], 'admin'],
];

describe('search and download tools', () => {
  checkRows(rows);

  it('requires exactly one of task_ids and all', () => {
    expect(() => call('nas_download_control', { action: 'pause' })).toThrowError(ToolInputError);
    expect(() => call('nas_download_control', { action: 'pause', task_ids: [] })).toThrowError(ToolInputError);
    expect(() => call('nas_download_control', { action: 'pause', task_ids: ['1'], all: true })).toThrowError(ToolInputError);
  });
  it('declares scope for the allowlist', () => {
    const s = tool('nas_search_files');
    expect(s.unscoped!(parse('nas_search_files', { query: 'x' }))).toBe(true);
    expect(s.nasPaths!(parse('nas_search_files', { paths: ['/a'] }))).toEqual(['/a']);
    const d = tool('nas_download_create');
    expect(d.unscoped!(parse('nas_download_create', { url: 'https://e.com/a' }))).toBe(true);
    expect(d.nasPaths!(parse('nas_download_create', { url: 'https://e.com/a', dir: '/dl' }))).toEqual(['/dl']);
  });
  it('explains follow-up steps', () => {
    expect(tool('nas_search_files').followUp!(parse('nas_search_files', { query: 'x' }))).toContain('nas_search_results');
    expect(tool('nas_download_create').followUp!(parse('nas_download_create', { url: 'https://e.com/a' }))).toContain('nas_download_list');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/search-download.test.ts`
Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现这 5 个工具并追加到 `ALL_TOOLS`**

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/tools`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/search.ts src/tools/download.ts src/tools/index.ts test/tools/search-download.test.ts
git commit -m "feat: add search and download tools"
```

---

### Task 10: docker 工具（11 个）

**Files:**
- Create: `src/tools/docker.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools/docker.test.ts`

**Interfaces:**
- Produces: `export const dockerTools: ToolSpec[]`

**参数（zod）：**

| 工具 | 参数 | 风险 |
|---|---|---|
| `nas_docker_containers` | `name?` string；`status?` enum[] `running stopped`；`type?` enum[] `app general project`；`update_state?` enum[] `available none`；`sort_by?` enum `create-time name status`；`order?` enum `asc desc` | read |
| `nas_docker_images` | `source` enum `local registry` = `local`；`name?` string；`status?` enum[] `in-use unused error`；`sort_by?` enum `name size`；`order?`；`page?`/`page_size?` int ≥1 | read |
| `nas_docker_projects` | `name?`；`status?` enum[] `abnormal creating exited failed operating running updating`；`update_available?` boolean；`kind?` enum `app ordinary`；`sort_by?` enum `create-time name status`；`order?` | read |
| `nas_docker_logs` | `target` enum `container project`；`id` string | read |
| `nas_docker_check` | `kind` enum `port dir gpu`；`port?` int 1–65535；`protocol?` enum `tcp udp`；`dir?` string；`vendor?` enum `nvidia amd intel` | read |
| `nas_docker_app_usage` | `app_ids?` string[] | read |
| `nas_docker_pull` | `image` string，须带标签或摘要，匹配 `^\S+(:[\w.-]+|@sha256:[0-9a-f]{64})$`（允许带仓库端口，如 `registry.local:5000/team/app:1.2`） | write |
| `nas_docker_container_control` | `action` enum `start stop restart`；`container_ids` string[] 1–20 | admin |
| `nas_docker_project_control` | `action` enum `start stop restart delete`；`project` string；`delete_images` boolean=false | admin |
| `nas_docker_project_create` | `name` string；`path` string；`compose_yaml` string 非空；`run` boolean=false；`latest_images` boolean=false | admin |
| `nas_docker_app_rebuild` | `app_id` string；`path?` string；`params?` 数组，每项 `{ key: string, value: string \| string[], kind?: enum plain path }` | admin |

组合校验：`nas_docker_images` 的 `registry` 需要 `name` 且不接受 `status`/`sort_by`/`order`，`local` 不接受 `page`/`page_size`；`nas_docker_check` 的三种 `kind` 分别需要 `port`、`dir`、`vendor`；`delete_images` 只用于 `delete`；参数的 `key` 不得含 `=`。
`nas_docker_project_create` 的 YAML 走 `stdin`。`nas_docker_app_rebuild` 的参数映射：`value` 为数组 → `--param-multi=KEY=V1,V2`；`kind` 为 `path` → `--param-path=KEY=VALUE`；其余 → `--param=KEY=VALUE`。

**描述要点：**

| 工具 | 必须写明 |
|---|---|
| `nas_docker_containers` | 容器 CPU 与内存以此为准；`mem_used` 是字符串；`status` 筛选值与返回的 `status` 字段是两套枚举；`port_mappings` 只有运行中的容器才有；查不到挂载卷、环境变量、重启策略、网络模式 |
| `nas_docker_images` | `registry` 搜的是远端仓库且需要 `name`；不能删除镜像 |
| `nas_docker_projects` | `update_available` 三态；带 `application_id` 的是应用中心管理的项目 |
| `nas_docker_logs` | 固定最近 200 条；项目日志是整个项目合计 200 行；`id` 用完整的 `container_id` 或 `project_name` |
| `nas_docker_check` | 只检查容器占用，`occupied: false` 不等于端口一定可用；`gpu` 必须给 `vendor` |
| `nas_docker_app_usage` | 只统计应用中心的应用，普通容器返回全 0 且不报错 |
| `nas_docker_pull` | 必须带标签；异步，用 `nas_docker_images` 确认 |
| `nas_docker_container_control` | 同步；`stop` 对已停止的容器会报错，不代表故障；属于 Compose 项目的容器优先用项目级操作；若报 401 且提示重新登录无法解决，是 NAS 端问题，改用项目级操作 |
| `nas_docker_project_control` | 四个动作都是异步的；`delete` 不可逆，且对应用中心管理的项目或不存在的项目会静默成功，必须用 `nas_docker_projects` 确认项目已消失 |
| `nas_docker_project_create` | `path` 必须是已存在的目录；不要复用别的项目的目录，否则会静默覆盖它的 compose 文件；不加 `run` 也会创建容器；YAML 必须来自用户 |
| `nas_docker_app_rebuild` | `app_id`、`path`、参数都查不到，只能由用户提供，绝不能猜；`record not found` 表示 `app_id` 错了，不要重试 |

`followUp`：`nas_docker_pull` → 用 `nas_docker_images` 确认；`nas_docker_project_control` → `Accepted, not finished. Poll nas_docker_projects until the status settles. For delete, confirm the project is gone before reporting success.`；`nas_docker_project_create` 与 `nas_docker_app_rebuild` → 用对应列表工具核对。

- [ ] **Step 1: 写失败的测试 `test/tools/docker.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_docker_containers', {}, ['docker', 'ps'], 'read'],
  ['nas_docker_containers', { name: 'nginx', status: ['running'], type: ['app', 'project'], update_state: ['available'], sort_by: 'name', order: 'asc' },
    ['docker', 'ps', '--name=nginx', '--status=running', '--type=app,project', '--update-state=available', '--sort-by=name', '--order=asc'], 'read'],
  ['nas_docker_images', {}, ['docker', 'images'], 'read'],
  ['nas_docker_images', { name: 'ng', status: ['unused'], sort_by: 'size', order: 'desc' },
    ['docker', 'images', '--name=ng', '--status=unused', '--sort-by=size', '--order=desc'], 'read'],
  ['nas_docker_images', { source: 'registry', name: 'redis', page: 1, page_size: 10 }, ['docker', 'search', '--page=1', '--page-size=10', '--', 'redis'], 'read'],
  ['nas_docker_projects', {}, ['docker', 'compose', 'ls'], 'read'],
  ['nas_docker_projects', { name: 'blog', status: ['running', 'exited'], update_available: false, kind: 'ordinary', sort_by: 'status' },
    ['docker', 'compose', 'ls', '--name=blog', '--status=running,exited', '--update-available=false', '--ordinary-only', '--sort-by=status'], 'read'],
  ['nas_docker_projects', { update_available: true, kind: 'app' }, ['docker', 'compose', 'ls', '--update-available=true', '--app-only'], 'read'],
  ['nas_docker_logs', { target: 'container', id: '-rf' }, ['docker', 'logs', '--', '-rf'], 'read'],
  ['nas_docker_logs', { target: 'project', id: 'blog' }, ['docker', 'compose', 'logs', '--', 'blog'], 'read'],
  ['nas_docker_check', { kind: 'port', port: 53, protocol: 'udp' }, ['docker', 'port-check', '--protocol=udp', '--', '53'], 'read'],
  ['nas_docker_check', { kind: 'dir', dir: '/volume1/docker/app' }, ['docker', 'dir-check', '--', '/volume1/docker/app'], 'read'],
  ['nas_docker_check', { kind: 'gpu', vendor: 'nvidia' }, ['docker', 'gpu-check', '--vendor=nvidia'], 'read'],
  ['nas_docker_app_usage', {}, ['docker', 'stats'], 'read'],
  ['nas_docker_app_usage', { app_ids: ['com.ugreen.docker.openlist'] }, ['docker', 'stats', '--', 'com.ugreen.docker.openlist'], 'read'],
  ['nas_docker_pull', { image: 'nginx:latest' }, ['docker', 'pull', '--', 'nginx:latest'], 'write'],
  ['nas_docker_container_control', { action: 'stop', container_ids: ['c0ffee', 'dead'] }, ['docker', 'stop', '--', 'c0ffee', 'dead'], 'admin'],
  ['nas_docker_project_control', { action: 'restart', project: 'blog' }, ['docker', 'compose', 'restart', '--', 'blog'], 'admin'],
  ['nas_docker_project_control', { action: 'delete', project: 'blog', delete_images: true }, ['docker', 'compose', 'delete', '--delete-images', '--', 'blog'], 'admin'],
  ['nas_docker_project_create', { name: 'blog', path: '/volume1/docker/blog', compose_yaml: 'services: {}', run: true, latest_images: true },
    ['docker', 'compose', 'up', '--name=blog', '--path=/volume1/docker/blog', '--run', '--latest-images'], 'admin'],
  ['nas_docker_app_rebuild', { app_id: 'com.ugreen.docker.jellyfin', path: '/volume1/docker/jellyfin', params: [
      { key: 'TZ', value: 'Asia/Shanghai' }, { key: 'MEDIA', value: '/volume1/media', kind: 'path' }, { key: 'DNS', value: ['1.1.1.1', '8.8.8.8'] }] },
    ['docker', 'rebuild', '--path=/volume1/docker/jellyfin', '--param=TZ=Asia/Shanghai', '--param-path=MEDIA=/volume1/media',
      '--param-multi=DNS=1.1.1.1,8.8.8.8', '--', 'com.ugreen.docker.jellyfin'], 'admin'],
  ['nas_docker_app_rebuild', { app_id: 'a.b' }, ['docker', 'rebuild', '--', 'a.b'], 'admin'],
];

describe('docker tools', () => {
  checkRows(rows);

  it('sends compose YAML through stdin, never argv', () => {
    const yaml = 'services:\n  db:\n    environment:\n      PASSWORD: hunter2\n';
    const c = call('nas_docker_project_create', { name: 'x', path: '/p', compose_yaml: yaml });
    expect(c.stdin).toBe(yaml);
    expect(c.argv.join(' ')).not.toContain('hunter2');
  });
  it('validates combinations', () => {
    expect(() => call('nas_docker_images', { source: 'registry' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_images', { source: 'registry', name: 'x', status: ['unused'] })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'port' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'dir' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'gpu' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_project_control', { action: 'stop', project: 'b', delete_images: true })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_app_rebuild', { app_id: 'a', params: [{ key: 'A=B', value: 'x' }] })).toThrowError(ToolInputError);
    expect(() => parse('nas_docker_pull', { image: 'nginx' })).toThrow();
    expect(parse('nas_docker_pull', { image: 'registry.local:5000/team/app:1.2' }).image).toBe('registry.local:5000/team/app:1.2');
    expect(() => parse('nas_docker_project_create', { name: 'x', path: '/p', compose_yaml: '' })).toThrow();
  });
  it('warns that lifecycle operations are asynchronous', () => {
    expect(tool('nas_docker_project_control').followUp!(parse('nas_docker_project_control', { action: 'delete', project: 'b' }))).toContain('nas_docker_projects');
    expect(tool('nas_docker_pull').followUp!(parse('nas_docker_pull', { image: 'nginx:latest' }))).toContain('nas_docker_images');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/docker.test.ts`
Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现这 11 个工具并追加到 `ALL_TOOLS`**

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/tools`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/docker.ts src/tools/index.ts test/tools/docker.test.ts
git commit -m "feat: add docker tools"
```

---

### Task 11: app 与 storage 工具（4 个）

**Files:**
- Create: `src/tools/app.ts`, `src/tools/storage.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools/app-storage.test.ts`

**Interfaces:**
- Produces: `export const appTools: ToolSpec[]`、`export const storageTools: ToolSpec[]`

**参数（zod）：**

| 工具 | 参数 | 风险 |
|---|---|---|
| `nas_app_list` | `keyword?` string 1–20 字符；`filter?` enum `installed not_installed update_available repair_needed` | read |
| `nas_app_get` | `view` enum `detail status` = `detail`；`app_ids` string[] 1–20 | read |
| `nas_app_manage` | `action` enum `install update uninstall start stop`；`app_ids` string[] 1–10；`install_path?` string；`params?` 数组，每项 `{ key: string, value: string \| string[] }`；`no_start` boolean=false；`clean_data` boolean=false；`wait_timeout_minutes` int 1–60 = 30 | admin |
| `nas_storage_info` | `kind` enum `disks pools volumes smart`；`show_serial` boolean=false | read；`smart` 为 admin |

组合校验：`nas_app_list` 带 `keyword` 时 `filter` 只能是 `installed`；`nas_app_get` 的 `detail` 只接受一个应用；`nas_app_manage` 的 `install_path`/`params` 只用于 `install`，`no_start` 只用于 `install`/`update`，`clean_data` 只用于 `uninstall`，参数的 `key` 不得含 `=`；`nas_storage_info` 的 `show_serial` 只用于 `disks`/`smart`。
`nas_storage_info` 的 `minRisk` 为 `read`、`maxRisk` 为 `admin`。`nas_app_manage` 的 `install`/`update`/`uninstall` 带 `--wait-timeout=<N>m`，`timeoutMs` 为 `N × 60000 + 30000`；`start`/`stop` 不带，用默认超时。

`nas_app_list` 的 `project`：把 `data.apps[]` 每项精简为 `{ app_id, name: { 'zh-CN', 'en-US' }（只留存在的键）, install_status, installed_version, available_version, app_type }`，版本取 `brief.installed_version.version` 与 `brief.cloud_version.version`（缺失为 `null`），并加 `data.count`。信封的其他顶层字段保留。

**描述要点：**

| 工具 | 必须写明 |
|---|---|
| `nas_app_list` | 输出是精简版，完整信息用 `nas_app_get`；`keyword` 最多 20 字符，搜不到端口应用与门户应用，这时不带 `keyword` 再筛；带 `keyword` 时只支持 `installed` 筛选 |
| `nas_app_get` | `detail` 一次一个应用，含 `install_parameters`；`status` 的 `run_state` 为空不代表失败，看 `is_installed`/`is_running` |
| `nas_app_manage` | 需要管理员令牌（否则 `Code(1008)`）；`app_ids` 必须来自 `nas_app_list`，先给用户确认；安装要给 `install_path`（卷挂载点，见 `nas_storage_info` 的 `volumes`）；装/更/卸会等到终态，逐项看 `items[]`；超时或断线后不要重新提交，用 `nas_app_get` 的 `status` 复核；`clean_data` 删除应用数据且不可恢复 |
| `nas_storage_info` | `disks` 看健康与温度，`volumes` 看空间，`pools` 看 RAID 与缺盘；容量是字节字符串，`total` 为 `"0"` 表示未挂载；`temperature` 为 0 表示读不到；`UNSUPPORTED` 不等于正常；池状态 `GOOD` 仍要看 `disks[].status`；`smart` 是敏感诊断数据，仅在用户明确要求时使用；`show_serial` 同理；不能创建、扩容或删除存储池与卷 |

`followUp`：`nas_app_manage` → `Report each entry of items[] separately. If an app shows no final state, do not resubmit; check nas_app_get with view "status".`

- [ ] **Step 1: 写失败的测试 `test/tools/app-storage.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_app_list', {}, ['app', 'ls'], 'read'],
  ['nas_app_list', { filter: 'installed' }, ['app', 'ls', '--installed'], 'read'],
  ['nas_app_list', { filter: 'not_installed' }, ['app', 'ls', '--not-installed'], 'read'],
  ['nas_app_list', { filter: 'update_available' }, ['app', 'ls', '--update-available'], 'read'],
  ['nas_app_list', { filter: 'repair_needed' }, ['app', 'ls', '--repair-needed'], 'read'],
  ['nas_app_list', { keyword: 'jellyfin' }, ['app', 'search', '--', 'jellyfin'], 'read'],
  ['nas_app_list', { keyword: 'jellyfin', filter: 'installed' }, ['app', 'search', '--installed', '--', 'jellyfin'], 'read'],
  ['nas_app_get', { app_ids: ['com.ugreen.photos'] }, ['app', 'get', '--', 'com.ugreen.photos'], 'read'],
  ['nas_app_get', { view: 'status', app_ids: ['a', 'b'] }, ['app', 'status', '--', 'a', 'b'], 'read'],
  ['nas_app_manage', { action: 'install', app_ids: ['com.example.app'], install_path: '/volume1',
      params: [{ key: 'PORT', value: '8096' }, { key: 'DIRS', value: ['/a', '/b'] }], no_start: true },
    ['app', 'install', '--path=/volume1', '--param=PORT=8096', '--param-multi=DIRS=/a,/b', '--no-start', '--wait-timeout=30m', '--', 'com.example.app'], 'admin'],
  ['nas_app_manage', { action: 'update', app_ids: ['a', 'b'] }, ['app', 'update', '--wait-timeout=30m', '--', 'a', 'b'], 'admin'],
  ['nas_app_manage', { action: 'uninstall', app_ids: ['com.example.app'], clean_data: true, wait_timeout_minutes: 10 },
    ['app', 'uninstall', '--clean', '--wait-timeout=10m', '--', 'com.example.app'], 'admin'],
  ['nas_app_manage', { action: 'start', app_ids: ['com.ugreen.photos'] }, ['app', 'start', '--', 'com.ugreen.photos'], 'admin'],
  ['nas_app_manage', { action: 'stop', app_ids: ['com.ugreen.photos'] }, ['app', 'stop', '--', 'com.ugreen.photos'], 'admin'],
  ['nas_storage_info', { kind: 'disks' }, ['storage', 'disk', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'disks', show_serial: true }, ['storage', 'disk', 'ls', '--show-serial'], 'read'],
  ['nas_storage_info', { kind: 'pools' }, ['storage', 'pool', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'volumes' }, ['storage', 'volume', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'smart' }, ['storage', 'disk', 'smart'], 'admin'],
  ['nas_storage_info', { kind: 'smart', show_serial: true }, ['storage', 'disk', 'smart', '--show-serial'], 'admin'],
];

describe('app and storage tools', () => {
  checkRows(rows);

  it('validates combinations', () => {
    expect(() => call('nas_app_list', { keyword: 'x', filter: 'update_available' })).toThrowError(ToolInputError);
    expect(() => parse('nas_app_list', { keyword: 'x'.repeat(21) })).toThrow();
    expect(() => call('nas_app_get', { app_ids: ['a', 'b'] })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'update', app_ids: ['a'], install_path: '/volume1' })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'install', app_ids: ['a'], clean_data: true })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'stop', app_ids: ['a'], no_start: true })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'install', app_ids: ['a'], params: [{ key: 'A=B', value: 'x' }] })).toThrowError(ToolInputError);
    expect(() => call('nas_storage_info', { kind: 'pools', show_serial: true })).toThrowError(ToolInputError);
  });
  it('waits for long-running app operations', () => {
    expect(call('nas_app_manage', { action: 'install', app_ids: ['a'], install_path: '/volume1' }).timeoutMs).toBe(1_830_000);
    expect(call('nas_app_manage', { action: 'update', app_ids: ['a'], wait_timeout_minutes: 5 }).timeoutMs).toBe(330_000);
    expect(call('nas_app_manage', { action: 'stop', app_ids: ['a'] }).timeoutMs).toBeUndefined();
  });
  it('projects the app list to compact entries', () => {
    const env = { success: true, action: '/app.App/DetailList', data: { apps: [
      { brief: { app_id: 'a', name_i18n_map: { 'zh-CN': '云盘', 'en-US': 'Cloud', 'de-DE': 'Wolke' }, install_status: 'INSTALL_STATUS_INSTALLED',
          installed_version: { version: '1.0', size: '0' }, cloud_version: { version: '1.1' }, app_type: 'T', icon_path: '/x' },
        install_parameters: [{ key: 'k' }], i18n: { big: 'blob' } },
      { brief: { app_id: 'b', name_i18n_map: { 'en-US': 'Only English' }, install_status: 'INSTALL_STATUS_NOT_INSTALLED' } },
    ] } };
    expect(tool('nas_app_list').project!(env)).toEqual({ success: true, action: '/app.App/DetailList', data: { count: 2, apps: [
      { app_id: 'a', name: { 'zh-CN': '云盘', 'en-US': 'Cloud' }, install_status: 'INSTALL_STATUS_INSTALLED', installed_version: '1.0', available_version: '1.1', app_type: 'T' },
      { app_id: 'b', name: { 'en-US': 'Only English' }, install_status: 'INSTALL_STATUS_NOT_INSTALLED', installed_version: null, available_version: null, app_type: null },
    ] } });
  });
  it('leaves an unexpected envelope untouched', () => {
    const env = { success: true, data: { something: 'else' } };
    expect(tool('nas_app_list').project!(env)).toEqual(env);
  });
  it('sets registration bounds', () => {
    expect([tool('nas_storage_info').minRisk, tool('nas_storage_info').maxRisk]).toEqual(['read', 'admin']);
    expect(tool('nas_app_manage').minRisk).toBe('admin');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/app-storage.test.ts`
Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现这 4 个工具并追加到 `ALL_TOOLS`**

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run test/tools`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/app.ts src/tools/storage.ts src/tools/index.ts test/tools/app-storage.test.ts
git commit -m "feat: add app and storage tools"
```

---

### Task 12: ctl、network、taskmgr 工具（6 个）

**Files:**
- Create: `src/tools/ctl.ts`, `src/tools/network.ts`, `src/tools/taskmgr.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools/system.test.ts`

**Interfaces:**
- Produces: `export const ctlTools`、`networkTools`、`taskmgrTools`（均为 `ToolSpec[]`）

**参数（zod）：**

| 工具 | 参数 | 风险 |
|---|---|---|
| `nas_users` | `kind` enum `users groups` = `users`；`names?` string[]；`uids?` int[]；`role?` enum `all admin users`；`keyword?` string | read |
| `nas_system_info` | `kind` enum `identity update_status fan beep cpu led zram power ups` | read |
| `nas_user_create` | `username` string；`password` string 非空；`role` enum `users admin` = `users`；`nickname?`；`description?`；`email?`；`groups?` string[]，每项匹配 `^\d+:.+$`；`force_change_password` boolean=false | admin |
| `nas_group_add_member` | `gid` int ≥1；`members` string[] 1–20，每项匹配 `^\d+:.+$` | admin |
| `nas_network_info` | `kind` enum `interfaces general` = `interfaces`；`iface?` string | read |
| `nas_performance` | `kind` enum `overview cpu gpu mem net disk volume processes services` = `overview`；`sort?` enum `cpu mem name pid`；`top` int 0–200 = 10 | read |

组合校验：`nas_users` 的筛选参数只用于 `users`；`nas_network_info` 的 `iface` 只用于 `interfaces`；`nas_performance` 的 `sort` 只用于 `processes`/`services`，且 `services` 不接受 `pid`。
`nas_user_create` 的密码走 `stdin`。

**描述要点：**

| 工具 | 必须写明 |
|---|---|
| `nas_users` | `uid` 是数字、`gid` 是字符串；`groups` 只列自建群组，不含内置的 admin / users / ughomeusers；找过期账号看 `user_base.is_expired`；不能修改或删除用户 |
| `nas_system_info` | `identity`、`update_status`、`zram` 在旧版控制面板上不可用；`update_status` 只读、不触发更新；`cpu.is_support` 为不支持时不要报 `frequency`；UPS 等待时间先看 `right_now`，`standby_time` 为 `"-1"` 表示电量不足时；不能修改任何设置 |
| `nas_user_create` | `role: admin` 必须是用户明确要求的；不要在回复里复述密码；成功时 `data.value` 是新 uid；失败后先用 `nas_users` 核对，不要重试 |
| `nas_group_add_member` | 调用前必须先用 `nas_users` 确认群组（`kind: groups`）和用户都存在且用户不在组内；成员写成 `UID:用户名`；内置群组（gid 10 / 100 / 133）不能加成员；只追加不移除 |
| `nas_network_info` | 是否有地址看 `ipv4.ip_addr` 是否为空，不要看 `ipv4.status`；网卡名不存在时返回空数组而不报错；`speed` 为 -1 或 0 表示无链路；只读 |
| `nas_performance` | 瞬时值，判断趋势要隔几秒再取；网络与进程的读写是字节/秒，硬盘与存储空间是千字节/秒；温度 0 表示读不到；`sort`/`top` 只对 `processes`/`services` 有效；旧版任务管理器全部不可用；不能结束进程 |

- [ ] **Step 1: 写失败的测试 `test/tools/system.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_users', {}, ['ctl', 'user', 'ls'], 'read'],
  ['nas_users', { names: ['bob', 'amy'], uids: [1000, 1001], role: 'admin', keyword: 'ali' },
    ['ctl', 'user', 'ls', '--name=bob', '--name=amy', '--uid=1000,1001', '--role=admin', '--keyword=ali'], 'read'],
  ['nas_users', { kind: 'groups' }, ['ctl', 'group', 'ls'], 'read'],
  ['nas_system_info', { kind: 'identity' }, ['ctl', 'os', 'identity'], 'read'],
  ['nas_system_info', { kind: 'update_status' }, ['ctl', 'os', 'update-status'], 'read'],
  ['nas_system_info', { kind: 'fan' }, ['ctl', 'hardware', 'fan'], 'read'],
  ['nas_system_info', { kind: 'ups' }, ['ctl', 'hardware', 'ups'], 'read'],
  ['nas_user_create', { username: 'bob', password: 's3cret', nickname: 'Bob', description: 'x y', email: 'b@e.com',
      groups: ['1000:family', '1001:work'], force_change_password: true },
    ['ctl', 'user', 'create', '--password-stdin', '--role=users', '--nickname=Bob', '--description=x y', '--email=b@e.com',
      '--group=1000:family', '--group=1001:work', '--force-change-password', '--', 'bob'], 'admin'],
  ['nas_user_create', { username: 'root2', password: 'p', role: 'admin' }, ['ctl', 'user', 'create', '--password-stdin', '--role=admin', '--', 'root2'], 'admin'],
  ['nas_group_add_member', { gid: 1000, members: ['1001:bob', '1002:amy'] }, ['ctl', 'group', 'add-member', '--', '1000', '1001:bob', '1002:amy'], 'admin'],
  ['nas_network_info', {}, ['network', 'iface', 'ls'], 'read'],
  ['nas_network_info', { iface: 'eth0' }, ['network', 'iface', 'ls', '--', 'eth0'], 'read'],
  ['nas_network_info', { kind: 'general' }, ['network', 'general'], 'read'],
  ['nas_performance', {}, ['taskmgr', 'overview'], 'read'],
  ['nas_performance', { kind: 'net' }, ['taskmgr', 'net'], 'read'],
  ['nas_performance', { kind: 'volume' }, ['taskmgr', 'volume'], 'read'],
  ['nas_performance', { kind: 'processes', sort: 'cpu' }, ['taskmgr', 'process', 'ls', '--sort=cpu', '--top=10'], 'read'],
  ['nas_performance', { kind: 'processes' }, ['taskmgr', 'process', 'ls', '--top=10'], 'read'],
  ['nas_performance', { kind: 'services', sort: 'mem', top: 5 }, ['taskmgr', 'service', 'ls', '--sort=mem', '--top=5'], 'read'],
];

describe('ctl, network and taskmgr tools', () => {
  checkRows(rows);

  it('sends the password through stdin, never argv', () => {
    const c = call('nas_user_create', { username: 'bob', password: 's3cret' });
    expect(c.stdin).toBe('s3cret');
    expect(c.argv.join(' ')).not.toContain('s3cret');
  });
  it('validates combinations', () => {
    expect(() => call('nas_users', { kind: 'groups', role: 'admin' })).toThrowError(ToolInputError);
    expect(() => call('nas_network_info', { kind: 'general', iface: 'eth0' })).toThrowError(ToolInputError);
    expect(() => call('nas_performance', { kind: 'services', sort: 'pid' })).toThrowError(ToolInputError);
    expect(() => call('nas_performance', { kind: 'cpu', sort: 'cpu' })).toThrowError(ToolInputError);
    expect(() => parse('nas_group_add_member', { gid: 1000, members: ['bob'] })).toThrow();
    expect(() => parse('nas_user_create', { username: 'bob', password: '' })).toThrow();
    expect(() => parse('nas_user_create', { username: 'bob', password: 'p', groups: ['family'] })).toThrow();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/tools/system.test.ts`
Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现这 6 个工具并追加到 `ALL_TOOLS`**

- [ ] **Step 4: 运行全部测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS，无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/tools/ctl.ts src/tools/network.ts src/tools/taskmgr.ts src/tools/index.ts test/tools/system.test.ts
git commit -m "feat: add control panel, network and task manager tools"
```

---

### Task 13: 工具清单校验与 stdio 端到端测试

**Files:**
- Test: `test/e2e.test.ts`
- Modify: `package.json`（`test` 脚本改为 `npm run build && vitest run`）

**Interfaces:**
- Consumes: `ALL_TOOLS`、`enabledTools`、`loadConfig`；构建产物 `dist/index.js`；`test/fixtures/fake-unc.mjs`

- [ ] **Step 1: 写测试 `test/e2e.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
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
});

describe('stdio end to end', () => {
  let client: Client | undefined;
  afterEach(async () => { await client?.close(); client = undefined; });
  async function connect(env: Record<string, string>) {
    client = new Client({ name: 'e2e', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY],
      env: { PATH: process.env.PATH ?? '', UGREEN_MCP_UNC_BIN: FAKE, ...env }, stderr: 'pipe' }));
    return client;
  }
  const body = (r: any) => JSON.parse(r.content[0].text);

  it('lists 25 tools by default and passes arguments verbatim', async () => {
    const c = await connect({});
    expect((await c.listTools()).tools).toHaveLength(25);
    const r = await c.callTool({ name: 'nas_docker_logs', arguments: { target: 'container', id: '-rf' } });
    expect(body(r).argv).toEqual(['--format=json', 'docker', 'logs', '--', '-rf']);
    const s = await c.callTool({ name: 'nas_file_stat', arguments: { paths: ['/volume1/照片/a b.jpg'] } });
    expect(body(s).argv).toEqual(['--format=json', 'file', 'stat', '--', '/volume1/照片/a b.jpg']);
  });
  it('runs the two-step confirmation over the wire', async () => {
    const c = await connect({ UGREEN_MCP_ACCESS: 'admin' });
    expect((await c.listTools()).tools).toHaveLength(44);
    const preview = body(await c.callTool({ name: 'nas_file_delete', arguments: { paths: ['/home/u/a.txt'] } }));
    expect(preview.status).toBe('confirmation_required');
    expect(preview.preview.argv).toContain('--dry-run');
    const done = body(await c.callTool({ name: 'nas_file_delete', arguments: { paths: ['/home/u/a.txt'], confirm_token: preview.confirm_token } }));
    expect(done.argv).toEqual(['--format=json', '--yes', 'file', 'rm', '--', '/home/u/a.txt']);
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
  it('rejects a call the schema does not allow', async () => {
    const c = await connect({});
    const r = await c.callTool({ name: 'nas_file_read', arguments: { path: '/a', length: 99999999 } }).catch((e) => ({ isError: true, e }));
    expect((r as any).isError).toBe(true);
  });
  it('surfaces unc failures and timeouts as tool errors', async () => {
    const c = await connect({ FAKE_UNC_MODE: 'stderr-only' });
    const r = await c.callTool({ name: 'nas_file_roots', arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).hint).toContain('UNC_NAS_TOKEN');
  });
  it('starts without unc and explains how to fix it', async () => {
    const c = await connect({ UGREEN_MCP_UNC_BIN: '/nonexistent/unc' });
    expect((await c.listTools()).tools).toHaveLength(25);
    const r = await c.callTool({ name: 'nas_status', arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).hint).toContain('UGREEN_MCP_UNC_BIN');
  });
  it('exits with code 2 on invalid configuration', async () => {
    const { spawnSync } = await import('node:child_process');
    const p = spawnSync(process.execPath, [ENTRY], { env: { PATH: process.env.PATH ?? '', UGREEN_MCP_ACCESS: 'root' }, encoding: 'utf8' });
    expect(p.status).toBe(2);
    expect(p.stderr).toContain('UGREEN_MCP_ACCESS');
    expect(p.stdout).toBe('');
  });
});
```

- [ ] **Step 2: 构建并运行**

Run: `npm run build && npx vitest run test/e2e.test.ts`
Expected: PASS。若数量断言失败，按规格第 6 节核对各工具的 `minRisk` 与 `localPath`，修正工具声明而不是改测试里的数字。

- [ ] **Step 3: 把 `package.json` 的 `test` 脚本改为 `npm run build && vitest run`，运行完整测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add test/e2e.test.ts package.json
git commit -m "test: add catalogue checks and stdio end-to-end tests"
```

---

### Task 14: README、LICENSE、CI

**Files:**
- Create: `README.md`, `README.en.md`, `LICENSE`, `.github/workflows/ci.yml`
- Test: `test/docs.test.ts`

- [ ] **Step 1: 写失败的测试 `test/docs.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ALL_TOOLS } from '../src/tools/index.js';

const ENV = ['UNC_NAS_URL', 'UNC_NAS_TOKEN', 'UGREEN_MCP_ACCESS', 'UGREEN_MCP_TOOLSETS', 'UGREEN_MCP_ALLOWED_PATHS',
  'UGREEN_MCP_LOCAL_DIR', 'UGREEN_MCP_UNC_BIN', 'UGREEN_MCP_MAX_OUTPUT_CHARS'];

describe.each(['README.md', 'README.en.md'])('%s', (file) => {
  it('documents every tool and every environment variable', async () => {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const t of ALL_TOOLS) expect(text, t.name).toContain('`' + t.name + '`');
    for (const v of ENV) expect(text, v).toContain(v);
  });
  it('carries no real token', async () => {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/ugpoa_v1\.(?!\*\*\*|<|…|x{3,})[A-Za-z0-9]/);
  });
});

it('LICENSE is MIT with the project as holder', async () => {
  const text = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
  expect(text).toContain('MIT License');
  expect(text).toContain('ugreen-nas-mcp contributors');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run test/docs.test.ts`
Expected: FAIL，文件不存在。

- [ ] **Step 3: 写 `README.md`（中文）**

章节依次为：

1. 一句话说明与非官方声明：本项目与绿联无关联，UGREEN 是其所有者的商标；通过绿联官方 `unc` CLI 工作，不随包分发 `unc`。
2. 工作方式：一张文字版架构图（客户端 → 本 server → `unc` → NAS）。
3. 前置条件：安装并能运行 `unc`（运行 `unc version` 验证）；在 NAS 控制面板创建访问令牌并按需勾选权限节点；Node ≥ 20。不写 `unc` 的下载地址，指向绿联官方说明。
4. 快速开始：两种凭证方式（环境变量 `UNC_NAS_URL` + `UNC_NAS_TOKEN`，或先在终端 `unc auth login`）。配置片段中的令牌一律写 `ugpoa_v1.***`。给出 Claude Desktop / Cursor / WorkBuddy 通用的 `mcpServers` JSON、Claude Code 的 `claude mcp add` 命令、Codex 的 `config.toml` 片段。
5. 环境变量表（规格 5.1）。
6. 权限模型：三个级别各允许什么；工具组；路径白名单；本机传输目录；两段式确认的流程与示例。
7. 局限（必须原样说明这四点）：确认码不等于人类同意，人类把关依赖客户端的工具审批；白名单是字符串判断，识别不了 NAS 上的符号链接；白名单不约束 docker 与 app 的 `admin` 操作；令牌本身的权限由 NAS 决定，建议按最小权限创建令牌。
8. 工具清单：按工具组列出全部 46 个工具，每个带风险级别与一句说明。
9. 常见问题：找不到 `unc`；401 与 403 的区别；功能在这台 NAS 上不可用；Cursor 工具数上限时用 `UGREEN_MCP_TOOLSETS` 裁剪。
10. 开发：`npm install`、`npm test`、`npm run live-check`。
11. 许可证。

- [ ] **Step 4: 写 `README.en.md`**

与中文版章节一一对应的英文版，顶部互相链接。

- [ ] **Step 5: 写 `LICENSE` 与 `.github/workflows/ci.yml`**

`LICENSE`：标准 MIT 文本，`Copyright (c) 2026 ugreen-nas-mcp contributors`。
CI：在 `push` 与 `pull_request` 时触发；`ubuntu-latest`；Node 矩阵 `20`、`22`、`24`；步骤为 `actions/checkout@v4`、`actions/setup-node@v4`（`cache: npm`）、`npm ci`、`npm run typecheck`、`npm test`。

- [ ] **Step 6: 运行，确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add README.md README.en.md LICENSE .github test/docs.test.ts
git commit -m "docs: add README, license and CI"
```

---

### Task 15: 真机验证（只读与预演）

**Files:**
- Create: `scripts/live-check.mjs`

**Interfaces:**
- Consumes: `dist/index.js`；本机已登录的真实 `unc`

本任务不做真实写入。脚本只调只读工具，以及 `admin` 工具的第一步（预演），不发送确认码。

- [ ] **Step 1: 写 `scripts/live-check.mjs`**

用 SDK 的 `Client` 与 `StdioClientTransport` 启动 `dist/index.js`，环境为当前进程环境加 `UGREEN_MCP_ACCESS=admin`。依次执行并打印每项的 `PASS` / `FAIL` / `UNAVAILABLE`（返回里含 `not available on this NAS` 时记为 `UNAVAILABLE`，不算失败）与耗时，最后打印汇总；有 `FAIL` 时退出码为 1。检查项：

| 调用 | 通过条件 |
|---|---|
| `nas_status` | `auth.authenticated === true` |
| `nas_file_roots` | 非错误 |
| `nas_file_list` `{}` | 非错误，记下第一个目录项的路径 |
| `nas_file_stat`（上一步的个人文件夹路径） | `items[0].success === true` |
| `nas_file_usage` `{ kind: 'quota', paths: [个人文件夹] }` | 非错误 |
| `nas_file_tags` `{ query: 'list_tags' }` | 非错误 |
| `nas_search_files` `{ query: 'a', paths: [个人文件夹], limit: 5, max_results: 5 }` | 非错误；若 `task_removed` 不为 true 则再调 `nas_search_results` 的 `remove` |
| `nas_docker_containers`、`nas_docker_images`、`nas_docker_projects` | 非错误 |
| `nas_download_list` | 非错误 |
| `nas_app_list` `{ filter: 'installed' }` | 非错误，且返回文本短于 60000 字符 |
| `nas_storage_info` 的 `disks`、`pools`、`volumes` | 非错误 |
| `nas_users`、`nas_users` `{ kind: 'groups' }` | 非错误 |
| `nas_system_info` 的 `identity`、`fan` | 非错误 |
| `nas_network_info`、`nas_network_info` `{ kind: 'general' }` | 非错误 |
| `nas_performance`、`nas_performance` `{ kind: 'processes', sort: 'cpu', top: 3 }` | 非错误 |
| `nas_file_delete` `{ paths: [个人文件夹 + '/__nas_mcp_live_check_missing__'] }`（预演） | 返回错误且**没有** `confirm_token`（路径不存在，预演失败） |
| `nas_storage_info` `{ kind: 'smart' }`（预演） | `status === 'confirmation_required'`，随后不发送确认码 |
| 任意一次返回的全文 | 不含 `ugpoa_v1.` 后跟非 `*` 字符 |

脚本不打印工具返回的数据内容，只打印检查项名称与结果。

- [ ] **Step 2: 构建并运行**

Run: `npm run build && npm run live-check`
Expected: 汇总行显示 0 个 `FAIL`。`UNAVAILABLE` 的项逐个记下工具名与原因。

- [ ] **Step 3: 处理发现的问题**

对每个 `FAIL`：用 `unc <对应命令> --help` 与直接执行核对参数，修正工具声明，补一行测试，再跑 `npm test` 与 `npm run live-check`。

- [ ] **Step 4: 提交**

```bash
git add scripts/live-check.mjs
git commit -m "test: add read-only live check against a real NAS"
```
