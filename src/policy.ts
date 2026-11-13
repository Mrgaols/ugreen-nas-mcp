import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const RISKS = ['read', 'write', 'admin'] as const;
export type Risk = (typeof RISKS)[number];

export const TOOLSETS = [
  'file',
  'search',
  'docker',
  'download',
  'app',
  'storage',
  'ctl',
  'network',
  'taskmgr',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** A call refused by this server's own policy, as opposed to a failure reported by the NAS. */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

const PATH_HINT =
  'This is a restriction of the MCP server, not of the NAS. NAS paths must be absolute, and when ' +
  'UGREEN_MCP_ALLOWED_PATHS is set they must lie inside one of the listed folders. Ask the user to change ' +
  'UGREEN_MCP_ALLOWED_PATHS in the MCP server configuration if this path should be reachable.';

const LOCAL_HINT =
  'This is a restriction of the MCP server. Transfers may only read or write local files inside the directory ' +
  'set in UGREEN_MCP_LOCAL_DIR. Ask the user to change UGREEN_MCP_LOCAL_DIR in the MCP server configuration ' +
  'if another location is needed.';

export function riskAllows(level: Risk, needed: Risk): boolean {
  return RISKS.indexOf(needed) <= RISKS.indexOf(level);
}

/**
 * Validates the shape of a NAS path and returns it with duplicate and trailing slashes removed.
 * The NAS itself decides what a path resolves to, so `..` is refused outright instead of resolved.
 */
export function normalizeNasPath(p: string): string {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new PolicyError(`NAS path must be absolute (start with "/"): ${JSON.stringify(p)}`, PATH_HINT);
  }
  if (p.includes('\0')) {
    throw new PolicyError('NAS path must not contain a NUL character', PATH_HINT);
  }
  const segments = p.split('/').filter((s) => s.length > 0);
  if (segments.includes('..')) {
    throw new PolicyError(`NAS path must not contain ".." segments: ${JSON.stringify(p)}`, PATH_HINT);
  }
  return '/' + segments.join('/');
}

/** Returns the normalized path, or throws when it lies outside every allowed prefix. */
export function assertNasPathAllowed(p: string, allowed: readonly string[]): string {
  const normalized = normalizeNasPath(p);
  if (allowed.length === 0) return normalized;
  const inside = allowed.some(
    (prefix) => prefix === '/' || normalized === prefix || normalized.startsWith(prefix + '/'),
  );
  if (!inside) {
    throw new PolicyError(
      `NAS path ${JSON.stringify(normalized)} is outside the folders this server is allowed to use (${allowed.join(', ')})`,
      PATH_HINT,
    );
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolves a local path for a transfer and guarantees it stays inside `localDir` after symlinks are followed.
 * `existing-file` is an upload source; `target` is a download destination whose parent directory must exist.
 */
export async function resolveLocalPath(
  p: string,
  localDir: string,
  mode: 'existing-file' | 'target',
): Promise<string> {
  let root: string;
  try {
    root = await realpath(localDir);
  } catch {
    throw new PolicyError(`The local transfer directory does not exist: ${localDir}`, LOCAL_HINT);
  }
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new PolicyError('Local path must be a non-empty string', LOCAL_HINT);
  }
  const candidate = path.resolve(root, p);

  if (mode === 'existing-file') {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new PolicyError(`Local file not found inside the transfer directory: ${p}`, LOCAL_HINT);
    }
    if (!isInside(root, real)) {
      throw new PolicyError(`Local path resolves outside the transfer directory: ${p}`, LOCAL_HINT);
    }
    if (!(await stat(real)).isFile()) {
      throw new PolicyError(`Local path is not a regular file: ${p}`, LOCAL_HINT);
    }
    return real;
  }

  const name = path.basename(candidate);
  let parent: string;
  try {
    parent = await realpath(path.dirname(candidate));
  } catch {
    throw new PolicyError(`The destination folder does not exist inside the transfer directory: ${p}`, LOCAL_HINT);
  }
  if (!isInside(root, parent)) {
    throw new PolicyError(`Local path resolves outside the transfer directory: ${p}`, LOCAL_HINT);
  }
  if (!(await stat(parent)).isDirectory() || name === '' || name === '.' || name === '..') {
    throw new PolicyError(`Local path is not a valid destination file: ${p}`, LOCAL_HINT);
  }
  const target = path.join(parent, name);
  // An existing link here would send the download wherever it points, so only a plain file may be replaced.
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(target);
  } catch {
    // nothing there yet
  }
  if (existing !== null && !existing.isFile()) {
    throw new PolicyError(`Local destination exists and is not a regular file: ${p}`, LOCAL_HINT);
  }
  return target;
}
