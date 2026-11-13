import path from 'node:path';
import { RISKS, TOOLSETS, normalizeNasPath, type Risk, type Toolset } from './policy.js';

export interface Config {
  /** Highest risk level a call may have. */
  access: Risk;
  toolsets: ReadonlySet<Toolset>;
  /** Normalized NAS path prefixes; empty means unrestricted. */
  allowedPaths: readonly string[];
  /** Absolute local directory for uploads and downloads; null disables the transfer tools. */
  localDir: string | null;
  /** Explicit path to the unc binary; null means look it up. */
  uncBin: string | null;
  maxOutputChars: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_MAX_OUTPUT_CHARS = 60000;
export const MIN_MAX_OUTPUT_CHARS = 1000;

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const accessRaw = value(env, 'UGREEN_MCP_ACCESS');
  const access = (accessRaw?.toLowerCase() ?? 'read') as Risk;
  if (!RISKS.includes(access)) {
    throw new ConfigError(`UGREEN_MCP_ACCESS has an unknown value "${accessRaw}". Use one of: ${RISKS.join(', ')}.`);
  }

  const toolsets = new Set<Toolset>();
  for (const item of list(env, 'UGREEN_MCP_TOOLSETS')) {
    const name = item.toLowerCase() as Toolset;
    if (!TOOLSETS.includes(name)) {
      throw new ConfigError(
        `UGREEN_MCP_TOOLSETS contains an unknown toolset "${item}". Use any of: ${TOOLSETS.join(', ')}.`,
      );
    }
    toolsets.add(name);
  }
  if (toolsets.size === 0) for (const name of TOOLSETS) toolsets.add(name);

  const allowedPaths: string[] = [];
  for (const item of list(env, 'UGREEN_MCP_ALLOWED_PATHS')) {
    let normalized: string;
    try {
      normalized = normalizeNasPath(item);
    } catch {
      throw new ConfigError(
        `UGREEN_MCP_ALLOWED_PATHS contains an invalid path "${item}". ` +
          'Each entry must be an absolute NAS path without ".." segments, for example /volume1/docs.',
      );
    }
    if (!allowedPaths.includes(normalized)) allowedPaths.push(normalized);
  }

  const localDir = value(env, 'UGREEN_MCP_LOCAL_DIR');
  if (localDir !== null && !path.isAbsolute(localDir)) {
    throw new ConfigError(`UGREEN_MCP_LOCAL_DIR must be an absolute path, got "${localDir}".`);
  }

  const maxRaw = value(env, 'UGREEN_MCP_MAX_OUTPUT_CHARS');
  let maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS;
  if (maxRaw !== null) {
    maxOutputChars = Number(maxRaw);
    if (!/^\d+$/.test(maxRaw) || maxOutputChars < MIN_MAX_OUTPUT_CHARS) {
      throw new ConfigError(
        `UGREEN_MCP_MAX_OUTPUT_CHARS must be a whole number of at least ${MIN_MAX_OUTPUT_CHARS}, got "${maxRaw}".`,
      );
    }
  }

  return {
    access,
    toolsets,
    allowedPaths,
    localDir,
    uncBin: value(env, 'UGREEN_MCP_UNC_BIN'),
    maxOutputChars,
  };
}
