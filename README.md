# ugreen-nas-mcp

中文 | [English](README.en.md)

让任意支持 MCP 的 AI 客户端（Claude Desktop、Claude Code、Cursor、WorkBuddy、Codex 等）管理你自己的绿联 NAS。

> **非官方项目。** 本项目与绿联（UGREEN）没有关联，UGREEN 是其所有者的商标。它通过绿联官方发布的 `unc` 命令行工具工作，不包含也不分发 `unc`。

## 工作方式

```
MCP 客户端 ⇄ stdio ⇄ ugreen-nas-mcp ──▶ unc（绿联官方 CLI）──HTTPS──▶ 你的 NAS
```

server 只做两件事：把 `unc` 的命令映射成带参数校验的 MCP 工具，并在中间加一层你能控制的权限边界。它不读、不存、不回显你的访问令牌。

## 前置条件

1. **Node.js 20 或更高。**
2. **已安装 `unc`**（绿联 UGOS Pro 开放 CLI 的官方命令行工具），按绿联官方说明安装。装好后在终端运行 `unc version` 应能看到版本号。
3. **一个访问令牌**，在 NAS 的控制面板里创建，以 `ugpoa_v1.` 开头。创建时按需勾选权限节点：令牌只能调用被授权的方法，且创建后权限不能修改。应用的安装与卸载需要管理员签发的令牌。

## 快速开始

### 第一步：让 `unc` 能连上 NAS

两种方式任选其一。

**方式 A（推荐）：在终端登录一次。** 令牌只保存在 `unc` 自己的本机缓存里，MCP 配置文件中不出现令牌。

```bash
unc auth login --host https://192.168.1.10:9443 --token 'ugpoa_v1.***'
```

**方式 B：在 MCP 配置里用环境变量。** 设置 `UNC_NAS_URL` 和 `UNC_NAS_TOKEN`（见下方示例）。注意这样令牌会以明文留在配置文件里。

NAS 地址只支持 `https://`。局域网地址要带端口（通常是 `9443`），也可以用 UGLink 地址，如 `https://ug.link/your-id`。

### 第二步：在客户端里添加 server

**Claude Desktop、Cursor、WorkBuddy 等使用 `mcpServers` 配置的客户端：**

```json
{
  "mcpServers": {
    "ugreen-nas": {
      "command": "npx",
      "args": ["-y", "ugreen-nas-mcp"],
      "env": {
        "UNC_NAS_URL": "https://192.168.1.10:9443",
        "UNC_NAS_TOKEN": "ugpoa_v1.***"
      }
    }
  }
}
```

用方式 A 登录过的话，去掉整个 `env` 即可。

**Claude Code：**

```bash
claude mcp add ugreen-nas -- npx -y ugreen-nas-mcp
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.ugreen-nas]
command = "npx"
args = ["-y", "ugreen-nas-mcp"]
```

### 从源码运行

```bash
git clone <本仓库地址>
cd ugreen-nas-mcp
npm install
npm run build
```

然后把配置里的命令换成 `"command": "node"`、`"args": ["/绝对路径/ugreen-nas-mcp/dist/index.js"]`。

### 第三步：试一下

对 agent 说「看看我 NAS 的硬盘健康状况」或「我的 NAS 现在卡不卡」。连接有问题时让它调用 `nas_status`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `UNC_NAS_URL` | 无 | NAS 地址。`unc` 自己的变量，server 原样传给它 |
| `UNC_NAS_TOKEN` | 无 | 访问令牌。同上；不设则使用 `unc auth login` 的本机缓存 |
| `UGREEN_MCP_ACCESS` | `read` | 访问级别：`read`、`write` 或 `admin` |
| `UGREEN_MCP_TOOLSETS` | 全部 | 启用的工具组，逗号分隔：`file,search,docker,download,app,storage,ctl,network,taskmgr` |
| `UGREEN_MCP_ALLOWED_PATHS` | 不限 | 允许访问的 NAS 文件夹，逗号分隔，如 `/volume1/docs,/home/alice` |
| `UGREEN_MCP_LOCAL_DIR` | 未设 | 上传、下载可以读写的本机目录。不设则没有上传、下载工具 |
| `UGREEN_MCP_UNC_BIN` | 自动查找 | `unc` 的完整路径。默认先找 `PATH`，再找 `~/.local/bin/unc` |
| `UGREEN_MCP_MAX_OUTPUT_CHARS` | `60000` | 单次返回的字符上限，超出部分截断 |

