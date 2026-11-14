import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { INSTALL_HINT, fail, failureFromUnc, isSuccess, ok, parseEnvelope } from './output.js';
import { PolicyError, assertNasPathAllowed, resolveLocalPath, riskAllows } from './policy.js';
import { ALL_TOOLS } from './tools/index.js';
import { ToolInputError, type BuildContext, type Deps, type ToolSpec } from './tools/types.js';

export const INSTRUCTIONS = `This server manages the user's own UGREEN NAS through the official unc CLI.
- If a call fails with an authentication or connection error, call nas_status.
- File paths start at a shared folder or the personal folder. Volume roots such as /volume1 are not accessible. If you do not know a path, call nas_file_roots (shared folders) or nas_file_list with no path (personal folder).
- Never invent IDs, paths, task IDs or app IDs. Take them from tool results.
- 64-bit integers (sizes, timestamps, task IDs) are JSON strings. Convert them before comparing.
- Some operations are asynchronous: success means "accepted". Verify with the matching list tool before reporting completion.
- After a failed write, check the current state before trying again. Do not retry automatically.
- Tools that delete, overwrite, stop services or change accounts first run as a preview and return a confirm_token. Show the preview to the user, then call the same tool with identical arguments plus confirm_token.
- A result with "truncated": true was cut to the server's output limit: "partial" is only the beginning. Narrow the request instead of guessing the rest.
- If server policy rejects a call (access level, allowed paths, local directory), tell the user which environment variable to change. Do not look for another tool to get around it.`;

const CONFIRM_NEXT_STEP =
  'Nothing has been changed yet. Show this preview to the user. To execute, call this tool again with ' +
  'identical arguments plus confirm_token.';

const CONFIRM_ERRORS = {
  unknown: 'confirm_token is not valid. It may have been used already, or the server was restarted.',
  expired: 'confirm_token has expired.',
  mismatch: 'confirm_token was issued for different arguments. The arguments of this call do not match the preview.',
} as const;

/** The tools the current configuration exposes. A tool that is not listed here cannot be called. */
export function enabledTools(config: Config, all: ToolSpec[] = ALL_TOOLS): ToolSpec[] {
  return all.filter(
    (tool) =>
      (tool.toolset === 'core' || config.toolsets.has(tool.toolset)) &&
      riskAllows(config.access, tool.minRisk) &&
      (!tool.localPath || config.localDir !== null),
  );
}

/**
 * Runs one tool call through validation, the policy gates, the confirmation step and unc.
 * Never throws: every outcome is a tool result.
 */
