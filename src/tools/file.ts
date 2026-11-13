import { z } from 'zod';
import { sizeFilter, timeoutSeconds, unixSeconds } from './schemas.js';
import { ToolInputError, cmd, defineTool, opt, streamTimeout, type ToolSpec } from './types.js';

const nasPath = (what: string) => z.string().min(1).describe(`${what} Absolute NAS path, for example /volume1/docs/report.pdf.`);
const nasPaths = (what: string, max: number) =>
  z.array(z.string().min(1)).min(1).max(max).describe(`${what} Absolute NAS paths (1 to ${max}).`);

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

const fileRoots = defineTool({
  name: 'nas_file_roots',
  toolset: 'file',
  title: 'List shared folders',
  description:
    'List the shared folders this NAS account can access. This is the starting point whenever you do not know ' +
    'a path: file access is granted per shared folder, and volume roots such as /volume1 cannot be listed ' +
    'directly. Use the returned paths with the other nas_file_* tools. For the personal folder, call ' +
    'nas_file_list with no path instead.',
  input: {},
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: () => ({ argv: cmd(['file', 'ls-root'], ['--root=shared', '--limit=500']) }),
});

const fileList = defineTool({
  name: 'nas_file_list',
  toolset: 'file',
  title: 'List a folder',
  description:
    'List the entries of a folder on the NAS. Omit path to list the personal folder of the logged-in user. ' +
    'Volume roots such as /volume1 are not accessible; start from a shared folder (see nas_file_roots). ' +
    'Entries are in items[0].entries[]; size and the time fields are strings holding 64-bit integers, and the ' +
    'mode field is unreliable, so do not use it to judge permissions. Recursive listing of a large folder can ' +
    'take a minute or more: prefer a deeper path, or nas_search_files when looking for a file by name.',
  input: {
    path: nasPath('Folder to list.').optional(),
    recursive: z.boolean().default(false).describe('Also list all subfolders. Slow on large folders.'),
    limit: z.number().int().min(0).max(10000).default(200).describe('Maximum number of entries; 0 means no limit.'),
    timeout_seconds: timeoutSeconds(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => (a.path ? [a.path] : []),
  unscoped: (a) => !a.path,
  build: (a) => {
    const st = streamTimeout(a.timeout_seconds);
    return {
      argv: cmd(['file', 'ls'], [opt('recursive', a.recursive), opt('limit', a.limit), st.flag], a.path ? [a.path] : []),
      timeoutMs: st.timeoutMs,
    };
  },
});

const fileRead = defineTool({
  name: 'nas_file_read',
  toolset: 'file',
  title: 'Read part of a file',
  description:
    'Read bytes from a file on the NAS without saving it locally. Returns { path, offset, bytes, encoding, ' +
    'content }: encoding is "utf8" when the bytes are valid UTF-8 text, otherwise "base64". By default the ' +
    'first 64 KiB are read and at most 1 MiB per call; for a longer file call again with offset increased by ' +
    'the bytes already read. A result with fewer bytes than requested means the end of the file was reached. ' +
    'To copy a whole file to this computer use nas_file_download.',
  input: {
    path: nasPath('File to read.'),
    offset: z.number().int().min(0).default(0).describe('Byte offset to start reading at.'),
    length: z.number().int().min(1).max(1048576).default(65536).describe('Number of bytes to read (max 1048576).'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => [a.path],
  build: (a) => ({ argv: cmd(['file', 'cat'], [opt('offset', a.offset), opt('length', a.length)], [a.path]), raw: true }),
  render: (stdout, a) => {
    let content: string;
    let encoding: 'utf8' | 'base64' = 'utf8';
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    } catch {
      content = stdout.toString('base64');
      encoding = 'base64';
    }
    return { path: a.path, offset: a.offset, bytes: stdout.length, encoding, content };
  },
});

const fileStat = defineTool({
  name: 'nas_file_stat',
  toolset: 'file',
  title: 'File or folder metadata',
  description:
    'Get type, size and timestamps for one or more paths. The result always has items[], one per path in the ' +
    'order given; check each item for success, because one missing path does not stop the others. size and the ' +
    'time fields are strings; times are Unix seconds. The mode field is unreliable on existing paths, so do not ' +
    'use it to decide whether something is readable or writable.',
  input: { paths: nasPaths('Paths to inspect.', 50) },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => a.paths,
  build: (a) => ({ argv: cmd(['file', 'stat'], [], a.paths) }),
});

const fileFind = defineTool({
  name: 'nas_file_find',
  toolset: 'file',
  title: 'Find files under folders',
  description:
    'Walk one or more folders and return entries matching the filters. kind selects plain files, folders, or a ' +
    'media category (image, video, audio, archive, doc, font, app). Sizes take a unit suffix such as 10K or 4M. ' +
    'since and until are Unix seconds and need time_field to say which timestamp they apply to. Roots must be ' +
    'shared folders or folders inside them; a volume root is reported as an invalid root. All roots are ' +
    'searched in one request, so matches are in the top-level entries[] of the result, and that key is ' +
    'absent when nothing matched. For finding files by name across a large area, nas_search_files is faster.',
  input: {
    roots: nasPaths('Folders to search in.', 20),
    name: z.string().min(1).optional().describe('File name pattern with * and ?, for example *.jpg.'),
    kind: z
      .enum(['file', 'dir', 'image', 'video', 'audio', 'archive', 'doc', 'font', 'app'])
      .optional()
      .describe('Only plain files, only folders, or only one media category.'),
    min_size: sizeFilter('Smallest file size to include.').optional(),
    max_size: sizeFilter('Largest file size to include.').optional(),
    time_field: z
      .enum(['birth', 'mtime', 'atime', 'dtime'])
      .optional()
      .describe('Timestamp that since/until apply to: creation, modification, access or deletion time.'),
    since: unixSeconds('Only entries at or after this time.').optional(),
    until: unixSeconds('Only entries at or before this time.').optional(),
    max_depth: z.number().int().min(1).optional().describe('How many folder levels to descend; omit for no limit.'),
    limit: z.number().int().min(0).max(10000).default(200).describe('Maximum number of results; 0 means no limit.'),
    timeout_seconds: timeoutSeconds(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => a.roots,
  build: (a) => {
    if ((a.since !== undefined || a.until !== undefined) && !a.time_field) {
      throw new ToolInputError('since and until need time_field to say which timestamp to compare.');
    }
    const kind =
      a.kind === 'file' ? '--type=f' : a.kind === 'dir' ? '--type=d' : a.kind ? `--category=${a.kind}` : undefined;
    const st = streamTimeout(a.timeout_seconds);
    return {
      argv: cmd(
        ['file', 'find'],
        [
          opt('name', a.name),
          kind,
          opt('min-size', a.min_size),
          opt('max-size', a.max_size),
          opt('time', a.time_field),
          opt('since', a.since),
          opt('until', a.until),
          opt('maxdepth', a.max_depth),
          opt('limit', a.limit),
          st.flag,
        ],
        a.roots,
      ),
      timeoutMs: st.timeoutMs,
    };
  },
});

const fileUsage = defineTool({
  name: 'nas_file_usage',
  toolset: 'file',
  title: 'Disk usage and folder quota',
  description:
    'kind "du" reports how much space folders occupy (items[].entries[] with size, dir_count and ' +
    'file_count), optionally broken down to a given depth; it walks the tree and can be slow. kind "quota" reports the size limit set on a personal or shared folder: the value is ' +
    'in MB as a string, and "0" means no quota is set, not a quota of zero. Quotas exist only at the level of a ' +
    'personal or shared folder, not on subfolders or volume roots. For free space on a whole volume use ' +
    'nas_storage_info with kind "volumes".',
  input: {
    kind: z.enum(['du', 'quota']).describe('"du" for space used, "quota" for the configured limit.'),
    paths: nasPaths('Folders to measure.', 20),
    depth: z.number().int().min(1).optional().describe('For "du" only: break usage down this many levels deep.'),
    timeout_seconds: timeoutSeconds(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => a.paths,
  build: (a) => {
    if (a.kind === 'quota') {
      if (a.depth !== undefined) throw new ToolInputError('depth only applies to kind "du".');
      return { argv: cmd(['file', 'quota', 'get'], [], a.paths) };
    }
    const st = streamTimeout(a.timeout_seconds);
    // unc only accepts the depth as a separate `-d N` pair.
    const depth = a.depth !== undefined ? ['-d', String(a.depth)] : [];
    return { argv: cmd(['file', 'du'], [...depth, st.flag], a.paths), timeoutMs: st.timeoutMs };
  },
});

const fileChecksum = defineTool({
  name: 'nas_file_checksum',
  toolset: 'file',
  title: 'File checksum',
  description:
    'Compute the MD5 or SHA-256 checksum of files on the NAS, for example to verify a transfer. The NAS reads ' +
    'each whole file, so large files take a while. The result has items[], one per path; check each for success.',
  input: {
    algorithm: z.enum(['md5', 'sha256']).describe('Checksum algorithm.'),
    paths: nasPaths('Files to hash.', 20),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => a.paths,
  build: (a) => ({
    argv: cmd(['file', a.algorithm === 'md5' ? 'md5sum' : 'sha256sum'], [], a.paths),
    timeoutMs: 300_000,
  }),
});

const fileTags = defineTool({
  name: 'nas_file_tags',
  toolset: 'file',
  title: 'Query file tags',
  description:
    'Query the tag system of the file manager. query "list_tags" returns all tags with their IDs. ' +
    '"tags_of_paths" returns the tags on the given paths (needs paths). "files_by_tag" returns the files that ' +
    'carry the given tags (needs tag_ids from list_tags; optionally limit it to scope_path, with recursive to ' +
    'include subfolders). Tag IDs are numbers taken from list_tags; never guess them.',
  input: {
    query: z.enum(['list_tags', 'tags_of_paths', 'files_by_tag']).describe('Which question to ask.'),
    paths: z.array(z.string().min(1)).min(1).max(50).optional().describe('For "tags_of_paths": the paths to look up.'),
    tag_ids: z.array(z.number().int().min(1)).min(1).max(20).optional().describe('For "files_by_tag": tag IDs.'),
    scope_path: nasPath('For "files_by_tag": only look inside this folder.').optional(),
    recursive: z.boolean().default(false).describe('For "files_by_tag" with scope_path: include subfolders.'),
    timeout_seconds: timeoutSeconds(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => [...(a.paths ?? []), ...(a.scope_path ? [a.scope_path] : [])],
  unscoped: (a) => a.query === 'files_by_tag' && !a.scope_path,
  build: (a) => {
    if (a.recursive && !(a.query === 'files_by_tag' && a.scope_path)) {
      throw new ToolInputError('recursive only applies to "files_by_tag" together with scope_path.');
    }
    if (a.query === 'list_tags') return { argv: cmd(['file', 'tag', 'list']) };
    if (a.query === 'tags_of_paths') {
      if (!a.paths) throw new ToolInputError('"tags_of_paths" needs paths.');
      return { argv: cmd(['file', 'tag', 'file', 'get'], [], a.paths) };
    }
    if (!a.tag_ids) throw new ToolInputError('"files_by_tag" needs tag_ids (take them from query "list_tags").');
    const st = streamTimeout(a.timeout_seconds);
    return {
      argv: cmd(
        ['file', 'tag', 'file', 'list'],
        [opt('path', a.scope_path), opt('recursive', a.recursive), st.flag],
        a.tag_ids.map(String),
      ),
      timeoutMs: st.timeoutMs,
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Write: additive operations that never overwrite or delete
// ---------------------------------------------------------------------------------------------

const onConflict = z.enum(['rename', 'skip', 'replace']);
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const fileMkdir = defineTool({
  name: 'nas_file_mkdir',
  toolset: 'file',
  title: 'Create folders',
  description:
    'Create one or more folders on the NAS. Set parents to also create missing parent folders. Folders can only ' +
    'be created inside a shared folder or the personal folder, not directly under a volume root. This does not ' +
    'create a new shared folder; that has to be done in the NAS web interface. The result has items[], one per ' +
    'path; check each for success.',
  input: {
    paths: nasPaths('Folders to create.', 20),
    parents: z.boolean().default(false).describe('Create missing parent folders as well.'),
  },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  nasPaths: (a) => a.paths,
  build: (a) => ({ argv: cmd(['file', 'mkdir'], [opt('parents', a.parents)], a.paths) }),
});

const fileCreate = defineTool({
  name: 'nas_file_create',
  toolset: 'file',
  title: 'Create a new file',
  description:
    'Create a new file on the NAS with the given content. It fails if the path already exists and never ' +
    'overwrites; to change an existing file use nas_file_write. Content is limited to 100000 bytes; for larger ' +
    'or existing local files use nas_file_upload. Set base64 to true to write binary content given as Base64.',
  input: {
    path: nasPath('File to create.'),
    content: z
      .string()
      .default('')
      .refine((s) => utf8Bytes(s) <= 100_000, 'content must be at most 100000 bytes; use nas_file_upload for larger files')
      .describe('Text content, or Base64 when base64 is true. Empty creates an empty file.'),
    base64: z.boolean().default(false).describe('Treat content as Base64 and write the decoded bytes.'),
  },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  nasPaths: (a) => [a.path],
  build: (a) => ({
    argv: cmd(
      ['file', 'touch'],
      ['--exclusive', a.content.length > 0 ? opt('content', a.content) : undefined, a.content.length > 0 && opt('base64', a.base64)],
      [a.path],
    ),
  }),
});

const fileCopy = defineTool({
  name: 'nas_file_copy',
  toolset: 'file',
  title: 'Copy a file or folder',
  description:
    'Copy one file or folder into an existing folder, keeping its name. destination_dir must be a folder that ' +
    'already exists; it must not include a new file name. To copy and rename, copy first and then rename the ' +
    'copy with nas_file_move. on_conflict decides what happens when the name is taken: "rename" (default) keeps ' +
    'both, "skip" leaves the existing one, "replace" overwrites it and therefore needs admin access and a ' +
    'confirmation.',
  input: {
    source: nasPath('File or folder to copy.'),
    destination_dir: nasPath('Existing folder to copy into.'),
    on_conflict: onConflict.default('rename').describe('What to do when the name already exists in the destination.'),
  },
  minRisk: 'write',
  maxRisk: 'admin',
  risk: (a) => (a.on_conflict === 'replace' ? 'admin' : 'write'),
  nasPaths: (a) => [a.source, a.destination_dir],
  build: (a) => ({ argv: cmd(['file', 'cp'], [opt('on-conflict', a.on_conflict)], [a.source, a.destination_dir]) }),
});

const fileRestore = defineTool({
  name: 'nas_file_restore',
  toolset: 'file',
  title: 'Restore from the recycle bin',
  description:
    'Restore deleted items to their original location. Pass the path inside the recycle bin, which is the ' +
    'receipt.final_path returned by nas_file_delete (for example /home/alice/#recycle/a.txt). The recycle bin ' +
    'is flat: items sit directly in #recycle under their original name, so if the path was not recorded, list ' +
    'that folder with nas_file_list. Passing the original path instead restores nothing.',
  input: { recycle_paths: nasPaths('Paths inside a #recycle folder.', 20) },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  nasPaths: (a) => a.recycle_paths,
  build: (a) => ({ argv: cmd(['file', 'recover-recycle'], [], a.recycle_paths) }),
});

const fileTagEdit = defineTool({
  name: 'nas_file_tag_edit',
  toolset: 'file',
  title: 'Create, apply or remove tags',
  description:
    'Change tags. action "create_tag" makes a new tag (needs name; color is optional, #RRGGBB). "tag_files" ' +
    'puts one tag on the given paths (needs tag_id and paths). "untag_files" removes one tag from the given ' +
    'paths, and "delete_tags" deletes tags entirely (needs tag_ids); both of these need admin access and a ' +
    'confirmation. Tag IDs come from nas_file_tags with query "list_tags".',
  input: {
    action: z.enum(['create_tag', 'tag_files', 'delete_tags', 'untag_files']).describe('What to change.'),
    name: z.string().min(1).optional().describe('For "create_tag": the tag name.'),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB')
      .optional()
      .describe('For "create_tag": colour as #RRGGBB. A default blue is used when omitted.'),
    tag_id: z.number().int().min(1).optional().describe('For "tag_files" and "untag_files": the tag.'),
    tag_ids: z.array(z.number().int().min(1)).min(1).max(20).optional().describe('For "delete_tags": the tags to delete.'),
    paths: z.array(z.string().min(1)).min(1).max(50).optional().describe('For "tag_files" and "untag_files": the paths.'),
  },
  minRisk: 'write',
  maxRisk: 'admin',
  risk: (a) => (a.action === 'delete_tags' || a.action === 'untag_files' ? 'admin' : 'write'),
  nasPaths: (a) => (a.action === 'tag_files' || a.action === 'untag_files' ? (a.paths ?? []) : []),
  build: (a) => {
    switch (a.action) {
      case 'create_tag':
        if (!a.name) throw new ToolInputError('"create_tag" needs name.');
        return { argv: cmd(['file', 'tag', 'add'], [opt('color', a.color ?? '#4C8BF5')], [a.name]) };
      case 'delete_tags':
        if (!a.tag_ids) throw new ToolInputError('"delete_tags" needs tag_ids.');
        return { argv: cmd(['file', 'tag', 'delete'], [], a.tag_ids.map(String)) };
      default: {
        if (a.tag_id === undefined || !a.paths) throw new ToolInputError(`"${a.action}" needs tag_id and paths.`);
        const verb = a.action === 'tag_files' ? 'add' : 'delete';
        return { argv: cmd(['file', 'tag', 'file', verb], [], [String(a.tag_id), ...a.paths]) };
      }
    }
  },
});

function requireLocal(ctx: { localPath?: string }): string {
  if (!ctx.localPath) throw new Error('local path was not resolved');
  return ctx.localPath;
}

const fileUpload = defineTool({
  name: 'nas_file_upload',
  toolset: 'file',
  title: 'Upload a local file to the NAS',
  description:
    'Send a file from this computer to the NAS. local_path must be inside the local transfer directory the user ' +
    'configured for this server; other local files cannot be read. End remote_path with "/" to put the file ' +
    'into that folder under its own name, or give a full target path. If the name exists, the default "rename" ' +
    'lets the NAS pick a new name, so read data.stat.path for the final name; "replace" overwrites and needs ' +
    'admin access and a confirmation. There is no resume: a failed upload starts over. Check that ' +
    'data.bytes_written equals the file size. To make the NAS fetch a URL itself, use nas_download_create.',
  input: {
    local_path: z.string().min(1).describe('File inside the local transfer directory, relative to it or absolute.'),
    remote_path: nasPath('Target on the NAS; end with "/" for a folder.'),
    on_conflict: onConflict.default('rename').describe('What to do when the target name already exists.'),
    verify: z.boolean().default(false).describe('Have the NAS verify a SHA-256 of the content before saving.'),
    timeout_seconds: timeoutSeconds(600),
  },
  minRisk: 'write',
  maxRisk: 'admin',
  risk: (a) => (a.on_conflict === 'replace' ? 'admin' : 'write'),
  nasPaths: (a) => [a.remote_path],
  localPath: (a) => ({ path: a.local_path, mode: 'existing-file' }),
  build: (a, ctx) => {
    const st = streamTimeout(a.timeout_seconds);
    return {
      argv: cmd(
        ['file', 'upload'],
        [opt('on-conflict', a.on_conflict), opt('verify', a.verify), st.flag],
        [requireLocal(ctx), a.remote_path],
      ),
      timeoutMs: st.timeoutMs,
    };
  },
});

const fileDownload = defineTool({
  name: 'nas_file_download',
  toolset: 'file',
  title: 'Download a NAS file to this computer',
  description:
    'Copy a file from the NAS to this computer. The file is saved inside the local transfer directory the user ' +
    'configured for this server; local_path is relative to it and defaults to the remote file name. If the ' +
    'local file exists the call fails unless if_exists is "overwrite" or "resume" (continue a partial ' +
    'download). After an interrupted download, call again with "resume" rather than starting over. To only ' +
    'look at text content use nas_file_read. This is not nas_download_create, which makes the NAS download a URL.',
  input: {
    remote_path: nasPath('File on the NAS.'),
    local_path: z.string().min(1).optional().describe('Where to save it inside the local transfer directory.'),
    if_exists: z
      .enum(['fail', 'overwrite', 'resume'])
      .default('fail')
      .describe('What to do when the local file already exists.'),
    timeout_seconds: timeoutSeconds(600),
  },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  nasPaths: (a) => [a.remote_path],
  localPath: (a) => ({
    path: a.local_path ?? a.remote_path.split('/').filter((s) => s.length > 0).pop() ?? 'download',
    mode: 'target',
  }),
  build: (a, ctx) => {
    const st = streamTimeout(a.timeout_seconds);
    const exists = a.if_exists === 'overwrite' ? '--force' : a.if_exists === 'resume' ? '--continue' : undefined;
    return { argv: cmd(['file', 'download'], [exists, st.flag], [a.remote_path, requireLocal(ctx)]), timeoutMs: st.timeoutMs };
  },
});

// ---------------------------------------------------------------------------------------------
// Admin: operations that delete, move or overwrite
// ---------------------------------------------------------------------------------------------

const fileMove = defineTool({
  name: 'nas_file_move',
  toolset: 'file',
  title: 'Move or rename',
  description:
    'Move a file or folder into another folder, or rename it in place. destination is either an existing ' +
    'folder as an absolute path (the item moves there and keeps its name) or a plain new name without "/" ' +
    '(rename in the same folder). A full target path such as /b/new-name.txt is not accepted: to move and ' +
    'rename, do it in two calls. on_conflict decides what happens when the name exists in the destination.',
  input: {
    source: nasPath('File or folder to move or rename.'),
    destination: z.string().min(1).describe('Existing folder (absolute path), or a new name without "/".'),
    on_conflict: onConflict.optional().describe('What to do when the name already exists; omit for the NAS default.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  nasPaths: (a) => (a.destination.includes('/') ? [a.source, a.destination] : [a.source]),
  build: (a) => {
    if (a.destination.includes('/') && !a.destination.startsWith('/')) {
      throw new ToolInputError('destination must be an absolute folder path, or a new name without "/".');
    }
    return { argv: cmd(['file', 'mv'], [opt('on-conflict', a.on_conflict)], [a.source, a.destination]) };
  },
});

const fileDelete = defineTool({
  name: 'nas_file_delete',
  toolset: 'file',
  title: 'Delete files or folders',
  description:
    'Delete paths. By default they go to the recycle bin and can be restored: each item returns ' +
    'data.receipt.final_path, which nas_file_restore needs, so keep it. permanent skips the recycle bin and ' +
    'cannot be undone; use it only when the user asked for permanent deletion. Shared folder roots cannot be ' +
    'deleted. Only delete what the user named: do not widen the scope. The result has items[]; report ' +
    'successes and failures separately, and after a failure check the current state with nas_file_stat instead ' +
    'of repeating the call.',
  input: {
    paths: nasPaths('Paths to delete.', 50),
    permanent: z.boolean().default(false).describe('Delete permanently instead of moving to the recycle bin.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  nasPaths: (a) => a.paths,
  build: (a) => ({ argv: cmd(['file', 'rm'], [opt('permanent', a.permanent)], a.paths) }),
  followUp: (a) =>
    a.permanent
      ? undefined
      : 'Deleted items are in the recycle bin. Keep each items[].data.receipt.final_path: nas_file_restore needs it.',
});

const fileWrite = defineTool({
  name: 'nas_file_write',
  toolset: 'file',
  title: 'Overwrite or append to a file',
  description:
    'Write content into a file that already exists. mode "overwrite" (default) replaces the whole content, and ' +
    'the previous content is lost; "append" adds to the end. The target must exist: to create a file use ' +
    'nas_file_create. Read the file first with nas_file_read if the user has not seen what will be replaced.',
  input: {
    path: nasPath('Existing file to write to.'),
    content: z
      .string()
      .refine((s) => utf8Bytes(s) <= 1_048_576, 'content must be at most 1048576 bytes; use nas_file_upload for larger files')
      .describe('Text to write.'),
    mode: z.enum(['overwrite', 'append']).default('overwrite').describe('Replace the content or add to the end.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  nasPaths: (a) => [a.path],
  // Content travels on stdin so it is not visible in the process list and is not limited by argument size.
  build: (a) => ({ argv: cmd(['file', 'tee'], [opt('append', a.mode === 'append')], [a.path]), stdin: a.content }),
});

const fileQuotaSet = defineTool({
  name: 'nas_file_quota_set',
  toolset: 'file',
  title: 'Set a folder quota',
  description:
    'Set the size limit of a personal or shared folder in MB. 0 removes the quota. The limit takes effect ' +
    'immediately and writes beyond it fail, so check current usage with nas_file_usage first and confirm the ' +
    'number with the user. Quotas can only be set on a personal or shared folder itself, not on subfolders or ' +
    'volume roots.',
  input: {
    path: nasPath('Personal or shared folder.'),
    quota_mb: z.number().int().min(0).describe('Quota in MB; 0 removes it.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  nasPaths: (a) => [a.path],
  build: (a) => ({ argv: cmd(['file', 'quota', 'set'], [opt('quota-mb', a.quota_mb)], [a.path]) }),
});

export const fileTools: ToolSpec[] = [
  fileRoots,
  fileList,
  fileRead,
  fileStat,
  fileFind,
  fileUsage,
  fileChecksum,
  fileTags,
  fileMkdir,
  fileCreate,
  fileCopy,
  fileRestore,
  fileTagEdit,
  fileUpload,
  fileDownload,
  fileMove,
  fileDelete,
  fileWrite,
  fileQuotaSet,
];
