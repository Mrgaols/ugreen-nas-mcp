# ugreen-nas-mcp 设计文档

日期：2026-11-13
状态：待审阅

## 1. 目标

做一个非官方、可开源的通用 MCP server，让任意 MCP 客户端（Claude Desktop、Claude Code、Cursor、WorkBuddy、Codex 等）都能管理用户自己的绿联 NAS。

现状是「WorkBuddy → 绿联云连接器 → 提示词 Skill → `unc`」，只有一个宿主能用，而且靠提示词教 agent 拼命令。本项目把中间两层换成一个 MCP server：

```
任意 MCP 客户端 ⇄ stdio ⇄ ugreen-nas-mcp ──execFile──▶ unc CLI ──HTTPS+protobuf──▶ NAS
```

成功标准：

1. 用户在任意支持 stdio 的 MCP 客户端里加一段配置（`npx -y ugreen-nas-mcp` 加两个环境变量），agent 就能查询并管理 NAS。
2. 开箱只读；写入和危险操作必须由用户在配置里显式放开。
3. server 不接触令牌明文。
4. 原先靠 Skill 提示词传授的规矩，改由参数 schema、工具描述和 server `instructions` 承载，对所有客户端生效。

## 2. 已定决策

| 决策 | 结论 |
|---|---|
| 语言与分发 | TypeScript，官方 `@modelcontextprotocol/sdk`，发布到 npm，用 `npx` 启动 |
| 工具粒度 | 精选类型化工具，共 46 个，同类只读查询用 `kind` 枚举合并 |
| 默认权限 | 只读 |
| 传输 | 仅 stdio |
| 底层 | 复用绿联官方 `unc` CLI，不自己实现 protobuf 通道 |
| 协议 | MIT；`unc` 是绿联的专有发布物，不随包分发 |

## 3. 非目标

- HTTP / SSE 传输、远程部署。
- 直接调用 NAS 的 HTTP 或 protobuf 接口。
- 管理 `unc` 的登录态：不暴露 `auth login / logout / export / import / reset`、`plugin`、`skill`、`upgrade`、`uninstall`。
- 一个进程管多台 NAS。多台 NAS 用多条 server 配置、各自的环境变量。
- `file mkdir-share`（创建后 CLI 无法撤销）、`file getfattr`、`file touch` 改时间戳、`file tee` 的 `patch` 模式、`--insecure`。
- MCP elicitation（由 server 直接向用户弹确认）。留作后续版本。

## 4. 架构

