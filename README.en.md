# ugreen-nas-mcp

[中文](README.md) | English

Manage your own UGREEN NAS from any AI client that speaks MCP: Claude Desktop, Claude Code, Cursor, WorkBuddy, Codex and others.

> **Unofficial project.** It is not affiliated with UGREEN; UGREEN is a trademark of its owner. It works through `unc`, the command-line tool UGREEN publishes, and neither contains nor distributes `unc`.

## How it works

```
MCP client ⇄ stdio ⇄ ugreen-nas-mcp ──▶ unc (official UGREEN CLI) ──HTTPS──▶ your NAS
```

The server does two things: it maps `unc` commands to MCP tools with validated parameters, and it puts a permission boundary that you control in between. It does not read, store or echo your access token.

## Requirements

1. **Node.js 20 or later.**
2. **`unc` installed**, the official command-line tool for the UGOS Pro open CLI. Install it as described by UGREEN. `unc version` in a terminal should print a version. On Windows a real `unc.exe` is required; `.cmd` and `.bat` wrapper scripts are not supported.
3. **An access token**, created in the NAS control panel; it starts with `ugpoa_v1.`. Select the permission nodes you need when creating it: a token can only call the methods it was granted, and its permissions cannot be changed afterwards. Installing and uninstalling apps needs a token issued by an administrator.

## Quick start

### Step 1: let `unc` reach the NAS

Pick one.

**Option A (recommended): log in once in a terminal.** The token stays in `unc`'s own local cache and never appears in an MCP configuration file.

```bash
unc auth login --host https://192.168.1.10:9443 --token 'ugpoa_v1.***'
```

**Option B: environment variables in the MCP configuration.** Set `UNC_NAS_URL` and `UNC_NAS_TOKEN` as shown below. The token then sits in that file in plain text.

Only `https://` addresses work. A LAN address needs its port (usually `9443`); a UGLink address such as `https://ug.link/your-id` works too.

### Step 2: add the server to your client

**Claude Desktop, Cursor, WorkBuddy and other clients that use an `mcpServers` block:**

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

If you logged in with option A, drop the whole `env` block.

**Claude Code:**

```bash
claude mcp add ugreen-nas -- npx -y ugreen-nas-mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ugreen-nas]
command = "npx"
args = ["-y", "ugreen-nas-mcp"]
```

### Running from source

```bash
git clone https://github.com/Mrgaols/ugreen-nas-mcp.git
cd ugreen-nas-mcp
npm install
npm run build
```

Then use `"command": "node"` and `"args": ["/absolute/path/ugreen-nas-mcp/dist/index.js"]` in the configuration.

### Step 3: try it

Ask the agent "how healthy are the disks in my NAS?" or "is my NAS under load right now?". If something does not connect, have it call `nas_status`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `UNC_NAS_URL` | none | NAS address. A variable of `unc` itself; the server passes it through |
| `UNC_NAS_TOKEN` | none | Access token. Same; when unset, `unc` uses the login cached by `unc auth login` |
| `UGREEN_MCP_ACCESS` | `read` | Access level: `read`, `write` or `admin` |
| `UGREEN_MCP_TOOLSETS` | all | Enabled toolsets, comma-separated: `file,search,docker,download,app,storage,ctl,network,taskmgr` |
| `UGREEN_MCP_ALLOWED_PATHS` | unrestricted | NAS folders the server may touch, comma-separated, e.g. `/volume1/docs,/home/alice` |
| `UGREEN_MCP_LOCAL_DIR` | unset | Local directory uploads and downloads may use. Without it the transfer tools do not exist |
| `UGREEN_MCP_UNC_BIN` | auto | Full path to `unc`. By default `PATH` is searched, then `~/.local/bin/unc` |
| `UGREEN_MCP_MAX_OUTPUT_CHARS` | `60000` | Maximum characters returned per call. A longer result comes back as `{"truncated": true, "partial": "…"}`, where `partial` is its beginning |

## Permission model

Out of the box the server is read-only. An agent can only change things after you allow it in the configuration.

### Access levels