## 权限模型

开箱是只读的。要让 agent 能改东西，必须由你在配置里显式放开。

### 访问级别

| 级别 | 允许的操作 | 工具数 |
|---|---|---|
| `read`（默认） | 只读查询 | 25 |
| `write` | 另加「只新增、不覆盖、不中断服务」的操作：建目录、建新文件、复制、从回收站恢复、打标签、创建和暂停下载任务、拉取镜像 | 33（配置了本机目录时 35） |
| `admin` | 另加删除、移动、覆盖、改配额、启停容器与应用、创建和删除 Compose 项目、安装和卸载应用、创建用户 | 44（配置了本机目录时 46） |

超出当前级别的工具不会注册，agent 看不到也调不了。有些工具的风险取决于参数，例如 `nas_file_copy` 默认属于 `write`，带 `on_conflict: "replace"` 就属于 `admin`。

### 两段式确认

所有 `admin` 级的调用分两步：

1. 第一次调用只做预演（`unc --dry-run`），返回预演结果和一个确认码，NAS 上什么都不变。
2. 第二次调用带上同样的参数和确认码，才真正执行。

确认码一次有效、5 分钟过期，并且与参数绑定：改动任何一个参数，确认码就失效。

### 路径白名单

设置 `UGREEN_MCP_ALLOWED_PATHS` 后，`file` 和 `search` 两组工具的所有路径都必须落在这些文件夹内，`nas_download_create` 的保存目录也一样。原本可以不给路径的调用（如列出个人文件夹）此时必须显式给出路径。

### 本机传输目录

`nas_file_upload` 和 `nas_file_download` 只有在设置了 `UGREEN_MCP_LOCAL_DIR` 后才存在，而且只能读写这个目录里的文件（会解析符号链接，防止绕出目录）。这样 agent 无法借它读取或覆盖你电脑上的其他文件。

## 局限

请在放开权限之前读完这一节。

- **确认码不等于你本人同意。** 它保证的是「必须先预演，且执行的就是预演过的那一份」。agent 可以自己走完两步。真正由人把关的是 MCP 客户端的工具审批弹窗，这些工具都标注了 `destructiveHint`，请不要对它们开启自动批准。
- **路径白名单是字符串判断。** 它无法识别 NAS 上的符号链接。路径本身不能含英文逗号。
- **路径白名单不约束 docker 和 app 两组的 `admin` 操作。** 例如创建 Compose 项目可以挂载任意目录。不需要这些能力时，用 `UGREEN_MCP_TOOLSETS` 把这两组关掉。
- **最终的权限由令牌决定。** server 的限制是第二道防线。请按最小权限创建令牌：只做查询就只勾只读节点。
- 一个 server 进程只连一台 NAS。多台 NAS 请配置多条 server，各自设置环境变量。
- 能做什么取决于 NAS 的系统版本。某个功能在你的设备上不可用时，工具会如实返回，可用 `nas_status` 加 `doctor: true` 查看细节。

## 工具清单

共 46 个。风险一栏是该工具的最低级别；标注「→ admin」的表示某些参数会把它提升到 `admin`。

### 核心

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_status` | read | 登录状态、`unc` 版本、server 当前策略；可选完整体检 |

### file

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_file_roots` | read | 列出可访问的共享文件夹，不知道路径时从这里开始 |
| `nas_file_list` | read | 列目录；省略路径列个人文件夹 |
| `nas_file_read` | read | 读取文件的一段内容 |
| `nas_file_stat` | read | 类型、大小、时间等元数据 |
| `nas_file_find` | read | 按名称、类型、大小、时间在目录下查找 |
| `nas_file_usage` | read | 目录占用空间，或目录配额 |
| `nas_file_checksum` | read | MD5 或 SHA-256 |
| `nas_file_tags` | read | 查询标签、文件的标签、带某标签的文件 |
| `nas_file_mkdir` | write | 新建目录 |
| `nas_file_create` | write | 新建文件，目标已存在则失败 |
| `nas_file_copy` | write → admin | 复制到已有目录；覆盖同名文件属于 admin |
| `nas_file_restore` | write | 从回收站恢复 |
| `nas_file_tag_edit` | write → admin | 新建标签、打标签；删除标签属于 admin |
| `nas_file_upload` | write → admin | 本机文件上传到 NAS，需本机目录；覆盖属于 admin |
| `nas_file_download` | write | NAS 文件下载到本机，需本机目录 |
| `nas_file_move` | admin | 移动或重命名 |
| `nas_file_delete` | admin | 删除，默认进回收站 |
| `nas_file_write` | admin | 覆盖或追加已有文件 |
| `nas_file_quota_set` | admin | 设置目录配额 |

