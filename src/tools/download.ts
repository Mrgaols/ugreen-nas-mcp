import { z } from 'zod';
import { ToolInputError, cmd, defineTool, opt, type ToolSpec } from './types.js';

const taskIds = z.array(z.string().min(1)).min(1).max(50);

const downloadList = defineTool({
  name: 'nas_download_list',
  toolset: 'download',
  title: 'List download tasks',
  description:
    'Show the tasks of the NAS download center with their progress. Without task_ids it lists every task, ' +
    'including finished ones; with task_ids it returns just those, and fails as a whole if any ID does not ' +
    'exist. Tasks are in data.tasks[]. Use progress_percent (a number from 0 to 100) rather than dividing ' +
    'bytes: total_bytes can be negative while the size is unknown. saved_path and file_name are empty until ' +
    'task_status is TASK_STATUS_COMPLETED, which does not mean failure. When waiting for a task, check a few ' +
    'seconds apart and stop at COMPLETED, FAILED or PAUSED; the access token has a per-minute request quota.',
  input: {
    task_ids: taskIds.optional().describe('Task IDs to query; omit to list all tasks.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) =>
    a.task_ids && a.task_ids.length > 0
      ? { argv: cmd(['download', 'status'], [], a.task_ids) }
      : { argv: cmd(['download', 'ls']) },
});

const downloadCreate = defineTool({
  name: 'nas_download_create',
  toolset: 'download',
  title: 'Have the NAS download a URL',
  description:
    'Create a task in the NAS download center so the NAS itself fetches a URL (HTTP, HTTPS, FTP, magnet, ' +
    'thunder or ed2k) onto its own storage. This does not download anything to this computer; for that use ' +
    'nas_file_download. Confirm the URL and target folder with the user first. dir must be an existing folder; ' +
    'without it the user\'s default download folder is used, and the call fails if there is none, in which case ' +
    'ask the user where to save. Keep data.task_id: it is how the task is found again. One URL per call.',
  input: {
    url: z.string().min(1).describe('The link to download.'),
    dir: z.string().min(1).optional().describe('Existing NAS folder to save into (absolute path).'),
  },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  nasPaths: (a) => (a.dir ? [a.dir] : []),
  unscoped: (a) => !a.dir,
  build: (a) => ({ argv: cmd(['download', 'create'], [opt('dir', a.dir)], [a.url]) }),
  followUp: () => 'The download runs in the background. Check progress with nas_download_list, a few seconds apart.',
});

const downloadControl = defineTool({
  name: 'nas_download_control',
  toolset: 'download',
  title: 'Pause, resume, retry or remove download tasks',
  description:
    'Change download tasks. Give task_ids, or all: true to act on every task; never both and never neither. ' +
    'Use all only when the user explicitly asked for all tasks; it needs admin access and a confirmation. ' +
    '"pause" only works on tasks that are downloading or queued: naming a finished or failed task makes the ' +
    'whole call fail, yet the other tasks in the same call are still paused, so check with nas_download_list ' +
    'instead of repeating it. "resume" and "retry" succeeding only means the task was queued again ("retry" ' +
    'acts on failed tasks only). "remove" deletes the task entry and keeps any files already downloaded; it ' +
    'cannot be undone and also needs admin access and a confirmation.',
  input: {
    action: z.enum(['pause', 'resume', 'retry', 'remove']).describe('What to do.'),
    task_ids: taskIds.optional().describe('Tasks to act on.'),
    all: z.boolean().default(false).describe('Act on every task. Only when the user asked for all of them.'),
  },
  minRisk: 'write',
  maxRisk: 'admin',
  risk: (a) => (a.action === 'remove' || a.all ? 'admin' : 'write'),
  build: (a) => {
    const ids = a.task_ids ?? [];
    if (a.all === (ids.length > 0)) {
      throw new ToolInputError('Give either task_ids (at least one) or all: true, not both and not neither.');
    }
    const verb = a.action === 'remove' ? 'rm' : a.action;
    return { argv: cmd(['download', verb], [opt('all', a.all)], ids) };
  },
  followUp: () => 'Verify the result with nas_download_list before reporting it; success may only mean "queued".',
});

export const downloadTools: ToolSpec[] = [downloadList, downloadCreate, downloadControl];
