import { z } from 'zod';
import type { Config } from '../config.js';
import { INSTALL_HINT, LOGIN_HINT, fail, failureFromUnc, isSuccess, ok, parseEnvelope } from '../output.js';
import type { UncRunner } from '../unc/runner.js';
import { defineTool, type ToolSpec } from './types.js';

function policySummary(config: Config) {
  return {
    access: config.access,
    toolsets: [...config.toolsets],
    allowed_paths: config.allowedPaths.length > 0 ? [...config.allowedPaths] : 'unrestricted',
    local_transfer: config.localDir ? 'enabled' : 'disabled',
    max_output_chars: config.maxOutputChars,
  };
}

async function query(runner: UncRunner, argv: string[], timeoutMs?: number): Promise<unknown> {
  const result = await runner(['--format=json', ...argv], { timeoutMs });
  const env = parseEnvelope(result);
  return isSuccess(result, env) ? env : failureFromUnc(result, env);
}

const nasStatus = defineTool({
  name: 'nas_status',
  toolset: 'core',
  title: 'NAS connection and server status',
  description:
    'Check whether this server can reach the NAS, and what it is allowed to do. Returns the login state ' +
    '(NAS address and user name, never the token), the unc CLI version, and the server policy: access level, ' +
    'enabled toolsets, allowed NAS paths and whether local file transfer is enabled. Call it first when another ' +
    'tool fails with an authentication, connection or "not available" error. Set doctor to true for a full ' +
    'health report with firmware and component versions and the methods this NAS does not support; that report ' +
    'takes longer, so do not request it before every call.',
  input: {
    doctor: z
      .boolean()
      .default(false)
      .describe('Also run the full health report (firmware, component versions, unsupported methods).'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: () => ({ argv: ['auth', 'status', '--check'] }),
  handler: async (args, deps) => {
    const max = deps.config.maxOutputChars;
    const policy = policySummary(deps.config);
    if (!deps.runner) return fail({ error: 'unc CLI not found', hint: INSTALL_HINT, policy }, max);

    const auth = await query(deps.runner, ['auth', 'status', '--check']);
    const unc = await query(deps.runner, ['version']);
    const body: Record<string, unknown> = { auth, unc };
    if (args.doctor) body.doctor = await query(deps.runner, ['doctor'], 120_000);
    body.policy = policy;
    if ((auth as { authenticated?: unknown }).authenticated !== true) body.hint = LOGIN_HINT;
    return ok(body, max);
  },
});

export const coreTools: ToolSpec[] = [nasStatus];
