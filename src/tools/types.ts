import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import type { ConfirmStore } from '../confirm.js';
import type { Envelope } from '../output.js';
import type { Risk, Toolset } from '../policy.js';
import type { UncRunner } from '../unc/runner.js';

/** Everything a tool call needs from the running server. */
export interface Deps {
  config: Config;
  /** null when the unc binary could not be found. */
  runner: UncRunner | null;
  confirm: ConfirmStore;
  version: string;
  /** Replaces the generic install advice when the server knows why unc is unavailable. */
  missingUncHint?: string;
  /** Receives one line per call: tool name, risk and outcome. Never argument values. */
  log?: (line: string) => void;
}

/** One invocation of unc, without the global flags the server adds. */
export interface UncCall {
  argv: string[];
  stdin?: string | Buffer;
  timeoutMs?: number;
  /** Seconds unc may wait for one request to the NAS; unc's own default is 30. */
  requestTimeoutSeconds?: number;
  /** Ask unc for raw bytes instead of a JSON envelope. */
  raw?: boolean;
}

export interface BuildContext {
  /** The local path after it was confined to UGREEN_MCP_LOCAL_DIR. */
  localPath?: string;
  /** The server's output limit, for tools that size their request to fit it. */
  maxOutputChars?: number;
}

/** The arguments are individually valid but do not make sense together. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

interface ToolBase<Shape extends z.ZodRawShape, Args> {
  name: string;
  toolset: Toolset | 'core';
  title: string;
  description: string;
  input: Shape;
  /** Lowest risk any call of this tool can have. Decides whether the tool is registered. */
  minRisk: Risk;
  /** Highest risk any call can have. `admin` adds the confirm_token parameter. */
  maxRisk: Risk;
  /** Risk of this particular call. */
  risk(args: Args): Risk;
  /** NAS paths in the arguments that must pass the allowlist. */
  nasPaths?(args: Args): string[];
  /** True when the call names no path and would therefore act outside any allowlist. */
  unscoped?(args: Args): boolean;
  /** Present on transfer tools: the local path to confine, and what it must be. */
  localPath?(args: Args): { path: string; mode: 'existing-file' | 'target' };
  build(args: Args, ctx: BuildContext): UncCall;
  /** Turns the bytes of a raw call into the result. */
  render?(stdout: Buffer, args: Args): unknown;
  /** Reduces an oversized envelope to what an agent needs. */
  project?(env: Envelope): unknown;
  /** Advice attached to a successful result as `next_step`. */
  followUp?(args: Args): string | undefined;
  /** Replaces the whole pipeline. Used by nas_status only. */
  handler?(args: Args, deps: Deps): Promise<CallToolResult>;
}

// Tools of different shapes live in one list, so the stored form erases the argument type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolSpec = ToolBase<z.ZodRawShape, any>;

/** Declares a tool with callbacks typed from its input schema. */
export function defineTool<Shape extends z.ZodRawShape>(
  spec: ToolBase<Shape, z.infer<z.ZodObject<Shape>>>,
): ToolSpec {
  return spec as unknown as ToolSpec;
}

type Flag = string | false | null | undefined;

/** `words` + the flags that are set + `--` and the positionals, so user values can never be read as flags. */
export function cmd(words: string[], flags: Flag[] = [], positionals: string[] = []): string[] {
  const set = flags.filter((f): f is string => typeof f === 'string' && f.length > 0);
  return [...words, ...set, ...(positionals.length > 0 ? ['--', ...positionals] : [])];
}

/** `--name=value`, or the bare `--name` for true; nothing for false or undefined. */
export function opt(name: string, value: string | number | boolean | undefined): string | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? `--${name}` : `--${name}=${value}`;
}

/** `--name=a,b` for a non-empty list. */
export function csv(name: string, values: ReadonlyArray<string | number> | undefined): string | undefined {
  return values && values.length > 0 ? `--${name}=${values.join(',')}` : undefined;
}

/** The flag for a streaming command, and a process timeout that outlasts it. */
export function streamTimeout(seconds: number): { flag: string; timeoutMs: number } {
  return { flag: `--stream-timeout=${seconds}`, timeoutMs: (seconds + 15) * 1000 };
}

const MAX_PROCESS_SECONDS = 1800;

/**
 * For commands whose single request can outlast unc's default 30 seconds (copying, hashing, restarting).
 * unc sends one request per target, so the process limit grows with the number of targets, up to a ceiling.
 */
export function requestTimeout(seconds: number, requests = 1): { requestTimeoutSeconds: number; timeoutMs: number } {
  return {
    requestTimeoutSeconds: seconds,
    timeoutMs: (Math.min(seconds * requests, MAX_PROCESS_SECONDS) + 15) * 1000,
  };
}
