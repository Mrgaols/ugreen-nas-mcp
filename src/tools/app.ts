import { z } from 'zod';
import type { Envelope } from '../output.js';
import { assertParamKey } from './schemas.js';
import { ToolInputError, cmd, defineTool, opt, requestTimeout, type ToolSpec } from './types.js';

const inputError = (message: string) => new ToolInputError(message);
const appIds = (max: number) => z.array(z.string().min(1)).min(1).max(max);

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const NAME_LOCALES = ['zh-CN', 'en-US'] as const;

/**
 * The raw app list carries every translation, icon and install parameter for every app and runs to hundreds
 * of thousands of characters. An agent choosing an app only needs these fields.
 */
function compactAppList(env: Envelope): unknown {
  const data = asObject(env.data);
  if (!Array.isArray(data.apps)) return env;
  const apps = data.apps.map((entry) => {
    const brief = asObject(asObject(entry).brief);
    const names = asObject(brief.name_i18n_map);
    const name: Record<string, string> = {};
    for (const locale of NAME_LOCALES) {
      const value = str(names[locale]);
      if (value !== null) name[locale] = value;
    }
    return {
      app_id: str(brief.app_id),
      name,
      install_status: str(brief.install_status),
      installed_version: str(asObject(brief.installed_version).version),
      available_version: str(asObject(brief.cloud_version).version),
      app_type: str(brief.app_type),
    };
  });
  return { ...env, data: { count: apps.length, apps } };
}

const FILTER_FLAGS = {
  installed: '--installed',
  not_installed: '--not-installed',
  update_available: '--update-available',
  repair_needed: '--repair-needed',
} as const;

const appList = defineTool({
  name: 'nas_app_list',
  toolset: 'app',
  title: 'List or search app-center apps',
  description:
    'List the apps of the NAS app center, or search them by keyword. The output is a compact summary per app ' +
    '(app_id, name, install_status, installed_version, available_version); for full details and install ' +
    'parameters call nas_app_get. filter narrows the list to installed, not installed, updatable or broken ' +
    'apps. keyword (at most 20 characters) searches by name; a search can be combined only with filter ' +
    '"installed", and it does not find port apps or portal apps, so if nothing matches, list without keyword ' +
    'and look through the names. Always take app IDs from this output and confirm the choice with the user.',
  input: {
    keyword: z.string().min(1).max(20).optional().describe('Search term (max 20 characters).'),
    filter: z
      .enum(['installed', 'not_installed', 'update_available', 'repair_needed'])
      .optional()
      .describe('Only apps in this state.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.keyword) {
      if (a.filter && a.filter !== 'installed') {
        throw new ToolInputError('A keyword search can only be combined with filter "installed".');
      }
      return { argv: cmd(['app', 'search'], [a.filter ? FILTER_FLAGS.installed : undefined], [a.keyword]) };
    }
    return { argv: cmd(['app', 'ls'], [a.filter ? FILTER_FLAGS[a.filter] : undefined]) };
  },
  project: compactAppList,
});

const appGet = defineTool({
  name: 'nas_app_get',
  toolset: 'app',
  title: 'App details or status',
  description:
    'view "detail" (default) returns everything about one app, including install_parameters, whose keys are ' +
    'what nas_app_manage expects in params; the values still have to come from the user. An unknown app ID is ' +
    'an error. view "status" returns the install, running and auto-start state for one or more apps in ' +
    'data.status keyed by app ID: decide from is_installed and is_running. An empty run_state, or one resting ' +
    'at APP_RUNNER_STAGE_FREE, just means no workflow is in progress and is not a failure.',
  input: {
    view: z.enum(['detail', 'status']).default('detail').describe('Full details of one app, or state of several.'),
    app_ids: appIds(20).describe('App IDs; exactly one for "detail".'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.view === 'status') return { argv: cmd(['app', 'status'], [], a.app_ids) };
    if (a.app_ids.length !== 1) throw new ToolInputError('view "detail" takes exactly one app ID.');
    return { argv: cmd(['app', 'get'], [], a.app_ids) };
  },
});

const appManage = defineTool({
  name: 'nas_app_manage',
  toolset: 'app',
  title: 'Install, update, uninstall, start or stop apps',
  description:
    'Change apps of the app center. Every action needs a token issued by an administrator, otherwise the NAS ' +
    'answers Code(1008). Take app IDs from nas_app_list and confirm them with the user; never guess. "install" ' +
    'needs install_path, the mount point of a volume such as /volume1 (see nas_storage_info kind "volumes"), ' +
    'and may need params whose keys are listed in nas_app_get. "install", "update" and "uninstall" wait until ' +
    'every app reached a final state and return items[], one per app: report each separately. If the call ' +
    'times out or the connection drops, the operation may still be running and has no idempotency key, so do ' +
    'not submit it again: check nas_app_get with view "status". clean_data on uninstall also deletes the app\'s ' +
    'data and cannot be undone; use it only when the user asked for that. "start" and "stop" are synchronous; ' +
    '"stop" interrupts the app\'s service.',
  input: {
    action: z.enum(['install', 'update', 'uninstall', 'start', 'stop']).describe('What to do.'),
    app_ids: appIds(10).describe('App IDs from nas_app_list.'),
    install_path: z.string().min(1).optional().describe('For "install": volume mount point, for example /volume1.'),
    params: z
      .array(z.object({ key: z.string().min(1), value: z.union([z.string(), z.array(z.string()).min(1)]) }))
      .max(50)
      .optional()
      .describe('For "install": parameters as { key, value }; value may be a list.'),
    no_start: z.boolean().default(false).describe('For "install" and "update": do not start the app afterwards.'),
    clean_data: z.boolean().default(false).describe('For "uninstall": also delete the app data. Irreversible.'),
    wait_timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(30)
      .describe('For "install", "update" and "uninstall": how long to wait for the final state.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => {
    if (a.action !== 'install' && (a.install_path !== undefined || a.params !== undefined)) {
      throw new ToolInputError('install_path and params only apply to action "install".');
    }
    if (a.no_start && a.action !== 'install' && a.action !== 'update') {
      throw new ToolInputError('no_start only applies to actions "install" and "update".');
    }
    if (a.clean_data && a.action !== 'uninstall') {
      throw new ToolInputError('clean_data only applies to action "uninstall".');
    }
    const params = (a.params ?? []).map((p) => {
      assertParamKey(p.key, inputError);
      return Array.isArray(p.value) ? `--param-multi=${p.key}=${p.value.join(',')}` : `--param=${p.key}=${p.value}`;
    });
    const waits = a.action === 'install' || a.action === 'update' || a.action === 'uninstall';
    return {
      argv: cmd(
        ['app', a.action],
        [
          opt('path', a.install_path),
          ...params,
          opt('no-start', a.no_start),
          opt('clean', a.clean_data),
          waits ? `--wait-timeout=${a.wait_timeout_minutes}m` : undefined,
        ],
        a.app_ids,
      ),
      // install, update and uninstall wait on the NAS side; start and stop are one synchronous request each.
      ...(waits ? { timeoutMs: a.wait_timeout_minutes * 60_000 + 30_000 } : requestTimeout(300, a.app_ids.length)),
    };
  },
  followUp: () =>
    'Report each entry of items[] separately. If an app shows no final state, do not resubmit; ' +
    'check nas_app_get with view "status".',
});

export const appTools: ToolSpec[] = [appList, appGet, appManage];