单个 Node 进程（Node ≥ 20，ESM）。模块与职责：

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/index.ts` | 入口：读配置、定位 `unc`、启动 stdio | config、server |
| `src/config.ts` | 把环境变量解析成不可变的 `Config`，非法值启动即报错 | 无 |
| `src/unc/locate.ts` | 找 `unc` 可执行文件 | 无 |
| `src/unc/runner.ts` | `execFile` 调 `unc`、超时、解析 JSON 信封 | 无 |
| `src/policy.ts` | 访问级别、工具组、路径白名单、本机目录的判定（纯函数） | config |
| `src/confirm.ts` | 确认码的签发与校验 | 无 |
| `src/output.ts` | 结果整形：脱敏、截断、错误提示 | 无 |
| `src/tools/types.ts` | `ToolSpec` 类型 | 无 |
| `src/tools/<产品>.ts` | 每个产品的工具声明 | types |
| `src/server.ts` | 按策略注册工具，串起「校验 → 闸门 → 执行 → 整形」 | 以上全部 |

### 4.1 ToolSpec

每个工具是一条声明，`server.ts` 用同一段逻辑处理所有工具：

```ts
interface ToolSpec {
  name: string;                 // nas_file_list
  toolset: Toolset;             // file | search | docker | …
  title: string;
  description: string;          // 英文，写明该工具的坑
  input: z.ZodRawShape;
  minRisk: Risk;                // 该工具最低的风险级别，决定是否注册
  risk(args): Risk;             // 本次调用的实际风险
  nasPaths?(args): string[];    // 需要过路径白名单的 NAS 路径
  requiresLocalDir?: boolean;   // 需要 UGREEN_MCP_LOCAL_DIR
  build(args, ctx): UncCall;    // { argv, stdin?, timeoutMs }
  project?(data): unknown;      // 可选：精简过大的输出
  followUp?: string;            // 可选：成功后附带的下一步提示
}
```

`Risk` 取值 `read < write < admin`。

### 4.2 一次调用的流程

1. SDK 用 zod schema 校验参数。
2. `risk(args)` 算出实际风险，高于配置的访问级别则拒绝，并说明需要哪个级别。
3. `nasPaths(args)` 逐个过白名单；上传下载的本机路径过本机目录检查。
4. 风险为 `admin` 时走两段式确认（见 5.4）。
5. `build` 生成参数列表，`runner` 执行。
6. `output` 整形后返回。

### 4.3 调用 unc 的规则

- 一律 `execFile`，不经 shell。
- 一律 `--format json`；唯一例外是 `nas_file_read`，用 `--format raw` 取原始字节。
- 用户提供的值全部放在 `--` 之后作为位置参数，或作为某个 flag 的取值；已验证 `unc` 支持 `--` 分隔。
- 子进程环境 = 本进程环境。server 不增删 `UNC_*` 变量。
- 敏感输入走标准输入：`ctl user create` 的密码、`docker compose up` 的 YAML（compose 文件里常有口令，不放进进程列表可见的命令行）。
- 超时：一元命令进程超时 60 秒。流式命令（递归列目录、`find`、`du`、搜索、标签筛选、上传、下载）带 `timeout_seconds` 参数（默认 120，上限 1800），传给 `--stream-timeout`，进程超时在其上加 15 秒。
- 解析：stdout 是 JSON 信封（`success` + `data` 或 `items[]`），失败时退出码非 0。以 `success` 字段为准；stdout 不是 JSON 时把 stderr 文本作为错误返回。

## 5. 权限边界

### 5.1 配置项

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `UNC_NAS_URL`、`UNC_NAS_TOKEN` | 无 | `unc` 自己的变量，server 原样透传。不设则 `unc` 使用 `unc auth login` 的本机缓存 |
| `UGREEN_MCP_ACCESS` | `read` | `read` / `write` / `admin` |
| `UGREEN_MCP_TOOLSETS` | 全部 | 逗号分隔：`file,search,docker,download,app,storage,ctl,network,taskmgr` |
| `UGREEN_MCP_ALLOWED_PATHS` | 不限 | 逗号分隔的 NAS 绝对路径前缀 |
| `UGREEN_MCP_LOCAL_DIR` | 未设 | 上传、下载可用的本机目录 |
| `UGREEN_MCP_UNC_BIN` | 自动查找 | `unc` 的路径。自动查找顺序：`PATH`，再 `~/.local/bin/unc` |
| `UGREEN_MCP_MAX_OUTPUT_CHARS` | `60000` | 单次返回的字符上限 |

### 5.2 访问级别

| 级别 | 允许 |
|---|---|
| `read` | 只读查询 |
| `write` | 另加「只新增、不覆盖、不中断服务」的操作：建目录、建新文件、复制（不覆盖）、上传（不覆盖）、下载到本机、从回收站恢复、新建标签、给文件打标签、创建下载任务、暂停 / 继续 / 重试指定任务、拉取镜像 |
| `admin` | 另加删除、移动、覆盖、改配额、删标签、启停容器与项目、创建 / 删除 Compose 项目、重建应用、移除下载任务、对全部下载任务的批量操作、应用的装 / 更 / 卸 / 启停、建用户、加群组成员、读取 SMART 原始数据 |

工具的 `minRisk` 高于配置级别时**不注册**，agent 看不到。风险随参数变化的工具（如 `nas_file_copy` 带 `on_conflict: "replace"`）照常注册，超级别的调用在第 2 步被拒。

`nas_status` 不属于任何工具组，始终注册。

### 5.3 路径约束

**NAS 路径白名单**作用于 `file`、`search` 两组工具的全部 NAS 路径参数，以及 `nas_download_create` 的保存目录。规则：

- 路径必须以 `/` 开头，不得含 `..` 段或 NUL。
- 规范化（合并重复的 `/`、去掉结尾的 `/`）后，必须等于某个白名单前缀，或以「前缀 + `/`」开头。
- 设了白名单后，原本可省略路径的调用（`nas_file_list` 默认个人文件夹、`nas_search_files` 不限范围、`nas_file_tags` 按标签找文件不限范围）必须显式给出路径。
- `nas_file_move` 的同目录改名目标是纯文件名，不含 `/`，不参与白名单判断，但其源路径参与。

已知局限，写进 README：白名单在客户端做字符串判断，无法识别 NAS 上的符号链接；它也不约束 docker、app 两组的 `admin` 操作（创建 Compose 项目可以挂载任意目录）。

**本机目录**：`nas_file_upload`、`nas_file_download` 只在设置了 `UGREEN_MCP_LOCAL_DIR` 时注册。本机路径可以是相对该目录的路径，或落在该目录内的绝对路径；用 `realpath` 解析后再判断，防止用符号链接逃出目录（上传判断文件本身，下载判断目标的父目录）。

### 5.4 两段式确认

适用于所有实际风险为 `admin` 的调用。这些工具都有可选参数 `confirm_token`。

1. 不带 `confirm_token`：server 以 `--dry-run` 执行（不带 `--yes`）。预演成功则返回：
   ```json
   { "status": "confirmation_required",
     "preview": { /* unc 的预演输出 */ },
     "confirm_token": "9f2c41ab77e0",
     "expires_in_seconds": 300 }
   ```
   预演失败则直接返回错误，不签发确认码。
2. 带 `confirm_token`：server 校验确认码存在、未过期、且与「工具名 + 其余参数的规范化 JSON」的 SHA-256 一致，通过后作废该确认码，再以 `--yes` 真实执行。

确认码是 12 位十六进制随机串，一次性，存于内存，进程重启即失效。参数有任何改动都会导致哈希不符。

它保证的是「必须先预演，且执行的就是预演过的那一份」。它不等于人类同意：人类把关靠 MCP 客户端的工具审批弹窗，为此所有可能达到 `admin` 的工具标注 `destructiveHint: true`。README 如实说明这一点。

### 5.5 凭证

- server 不读 `~/.unc/auth.json`，不读 `UNC_NAS_TOKEN` 的值，不提供任何设置令牌的参数。
- 不使用 `--token` 参数。
- `output` 对所有返回文本做 `ugpoa_v1.` 开头令牌的脱敏。
- 日志只写 stderr，记录工具名与退出码，不记录参数值。

## 6. 工具清单

共 46 个。默认只读时注册 25 个。

### 6.1 核心（1）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_status` | read | `auth status --check`；`doctor: true` 时另跑 `doctor`。同时返回 server 的策略摘要（访问级别、工具组、白名单、是否可传输、`unc` 版本） |