| Level | What it allows | Tools |
|---|---|---|
| `read` (default) | Read-only queries | 25 |
| `write` | Adds operations that only add, never overwrite and never interrupt a service: create folders and new files, copy, restore from the recycle bin, tag files, create and pause download tasks, pull images | 33 (35 with a local directory) |
| `admin` | Adds delete, move, overwrite, quotas, starting and stopping containers and apps, creating and deleting Compose projects, installing and uninstalling apps, creating users | 45 (47 with a local directory) |

Tools above the configured level are not registered, so the agent cannot see or call them. For some tools the risk depends on the arguments: `nas_file_copy` is `write` by default and `admin` with `on_conflict: "replace"`.

### Two-step confirmation

Every `admin` call takes two steps:

1. The first call is a preview (`unc --dry-run`). It returns the preview and a confirmation token; nothing changes on the NAS.
2. The second call, with the same arguments plus the token, executes.

A token works once, expires after 5 minutes and is bound to the arguments: change any argument and it is no longer valid.

### Path allowlist

With `UGREEN_MCP_ALLOWED_PATHS` set, every path used by the `file` and `search` toolsets must lie inside those folders, and so must the target folder of `nas_download_create` and the folder checked by `nas_docker_check`. Calls that could otherwise omit a path, such as listing the personal folder, must then name one.

### Local transfer directory

`nas_file_upload` and `nas_file_download` exist only when `UGREEN_MCP_LOCAL_DIR` is set, and can only read and write files inside that directory. Symbolic links are resolved, so they cannot be used to escape it, and a download target that is itself a symbolic link is refused. The agent therefore cannot use these tools to read or overwrite other files on your computer.

## Limitations

Read this before raising the access level.

- **A confirmation token is not your consent.** It guarantees that a preview ran first and that what executes is what was previewed. An agent can complete both steps on its own. The human check is your MCP client's tool approval prompt. These tools carry `destructiveHint`; do not auto-approve them.
- **The path allowlist compares strings.** It cannot see symbolic links on the NAS. A path cannot contain a comma.
- **The path allowlist does not constrain `admin` operations of the docker and app toolsets.** Creating a Compose project can mount any folder. If you do not need those toolsets, switch them off with `UGREEN_MCP_TOOLSETS`.
- **The token has the final say.** The server's limits are a second line of defence. Create tokens with the least permissions that do the job: for queries, grant read-only nodes only.
- One server process talks to one NAS. For several, configure several servers with their own environment variables.
- What works depends on the NAS system version. When a feature is not available on your device the tool says so; `nas_status` with `doctor: true` shows the details.

## Tools

47 in total. The risk column is the lowest level the tool needs; "→ admin" means some arguments raise it to `admin`.

### Core

| Tool | Risk | What it does |
|---|---|---|
| `nas_status` | read | Login state, `unc` version, the server's current policy; optional full health report |

### file

| Tool | Risk | What it does |
|---|---|---|
| `nas_file_roots` | read | List accessible shared folders; start here when you do not know a path |
| `nas_file_list` | read | List a folder; without a path, the personal folder |
| `nas_file_read` | read | Read part of a file |
| `nas_file_stat` | read | Type, size and timestamps |
| `nas_file_find` | read | Find entries under folders by name, kind, size or time |
| `nas_file_usage` | read | Space used by folders, or a folder's quota |
| `nas_file_checksum` | read | MD5 or SHA-256 |
| `nas_file_tags` | read | List tags, tags of files, files with a tag |
| `nas_file_mkdir` | write | Create folders |
| `nas_file_create` | write | Create a new file; fails if it exists |
| `nas_file_copy` | write → admin | Copy into an existing folder; replacing an existing name is admin |
| `nas_file_restore` | write | Restore from the recycle bin |
| `nas_file_tag_edit` | write → admin | Create and apply tags; removing tags is admin |
| `nas_file_upload` | write → admin | Upload a local file; needs the local directory; replacing is admin |
| `nas_file_download` | write | Download a NAS file to this computer; needs the local directory |
| `nas_file_move` | admin | Move or rename |
| `nas_file_delete` | admin | Delete; goes to the recycle bin by default |
| `nas_file_write` | admin | Overwrite or append to an existing file |
| `nas_file_quota_set` | admin | Set a folder quota |

