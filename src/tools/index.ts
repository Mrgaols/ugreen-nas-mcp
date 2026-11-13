import { coreTools } from './core.js';
import type { ToolSpec } from './types.js';

/** Every tool this server can expose, in the order clients see them. */
export const ALL_TOOLS: ToolSpec[] = [...coreTools];
