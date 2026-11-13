import { z } from 'zod';
import { ToolInputError, cmd, defineTool, opt, type ToolSpec } from './types.js';

const METRICS = ['overview', 'cpu', 'gpu', 'mem', 'net', 'disk', 'volume'] as const;

const performance = defineTool({
  name: 'nas_performance',
  toolset: 'taskmgr',
  title: 'Live load and resource use',
  description:
    'Read the task manager. kind "overview" (default) returns CPU, GPU, memory, fans, network and disk ' +
    'activity in one call and is the right first step for "is the NAS slow". "cpu", "gpu", "mem", "net", ' +
    '"disk" and "volume" return one metric each; in net, disk and volume the entry named "overview" is the ' +
    'total. "processes" and "services" list resource use per process or service; sort by cpu, mem or name ' +
    '(pid for processes only) and top keeps the first N (0 for all). Every value is a single instant: to ' +
    'judge a trend, call again a few seconds later. Mind the units: network and per-process disk rates are ' +
    'bytes per second, whole-disk and volume rates are kilobytes per second, memory is bytes, and most ' +
    'numbers are strings. A temperature of 0 means unreadable. On older task manager versions every kind ' +
    'reports "not available"; do not retry. Processes cannot be ended and services cannot be stopped here.',
  input: {
    kind: z.enum([...METRICS, 'processes', 'services']).default('overview').describe('What to measure.'),
    sort: z.enum(['cpu', 'mem', 'name', 'pid']).optional().describe('"processes"/"services" only: sort key.'),
    top: z.number().int().min(0).max(200).default(10).describe('"processes"/"services" only: keep the first N; 0 = all.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.kind !== 'processes' && a.kind !== 'services') {
      if (a.sort) throw new ToolInputError('sort only applies to kind "processes" and "services".');
      return { argv: cmd(['taskmgr', a.kind]) };
    }
    if (a.kind === 'services' && a.sort === 'pid') {
      throw new ToolInputError('Services have no pid; sort them by cpu, mem or name.');
    }
    const noun = a.kind === 'processes' ? 'process' : 'service';
    return { argv: cmd(['taskmgr', noun, 'ls'], [opt('sort', a.sort), opt('top', a.top)]) };
  },
});

export const taskmgrTools: ToolSpec[] = [performance];