### search

| Tool | Risk | What it does |
|---|---|---|
| `nas_search_files` | read | Search the whole NAS by file name |
| `nas_search_results` | read | Page through, cancel or release a search |

### docker

| Tool | Risk | What it does |
|---|---|---|
| `nas_docker_containers` | read | Containers with CPU, memory and ports |
| `nas_docker_images` | read | Local images, or search the registry |
| `nas_docker_projects` | read | Compose projects |
| `nas_docker_logs` | read | Recent log of a container or project |
| `nas_docker_check` | read | Pre-deployment checks for port, folder and GPU use |
| `nas_docker_app_usage` | read | Resource use of app-center Docker apps |
| `nas_docker_pull` | write | Pull an image |
| `nas_docker_container_control` | admin | Start, stop or restart containers |
| `nas_docker_project_control` | admin | Start, stop, restart or delete a Compose project |
| `nas_docker_project_create` | admin | Create a Compose project from YAML |
| `nas_docker_app_rebuild` | admin | Rebuild an app-center container app |

### download

| Tool | Risk | What it does |
|---|---|---|
| `nas_download_list` | read | Download tasks and progress |
| `nas_download_create` | write | Have the NAS download a link |
| `nas_download_control` | write → admin | Pause, resume, retry; removing tasks or acting on all tasks is admin |

### app

| Tool | Risk | What it does |
|---|---|---|
| `nas_app_list` | read | List or search apps (compact output) |
| `nas_app_get` | read | Details of one app, or install and run state |
| `nas_app_manage` | admin | Install, update, uninstall, start or stop apps |

### storage

| Tool | Risk | What it does |
|---|---|---|
| `nas_storage_info` | read | State and capacity of disks, pools and volumes |
| `nas_storage_smart` | admin | Raw SMART data of the disks (read-only, but sensitive diagnostics) |

### ctl

| Tool | Risk | What it does |
|---|---|---|
| `nas_users` | read | Users or groups |
| `nas_system_info` | read | System version, update state, fan, power, UPS and similar settings |
| `nas_user_create` | admin | Create a user |
| `nas_group_add_member` | admin | Add members to a group |

### network and taskmgr

| Tool | Risk | What it does |
|---|---|---|
| `nas_network_info` | read | Interfaces, IP, gateway, DNS, proxy |
| `nas_performance` | read | Live CPU, memory, network and disk load; per-process and per-service use |

Not provided: login and token management, creating shared folders, changing file permissions (ACL), changing network or hardware settings, system updates, creating or deleting storage pools. Use the NAS web interface for those.

## Troubleshooting

**`unc` is not found.** Check that `unc version` runs in a terminal. Desktop clients do not always inherit your shell's `PATH`; set `UGREEN_MCP_UNC_BIN` to the full path.

**401.** The token is invalid or expired. Log in again or use a new token.

**403.** Either the path is not inside a shared folder you can access (a volume root such as `/volume1` is never accessible), or the token lacks the permission node for that method. The second case needs a new token, because the permissions of an existing one cannot be changed.

**"Not available on this NAS".** The package is not installed, not running, or the system version does not support it yet. Retrying does not help; have the agent call `nas_status` with `doctor: true`.

**`context deadline exceeded`, or a command timed out.** The NAS did not answer in time. For a query, narrow the request or raise the tool's `timeout_seconds` (listing, finding, checksums, uploads and downloads have it). If the call changes something, it may have been applied on the NAS anyway: check the current state first instead of repeating it.

**The client complains about too many tools.** Keep only the toolsets you need with `UGREEN_MCP_TOOLSETS`, for example `file,storage,taskmgr`.

**A configuration change has no effect.** Environment variables are read when the server starts. Restart the client or reconnect the server.

## Development

```bash
npm install
npm test            # builds and runs all tests; no NAS needed
npm run live-check  # calls the read-only tools against a real NAS; changes nothing
```

`live-check` only calls read-only tools and the preview step of `admin` tools; it never sends a confirmation token.

## License

[MIT](LICENSE)
