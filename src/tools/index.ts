import { appTools } from './app.js';
import { coreTools } from './core.js';
import { ctlTools } from './ctl.js';
import { dockerTools } from './docker.js';
import { downloadTools } from './download.js';
import { fileTools } from './file.js';
import { networkTools } from './network.js';
import { searchTools } from './search.js';
import { storageTools } from './storage.js';
import { taskmgrTools } from './taskmgr.js';
import type { ToolSpec } from './types.js';

/** Every tool this server can expose, in the order clients see them. */
export const ALL_TOOLS: ToolSpec[] = [
  ...coreTools,
  ...fileTools,
  ...searchTools,
  ...dockerTools,
  ...downloadTools,
  ...appTools,
  ...storageTools,
  ...ctlTools,
  ...networkTools,
  ...taskmgrTools,
];