export async function executeTool(
  spec: ToolSpec,
  rawArgs: Record<string, unknown>,
  deps: Deps,
): Promise<CallToolResult> {
  const { config } = deps;
  const max = config.maxOutputChars;
  let risk = 'unknown';
  let mode = 'run';
  let exit: string | number = '-';

  try {
    const { confirm_token: rawToken, ...rest } = rawArgs ?? {};
    const parsed = z.object(spec.input).safeParse(rest);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
      return fail({ error: `Invalid arguments for ${spec.name}: ${issues}` }, max);
    }
    const args = parsed.data;

    if (spec.handler) return await spec.handler(args, deps);
    if (!deps.runner) return fail({ error: 'unc CLI not found', hint: deps.missingUncHint ?? INSTALL_HINT }, max);

    const callRisk = spec.risk(args);
    risk = callRisk;
    if (!riskAllows(config.access, callRisk)) {
      return fail(
        {
          error: `This call needs access level "${risk}" but the server is configured with "${config.access}".`,
          hint:
            'This is a restriction of the MCP server. If the user wants to allow it, they must set ' +
            `UGREEN_MCP_ACCESS=${risk} in the MCP server configuration and restart the server.`,
        },
        max,
      );
    }

    if (config.allowedPaths.length > 0 && spec.unscoped?.(args)) {
      throw new PolicyError(
        `This call names no NAS path, but the server only allows these folders: ${config.allowedPaths.join(', ')}. ` +
          'Pass a path inside one of them.',
        'This is a restriction of the MCP server set by UGREEN_MCP_ALLOWED_PATHS. Add a path argument inside an ' +
          'allowed folder, or ask the user to change UGREEN_MCP_ALLOWED_PATHS.',
      );
    }
    for (const p of spec.nasPaths?.(args) ?? []) assertNasPathAllowed(p, config.allowedPaths);

    const ctx: BuildContext = { maxOutputChars: max };
    if (spec.localPath) {
      if (!config.localDir) {
        throw new PolicyError(
          'Local file transfer is disabled on this server.',
          'Ask the user to set UGREEN_MCP_LOCAL_DIR to a local directory in the MCP server configuration.',
        );
      }
      const local = spec.localPath(args);
      ctx.localPath = await resolveLocalPath(local.path, config.localDir, local.mode);
    }

    const call = spec.build(args, ctx);
    // The operating system cannot pass a NUL inside an argument; say so instead of failing in spawn.
    if (call.argv.some((arg) => arg.includes('\0'))) {
      throw new ToolInputError('Arguments must not contain a NUL character.');
    }
    const globals = [call.raw ? '--format=raw' : '--format=json'];
    if (call.requestTimeoutSeconds !== undefined) globals.push(`--timeout=${call.requestTimeoutSeconds}`);
    const runOpts = { stdin: call.stdin, timeoutMs: call.timeoutMs };
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : undefined;

    if (risk === 'admin' && token === undefined) {
      mode = 'preview';
      const result = await deps.runner([...globals, '--dry-run', ...call.argv], runOpts);
      exit = result.exitCode ?? 'killed';
      const env = parseEnvelope(result);
      if (!isSuccess(result, env)) return fail(failureFromUnc(result, env), max);
      const issued = deps.confirm.issue(spec.name, args);
      // The preview goes last: if the result is cut to the output limit, the token must survive.
      return ok(
        {
          status: 'confirmation_required',
          confirm_token: issued.token,
          expires_in_seconds: issued.expiresInSeconds,
          next_step: CONFIRM_NEXT_STEP,
          preview: env,
        },
        max,
      );
    }

    if (risk === 'admin' && token !== undefined) {
      mode = 'confirmed';
      const verdict = deps.confirm.consume(token, spec.name, args);
      if (verdict !== 'ok') {
        mode = `rejected-${verdict}`;
        return fail(
          { error: CONFIRM_ERRORS[verdict], hint: 'Call the tool again without confirm_token to get a fresh preview.' },
          max,
        );
      }
      globals.push('--yes');
    }

    const result = await deps.runner([...globals, ...call.argv], runOpts);
    exit = result.exitCode ?? 'killed';

    if (call.raw) {
      if (result.exitCode !== 0 || result.timedOut || result.overflow || result.spawnError) {
        return fail(failureFromUnc(result, null), max);
      }
      return ok(spec.render ? spec.render(result.stdout, args) : result.stdout.toString('utf8'), max);
    }

    const env = parseEnvelope(result);
    if (!isSuccess(result, env) || env === null) return fail(failureFromUnc(result, env), max);

    let payload: unknown = spec.project ? spec.project(env) : env;
    const nextStep = spec.followUp?.(args);
    if (nextStep && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      // Advice first, so it is still there when a large result is cut to the output limit.
      payload = { next_step: nextStep, ...(payload as Record<string, unknown>) };
    }
    return ok(payload, max);
  } catch (err) {
    mode = 'error';
    if (err instanceof PolicyError) return fail({ error: err.message, hint: err.hint }, max);
    if (err instanceof ToolInputError) return fail({ error: err.message }, max);
    return fail({ error: `Internal error in ${spec.name}: ${err instanceof Error ? err.message : String(err)}` }, max);
  } finally {
    deps.log?.(`[ugreen-nas-mcp] ${spec.name} risk=${risk} mode=${mode} exit=${exit}`);
  }
}

export function buildServer(deps: Deps, all: ToolSpec[] = ALL_TOOLS): McpServer {
  const server = new McpServer({ name: 'ugreen-nas-mcp', version: deps.version }, { instructions: INSTRUCTIONS });

  for (const spec of enabledTools(deps.config, all)) {
    const inputSchema =
      spec.maxRisk === 'admin'
        ? {
            ...spec.input,
            confirm_token: z
              .string()
              .optional()
              .describe('Token returned by the preview call. Omit it to get a preview; nothing changes without it.'),
          }
        : spec.input;

    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.maxRisk === 'read',
          destructiveHint: spec.maxRisk === 'admin',
          openWorldHint: true,
        },
      },
      (args: Record<string, unknown>) => executeTool(spec, args, deps),
    );
  }
  return server;
}