### search

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_search_files` | read | 全局按文件名搜索 |
| `nas_search_results` | read | 翻页、取消或释放一次搜索 |

### docker

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_docker_containers` | read | 容器列表，含 CPU、内存、端口 |
| `nas_docker_images` | read | 本地镜像，或搜索镜像仓库 |
| `nas_docker_projects` | read | Compose 项目列表 |
| `nas_docker_logs` | read | 容器或项目的最近日志 |
| `nas_docker_check` | read | 部署前检查端口、目录、独显占用 |
| `nas_docker_app_usage` | read | 应用中心 Docker 应用的资源占用 |
| `nas_docker_pull` | write | 拉取镜像 |
| `nas_docker_container_control` | admin | 启动、停止、重启容器 |
| `nas_docker_project_control` | admin | 启动、停止、重启、删除 Compose 项目 |
| `nas_docker_project_create` | admin | 用 YAML 创建 Compose 项目 |
| `nas_docker_app_rebuild` | admin | 重建应用中心的容器应用 |

### download

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_download_list` | read | 下载任务与进度 |
| `nas_download_create` | write | 让 NAS 下载一个链接 |
| `nas_download_control` | write → admin | 暂停、继续、重试；移除任务或作用于全部任务属于 admin |

### app

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_app_list` | read | 应用列表或搜索（精简输出） |
| `nas_app_get` | read | 单个应用详情，或安装与运行状态 |
| `nas_app_manage` | admin | 安装、更新、卸载、启动、停止应用 |

### storage

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_storage_info` | read → admin | 磁盘、存储池、存储卷；SMART 原始数据属于 admin |

### ctl

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_users` | read | 用户或群组列表 |
| `nas_system_info` | read | 系统版本、更新状态、风扇、电源、UPS 等设置 |
| `nas_user_create` | admin | 创建用户 |
| `nas_group_add_member` | admin | 向群组添加成员 |

### network 与 taskmgr

| 工具 | 风险 | 说明 |
|---|---|---|
| `nas_network_info` | read | 网卡、IP、网关、DNS、代理 |
| `nas_performance` | read | CPU、内存、网络、磁盘实时负载，进程与服务占用 |

不提供的操作：登录与令牌管理、创建共享文件夹、修改文件权限（ACL）、修改网络和硬件设置、系统更新、创建或删除存储池。这些请在 NAS 的管理界面完成。

## 常见问题

**提示找不到 `unc`。** 先在终端确认 `unc version` 能运行。图形界面的客户端启动时不一定带上你 shell 的 `PATH`，这时用 `UGREEN_MCP_UNC_BIN` 指定完整路径。

**返回 401。** 令牌无效或已过期，重新登录或更换令牌。

**返回 403。** 分两种情况：访问的路径不在你有权限的共享文件夹里（卷根 `/volume1` 本身不可访问），或者令牌没有勾选这个方法的权限节点。后一种需要在 NAS 上新建令牌，因为已有令牌的权限改不了。

**提示功能在这台 NAS 上不可用。** 对应的套件没装、没运行，或系统版本还不支持。重试没有用，让 agent 调用 `nas_status` 并带 `doctor: true` 看具体原因。

**客户端提示工具太多。** 用 `UGREEN_MCP_TOOLSETS` 只保留需要的工具组，例如 `file,storage,taskmgr`。

**改了配置不生效。** 环境变量只在 server 启动时读取，修改后需要重启客户端或重新连接 server。

## 开发

```bash
npm install
npm test            # 构建并运行全部测试，不需要 NAS
npm run live-check  # 在真实 NAS 上逐个调用只读工具，不做任何修改
```

`live-check` 只调用只读工具和 `admin` 工具的预演步骤，不发送确认码。

## 许可证

[MIT](LICENSE)
