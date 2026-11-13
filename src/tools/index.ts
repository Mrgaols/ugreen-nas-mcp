import { coreTools } from './core.js';
import { dockerTools } from './docker.js';
import { downloadTools } from './download.js';
import { fileTools } from './file.js';
import { searchTools } from './search.js';
import type { ToolSpec } from './types.js';

/** Every tool this server can expose, in the order clients see them. */
export const ALL_TOOLS: ToolSpec[] = [...coreTools, ...fileTools, ...searchTools, ...dockerTools, ...downloadTools];