### 6.2 file（19）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_file_roots` | read | `file ls-root --root shared` |
| `nas_file_list` | read | `file ls [PATH] [-R] [--limit]`，省略路径为个人文件夹 |
| `nas_file_read` | read | `file cat PATH --offset --length`；默认读 64 KiB，上限 1 MiB；UTF-8 返回文本，否则返回 Base64 |
| `nas_file_stat` | read | `file stat PATH...` |
| `nas_file_find` | read | `file find ROOT...`，按名称、类型或媒体分类、大小、时间、深度筛选 |
| `nas_file_usage` | read | `kind: du` → `file du`；`kind: quota` → `file quota get` |
| `nas_file_checksum` | read | `file md5sum` / `file sha256sum` |
| `nas_file_tags` | read | `query: list_tags` → `tag list`；`tags_of_paths` → `tag file get`；`files_by_tag` → `tag file list` |
| `nas_file_mkdir` | write | `file mkdir` |
| `nas_file_create` | write | `file touch PATH --content --exclusive`，目标已存在则失败，不覆盖 |
| `nas_file_copy` | write；`replace` 为 admin | `file cp SRC DST_DIR --on-conflict`，一次一个源 |
| `nas_file_restore` | write | `file recover-recycle` |
| `nas_file_tag_edit` | write；删除类为 admin | `create_tag` / `tag_files` → `tag add` / `tag file add`；`delete_tags` / `untag_files` → `tag delete` / `tag file delete` |
| `nas_file_upload` | write；`replace` 为 admin | `file upload LOCAL REMOTE`，需本机目录 |
| `nas_file_download` | write | `file download REMOTE LOCAL`，需本机目录；覆盖或续传本机已有文件仍属 write，因为只能发生在本机目录内 |
| `nas_file_move` | admin | `file mv SRC DST`，目标是已存在的目录或纯文件名 |
| `nas_file_delete` | admin | `file rm PATH... [--permanent]` |
| `nas_file_write` | admin | `file tee PATH --content`，覆盖或追加已存在的文件 |
| `nas_file_quota_set` | admin | `file quota set PATH --quota-mb` |

