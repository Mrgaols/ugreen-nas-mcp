import { z } from 'zod';
import { sizeFilter, sortOrder, timeoutSeconds, unixSeconds } from './schemas.js';
import { cmd, csv, defineTool, opt, streamTimeout, type ToolSpec } from './types.js';

const sortBy = z
  .enum(['name', 'size', 'modified', 'created', 'accessed', 'class', 'dir-first'])
  .default('name')
  .describe('Sort key. Use the same sort_by and order on every page of one search.');

const pageLimit = z.number().int().min(1).max(500).default(50).describe('Results per page (max 500).');

const searchFiles = defineTool({
  name: 'nas_search_files',
  toolset: 'search',
  title: 'Search files by name',
  description:
    'Search the NAS index for files and folders whose name contains the query (case-insensitive). It matches ' +
    'names, not file content. Give paths to limit the search to folders; subfolders are included unless ' +
    'recursive is false. The call waits for the search to finish and returns the first sorted page in ' +
    'data.results.ordered_items[], plus data.task_id. When data.next_offset is present there are more results: ' +
    'page through them with nas_search_results using the same sort_by and order. When data.task_removed is not ' +
    'true the search task is still stored on the NAS; release it with nas_search_results action "remove" when ' +
    'you are done. file_size and the time fields are strings. A search without paths or query can take minutes; ' +
    'narrow it first.',
  input: {
    query: z.string().min(1).optional().describe('Part of the file or folder name.'),
    paths: z.array(z.string().min(1)).min(1).max(10).optional().describe('Absolute NAS folders to search in.'),
    recursive: z.boolean().default(true).describe('Include subfolders of paths.'),
    classes: z
      .array(z.enum(['app', 'archive', 'audio', 'content-doc', 'dir', 'doc', 'help', 'image', 'other', 'video']))
      .min(1)
      .optional()
      .describe('Only these kinds of entries.'),
    suffix: z.string().min(1).optional().describe('File extension without the dot, for example pdf.'),
    min_size: sizeFilter('Smallest file size.').optional(),
    max_size: sizeFilter('Largest file size.').optional(),
    modified_from: unixSeconds('Modified at or after this time.').optional(),
    modified_to: unixSeconds('Modified at or before this time.').optional(),
    tag_ids: z.array(z.number().int().min(1)).min(1).optional().describe('Only files carrying these tag IDs.'),
    sort_by: sortBy,
    order: sortOrder.optional(),
    limit: pageLimit,
    max_results: z.number().int().min(1).optional().describe('Stop searching after this many matches.'),
    timeout_seconds: timeoutSeconds(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  nasPaths: (a) => a.paths ?? [],
  unscoped: (a) => !a.paths || a.paths.length === 0,
  build: (a) => {
    const st = streamTimeout(a.timeout_seconds);
    const paths = a.paths ?? [];
    return {
      argv: cmd(
        ['search', 'title'],
        [
          ...paths.map((p) => opt('path', p)),
          opt('recursive', paths.length > 0 && a.recursive),
          csv('class', a.classes),
          opt('suffix', a.suffix),
          opt('min-size', a.min_size),
          opt('max-size', a.max_size),
          opt('modified-from', a.modified_from),
          opt('modified-to', a.modified_to),
          csv('tag-id', a.tag_ids),
          opt('sort-by', a.sort_by),
          opt('order', a.order),
          opt('limit', a.limit),
          opt('max-results', a.max_results),
          st.flag,
        ],
        a.query ? [a.query] : [],
      ),
      timeoutMs: st.timeoutMs,
    };
  },
  followUp: () =>
    'If data.next_offset is present, page with nas_search_results using the same sort_by and order. ' +
    'If data.task_removed is not true, release the task with action "remove" when done.',
});

const searchResults = defineTool({
  name: 'nas_search_results',
  toolset: 'search',
  title: 'Page, cancel or release a search',
  description:
    'Work with a search started by nas_search_files, identified by its task_id. action "page" returns another ' +
    'page: entries are in data.ordered_items[] (there is no results wrapper here, unlike nas_search_files). ' +
    'Pass the offset from the previous next_offset and the same sort_by and order as the original search, ' +
    'otherwise pages overlap or skip entries. The search is exhausted only when a page has no next_offset; do ' +
    'not use total_count to decide. "cancel" stops a search that is still running and keeps what was found. ' +
    '"remove" discards the stored search task and its results; it never touches any file. A task that was ' +
    'already removed reports "not found", which is not a failure worth retrying.',
  input: {
    action: z.enum(['page', 'cancel', 'remove']).default('page').describe('What to do with the search task.'),
    task_id: z.string().min(1).describe('data.task_id from nas_search_files.'),
    offset: z.number().int().min(0).default(0).describe('For "page": the next_offset of the previous page.'),
    limit: pageLimit,
    sort_by: sortBy,
    order: sortOrder.optional(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.action === 'cancel') return { argv: cmd(['search', 'cancel'], [], [a.task_id]) };
    if (a.action === 'remove') return { argv: cmd(['search', 'rm'], [], [a.task_id]) };
    return {
      argv: cmd(
        ['search', 'results'],
        [opt('offset', a.offset), opt('limit', a.limit), opt('sort-by', a.sort_by), opt('order', a.order)],
        [a.task_id],
      ),
    };
  },
});

export const searchTools: ToolSpec[] = [searchFiles, searchResults];
