import { z } from 'zod';
import { sizeFilter, timeoutSeconds, unixSeconds } from './schemas.js';
import { ToolInputError, cmd, csv, defineTool, opt, streamTimeout, type ToolSpec } from './types.js';

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
    'shared folders or folders inside them; a volume root is reported as an invalid root. Results are in ' +
    'items[0].entries[]. For finding files by name across a large area, nas_search_files is faster.',
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
    'kind "du" reports how much space folders occupy, optionally broken down to a given depth; it walks the ' +
    'tree and can be slow. kind "quota" reports the size limit set on a personal or shared folder: the value is ' +
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

// Kept for the write tools that follow.
void csv;

export const fileTools: ToolSpec[] = [
  fileRoots,
  fileList,
  fileRead,
  fileStat,
  fileFind,
  fileUsage,
  fileChecksum,
  fileTags,
];