### 6.3 search（2）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_search_files` | read | `search title [QUERY] --path -R …`，返回第一页、`task_id`、`next_offset` |
| `nas_search_results` | read | `action: page` → `search results`；`cancel` → `search cancel`；`remove` → `search rm`（只删搜索任务，不动文件） |

### 6.4 docker（11）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_docker_containers` | read | `docker ps` |
| `nas_docker_images` | read | `source: local` → `docker images`；`registry` → `docker search` |
| `nas_docker_projects` | read | `docker compose ls` |
| `nas_docker_logs` | read | `target: container` → `docker logs`；`project` → `docker compose logs` |
| `nas_docker_check` | read | `kind: port / dir / gpu` → `port-check` / `dir-check` / `gpu-check` |
| `nas_docker_app_usage` | read | `docker stats`（仅应用中心的应用） |
| `nas_docker_pull` | write | `docker pull IMAGE:TAG` |
| `nas_docker_container_control` | admin | `docker start / stop / restart ID...` |
| `nas_docker_project_control` | admin | `docker compose start / stop / restart / delete PROJECT` |
| `nas_docker_project_create` | admin | `docker compose up --name --path`，YAML 走标准输入 |
| `nas_docker_app_rebuild` | admin | `docker rebuild APP_ID --params-json` |

### 6.5 download（3）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_download_list` | read | 无 ID → `download ls`；有 ID → `download status` |
| `nas_download_create` | write | `download create URL [--dir]` |
| `nas_download_control` | write；`remove` 或 `all: true` 为 admin | `download pause / resume / retry / rm`；必须给任务 ID 或显式 `all: true` |

### 6.6 app（3）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_app_list` | read | 无关键词 → `app ls`；有关键词 → `app search`。输出做字段精简（见 7.1） |
| `nas_app_get` | read | `view: detail` → `app get`；`status` → `app status` |
| `nas_app_manage` | admin | `app install / update / uninstall / start / stop` |

### 6.7 storage（1）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_storage_info` | read；`smart` 为 admin | `kind: disks / pools / volumes / smart` → `storage disk ls` / `pool ls` / `volume ls` / `disk smart` |

### 6.8 ctl（4）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_users` | read | `kind: users` → `ctl user ls`；`groups` → `ctl group ls` |
| `nas_system_info` | read | `kind: identity / update_status` → `ctl os …`；`fan / beep / cpu / led / zram / power / ups` → `ctl hardware …` |
| `nas_user_create` | admin | `ctl user create USERNAME --password-stdin` |
| `nas_group_add_member` | admin | `ctl group add-member GID UID:NAME...` |

### 6.9 network（1）与 taskmgr（1）

| 工具 | 风险 | 映射 |
|---|---|---|
| `nas_network_info` | read | `kind: interfaces` → `network iface ls`；`general` → `network general` |
| `nas_performance` | read | `kind: overview / cpu / gpu / mem / net / disk / volume` → `taskmgr <kind>`；`processes / services` → `taskmgr process ls` / `service ls` |

每个工具的具体参数以实现时 `unc <命令> --help` 的输出为准，在实施计划里逐个列出。

## 7. 输出与错误

### 7.1 成功

- 返回一个文本内容块，内容是 `unc` 的 JSON 信封。
- 两段式确认的第一步返回 5.4 中的结构。
- 有 `followUp` 的工具在结果里附带 `next_step` 字段。例如 Compose 生命周期操作附「该操作是异步的，用 `nas_docker_projects` 轮询确认」。
- 超过字符上限时截断，并附 `truncated: true` 和缩小范围的建议。
- `nas_app_list` 默认做字段精简（实测 `app ls` 原始输出约 28 万字符）：每个应用只留 ID、名称、安装状态、已装版本、可用版本。要完整信息用 `nas_app_get`。其余工具原样返回。

