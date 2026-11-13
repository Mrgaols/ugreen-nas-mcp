import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { UncResult } from './unc/runner.js';

export type Envelope = Record<string, unknown>;

export interface Failure {
  error: string;
  hint?: string;
  /** The full unc envelope, kept when it carries per-item results. */
  result?: Envelope;
  error_detail?: unknown;
  compatibility_hint?: unknown;
  warnings?: unknown;
  [key: string]: unknown;
}

export const INSTALL_HINT =
  'The official UGREEN NAS CLI (unc) was not found. Ask the user to install it and make sure it is on PATH, ' +
  'or to set UGREEN_MCP_UNC_BIN to its full path in the MCP server configuration. This cannot be fixed by ' +
  'calling another tool.';

export const LOGIN_HINT =
  'unc is not logged in to a NAS. Ask the user to set UNC_NAS_URL and UNC_NAS_TOKEN in the MCP server ' +
  'configuration, or to run `unc auth login` in a terminal. Do not ask the user to paste the token into the chat.';

const CHECK_STATE =
  'If this call changes something on the NAS, it may have been applied anyway: check the current state with ' +
  'the matching read tool before repeating it.';

const TIMEOUT_HINT =
  'The command did not finish in time and any partial result is incomplete. For a query, narrow the request ' +
  '(a deeper path, no recursion, a lower limit) or raise timeout_seconds where the tool has it. ' +
  CHECK_STATE;

const DEADLINE_HINT =
  'The NAS did not answer in time. For a query, try again with fewer or smaller targets, or raise ' +
  'timeout_seconds where the tool has it. ' +
  CHECK_STATE;

const OVERFLOW_HINT =
  'Narrow the request: a deeper path, no recursion, a filter, or a lower limit. An unlimited listing of a ' +
  'large folder cannot be returned in one call.';

const UNAVAILABLE_HINT =
  'This feature is not available on this NAS. Do not retry. Read error_detail or compatibility_hint for the ' +
  'reason, call nas_status with doctor: true for component versions, and tell the user.';

const TOKEN_HINT =
  'The access token is invalid or expired. Ask the user to log in again or to supply a new token. ' +
  'Do not retry with the same token.';

const PATH_HINT =
  'The path is not inside a shared folder this account can access. Volume roots such as /volume1 are not ' +
  'accessible. Call nas_file_roots to list reachable shared folders, or nas_file_list with no path for the ' +
  'personal folder.';

const SCOPE_HINT =
  'The access token does not include the permission node for this method. Ask the user to create a new access ' +
  'token on the NAS with that permission (permissions cannot be changed after creation). ' +
  'Do not try another tool to get around it.';

const RATE_HINT = 'Rate limited. Wait a few seconds, then repeat the same call with the same arguments.';

const TOKEN_PATTERN = /ugpoa_v1\.[A-Za-z0-9._~+/=-]+/g;

/** Masks open-platform access tokens. Defence in depth: unc should never print one. */
export function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, 'ugpoa_v1.***');
}

/** Returns stdout as an object when unc printed a JSON envelope, otherwise null. */
export function parseEnvelope(r: UncResult): Envelope | null {
  if (r.stdout.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(r.stdout.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Envelope) : null;
  } catch {
    return null;
  }
}

export function isSuccess(r: UncResult, env: Envelope | null): boolean {
  return r.exitCode === 0 && !r.timedOut && !r.overflow && !r.spawnError && env !== null && env.success !== false;
}

function items(env: Envelope | null): Envelope[] {
  const list = env?.items;
  return Array.isArray(list) ? list.filter((i): i is Envelope => i !== null && typeof i === 'object') : [];
}

function hasCompatibilityField(env: Envelope | null): boolean {
  if (!env) return false;
  return [env, ...items(env)].some((e) => e.error_detail != null || e.compatibility_hint != null);
}

/** Suggests what to do next. Structured fields are trusted before any text matching. */
export function hintFor(r: UncResult, env: Envelope | null): string | undefined {
  if (r.spawnError) return INSTALL_HINT;
  if (r.timedOut) return TIMEOUT_HINT;
  if (r.overflow) return OVERFLOW_HINT;
  if (hasCompatibilityField(env)) return UNAVAILABLE_HINT;

  const text = [env?.error, ...items(env).map((i) => i.error), r.stderr]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
  if (text.includes('尚未登录')) return LOGIN_HINT;
  if (text.includes('HTTP 401') || text.includes('Unauthenticated')) return TOKEN_HINT;
  if (text.includes('HTTP 403') || text.includes('PermissionDenied')) {
    return text.includes('code: 1301') ? PATH_HINT : SCOPE_HINT;
  }
  if (text.includes('HTTP 429')) return RATE_HINT;
  if (text.includes('context deadline exceeded')) return DEADLINE_HINT;
  return undefined;
}

export function failureFromUnc(r: UncResult, env: Envelope | null): Failure {
  const stderr = r.stderr.trim();
  let error: string;
  if (r.spawnError) {
    error = `The unc CLI could not be started (${r.spawnError}).`;
  } else if (r.timedOut) {
    error = 'The unc command timed out and was stopped.';
  } else if (r.overflow) {
    error = 'The unc command produced too much output and was stopped.';
  } else if (typeof env?.error === 'string' && env.error.length > 0) {
    error = env.error;
  } else if (stderr.length > 0) {
    error = stderr;
  } else {
    const head = r.stdout.toString('utf8').slice(0, 300).trim();
    error = `unc produced unexpected output (exit code ${r.exitCode})${head ? ': ' + head : '.'}`;
  }

  // The hint goes right after the error, so it survives when a bulky result is cut to the output limit.
  const failure: Failure = { error };
  const hint = hintFor(r, env);
  if (hint) failure.hint = hint;
  if (env) {
    if (Array.isArray(env.items)) failure.result = env;
    if (env.error_detail != null) failure.error_detail = env.error_detail;
    if (env.compatibility_hint != null) failure.compatibility_hint = env.compatibility_hint;
    if (env.warnings != null) failure.warnings = env.warnings;
  }
  return failure;
}

/** Compact JSON, redacted, and cut to the configured size with a notice that says how much is missing. */
export function toText(payload: unknown, maxChars: number): string {
  const text = redact(typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? 'null'));
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[truncated: showing ${maxChars} of ${text.length} characters. ` +
    'Narrow the request (deeper path, filters, lower limit) to see the rest.]'
  );
}

export function ok(payload: unknown, maxChars: number): CallToolResult {
  return { content: [{ type: 'text', text: toText(payload, maxChars) }] };
}

export function fail(failure: Failure, maxChars: number): CallToolResult {
  return { content: [{ type: 'text', text: toText(failure, maxChars) }], isError: true };
}