### 7.2 失败

返回 `isError: true`，内容为：

```json
{ "error": "…unc 给出的原文…",
  "error_detail": { }, "compatibility_hint": { }, "warnings": [ ],
  "hint": "server 给出的下一步建议" }
```

`error_detail`、`compatibility_hint`、`warnings` 仅在 `unc` 提供时出现。多目标命令部分失败时另带 `result` 字段，内容是 `unc` 的完整信封，agent 可逐项看 `items[]` 里哪些成功、哪些失败。`hint` 的判定：

| 情形 | `hint` 的要点 |
|---|---|
| 找不到 `unc` | 请用户安装绿联官方 `unc`，或设置 `UGREEN_MCP_UNC_BIN` |
| 未登录 | 请用户在客户端配置里设置 `UNC_NAS_URL` 与 `UNC_NAS_TOKEN`，或在终端执行 `unc auth login` |
| HTTP 401 | 令牌失效，请用户重新登录或更换令牌；不要重试 |
| HTTP 403 | 令牌缺少该方法的权限节点，请用户新建带对应权限的令牌；不要换命令绕过 |
| HTTP 429 | 触发限流，等几秒后用同样的参数重试 |
| 有 `error_detail` 或 `compatibility_hint` | 该功能在这台 NAS 上不可用，停止重试，可调 `nas_status` 带 `doctor: true` 查看 |
| 超时 | 缩小范围或调大 `timeout_seconds` |
| 权限级别不足、路径不在白名单内 | 说明是 server 的策略限制，以及用户该改哪个环境变量 |

优先看结构化字段，其次才匹配 `HTTP 4xx` 这类稳定的片段。

### 7.3 给 agent 的说明

server 的 `instructions`（英文，简短）承载跨工具的通用规矩：

- 文件路径从共享文件夹或个人文件夹开始，卷根 `/volume1` 不可访问，不知道路径时先调 `nas_file_roots`。
- ID、路径、任务号只能来自工具返回，不得编造。
- 64 位整数字段是字符串。
- 异步操作返回成功只表示已受理，要查询确认。
- 写操作失败后不要自动重试，先查当前状态。
- 需要确认码的调用，先把预演结果告诉用户。

单个工具特有的坑写在该工具的描述里。全部文案自行撰写，不照搬绿联 Skill 的原文。

## 8. 测试

| 层 | 内容 | 是否需要 NAS |
|---|---|---|
| 单元测试（vitest） | 每个工具的 `build` 产出的参数列表；`risk`；`policy` 的级别、工具组、白名单规范化、本机目录判断；`confirm` 的签发、过期、参数不符、重复使用；`output` 的脱敏、截断、`hint` 判定；`config` 的解析与报错 | 否 |
| 集成测试 | 用一个假的 `unc` 脚本（记录收到的参数并返回预置 JSON），经 SDK 的客户端通过 stdio 连接 server，验证工具注册数量随级别变化、只读调用、两段式确认全流程、超级别调用被拒 | 否 |
| 真机验证（手动） | 在真实 NAS 上逐个调用只读工具；`write` 与 `admin` 工具只走到预演 | 是 |

真机上的真实写入测试不在默认范围内，需要用户单独同意。

## 9. 项目与开源

```
ugreen-nas-mcp/
├─ package.json          bin: ugreen-nas-mcp，engines: node >= 20
├─ tsconfig.json
├─ LICENSE               MIT，版权人写 ugreen-nas-mcp contributors
├─ README.md             中文
├─ README.en.md          英文
├─ .gitignore
├─ .github/workflows/ci.yml   安装、构建、测试
├─ src/                  见第 4 节
├─ test/
└─ docs/
```

README 包含：非官方声明（与绿联无关联，UGREEN 是其所有者的商标）、前置条件（安装 `unc`、在 NAS 控制面板创建访问令牌）、各客户端的配置片段、全部环境变量、工具清单与风险级别、权限模型及其局限、常见问题。

运行时依赖只有 `@modelcontextprotocol/sdk` 与 `zod`。
