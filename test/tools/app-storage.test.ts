import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_app_list', {}, ['app', 'ls'], 'read'],
  ['nas_app_list', { filter: 'installed' }, ['app', 'ls', '--installed'], 'read'],
  ['nas_app_list', { filter: 'not_installed' }, ['app', 'ls', '--not-installed'], 'read'],
  ['nas_app_list', { filter: 'update_available' }, ['app', 'ls', '--update-available'], 'read'],
  ['nas_app_list', { filter: 'repair_needed' }, ['app', 'ls', '--repair-needed'], 'read'],
  ['nas_app_list', { keyword: 'jellyfin' }, ['app', 'search', '--', 'jellyfin'], 'read'],
  ['nas_app_list', { keyword: 'jellyfin', filter: 'installed' }, ['app', 'search', '--installed', '--', 'jellyfin'], 'read'],
  ['nas_app_get', { app_ids: ['com.ugreen.photos'] }, ['app', 'get', '--', 'com.ugreen.photos'], 'read'],
  ['nas_app_get', { view: 'status', app_ids: ['a', 'b'] }, ['app', 'status', '--', 'a', 'b'], 'read'],
  [
    'nas_app_manage',
    {
      action: 'install',
      app_ids: ['com.example.app'],
      install_path: '/volume1',
      params: [
        { key: 'PORT', value: '8096' },
        { key: 'DIRS', value: ['/a', '/b'] },
      ],
      no_start: true,
    },
    ['app', 'install', '--path=/volume1', '--param=PORT=8096', '--param-multi=DIRS=/a,/b', '--no-start', '--wait-timeout=30m', '--', 'com.example.app'],
    'admin',
  ],
  ['nas_app_manage', { action: 'update', app_ids: ['a', 'b'] }, ['app', 'update', '--wait-timeout=30m', '--', 'a', 'b'], 'admin'],
  [
    'nas_app_manage',
    { action: 'uninstall', app_ids: ['com.example.app'], clean_data: true, wait_timeout_minutes: 10 },
    ['app', 'uninstall', '--clean', '--wait-timeout=10m', '--', 'com.example.app'],
    'admin',
  ],
  ['nas_app_manage', { action: 'start', app_ids: ['com.ugreen.photos'] }, ['app', 'start', '--', 'com.ugreen.photos'], 'admin'],
  ['nas_app_manage', { action: 'stop', app_ids: ['com.ugreen.photos'] }, ['app', 'stop', '--', 'com.ugreen.photos'], 'admin'],
  ['nas_storage_info', { kind: 'disks' }, ['storage', 'disk', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'disks', show_serial: true }, ['storage', 'disk', 'ls', '--show-serial'], 'read'],
  ['nas_storage_info', { kind: 'pools' }, ['storage', 'pool', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'volumes' }, ['storage', 'volume', 'ls'], 'read'],
  ['nas_storage_info', { kind: 'smart' }, ['storage', 'disk', 'smart'], 'admin'],
  ['nas_storage_info', { kind: 'smart', show_serial: true }, ['storage', 'disk', 'smart', '--show-serial'], 'admin'],
];

describe('app and storage tools', () => {
  checkRows(rows);

  it('validates combinations', () => {
    expect(() => call('nas_app_list', { keyword: 'x', filter: 'update_available' })).toThrowError(ToolInputError);
    expect(() => call('nas_app_get', { app_ids: ['a', 'b'] })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'update', app_ids: ['a'], install_path: '/volume1' })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'start', app_ids: ['a'], params: [{ key: 'K', value: 'v' }] })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'install', app_ids: ['a'], clean_data: true })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'stop', app_ids: ['a'], no_start: true })).toThrowError(ToolInputError);
    expect(() => call('nas_app_manage', { action: 'install', app_ids: ['a'], params: [{ key: 'A=B', value: 'x' }] })).toThrowError(ToolInputError);
    expect(() => call('nas_storage_info', { kind: 'pools', show_serial: true })).toThrowError(ToolInputError);
  });

  it('validates values with the schema', () => {
    tool('nas_app_list');
    expect(() => parse('nas_app_list', { keyword: 'x'.repeat(21) })).toThrow();
    expect(() => parse('nas_app_manage', { action: 'install', app_ids: [] })).toThrow();
    expect(() => parse('nas_app_manage', { action: 'install', app_ids: ['a'], wait_timeout_minutes: 61 })).toThrow();
    expect(() => parse('nas_storage_info', {})).toThrow();
  });

  it('waits for long-running app operations', () => {
    expect(call('nas_app_manage', { action: 'install', app_ids: ['a'], install_path: '/volume1' }).timeoutMs).toBe(1_830_000);
    expect(call('nas_app_manage', { action: 'update', app_ids: ['a'], wait_timeout_minutes: 5 }).timeoutMs).toBe(330_000);
    expect(call('nas_app_manage', { action: 'stop', app_ids: ['a'] }).timeoutMs).toBeUndefined();
  });

  it('projects the app list to compact entries', () => {
    const env = {
      success: true,
      action: '/app.App/DetailList',
      data: {
        apps: [
          {
            brief: {
              app_id: 'a',
              name_i18n_map: { 'zh-CN': '云盘', 'en-US': 'Cloud', 'de-DE': 'Wolke' },
              install_status: 'INSTALL_STATUS_INSTALLED',
              installed_version: { version: '1.0', size: '0' },
              cloud_version: { version: '1.1' },
              app_type: 'T',
              icon_path: '/x',
            },
            install_parameters: [{ key: 'k' }],
            i18n: { big: 'blob' },
          },
          { brief: { app_id: 'b', name_i18n_map: { 'en-US': 'Only English' }, install_status: 'INSTALL_STATUS_NOT_INSTALLED' } },
        ],
      },
    };
    expect(tool('nas_app_list').project!(env)).toEqual({
      success: true,
      action: '/app.App/DetailList',
      data: {
        count: 2,
        apps: [
          {
            app_id: 'a',
            name: { 'zh-CN': '云盘', 'en-US': 'Cloud' },
            install_status: 'INSTALL_STATUS_INSTALLED',
            installed_version: '1.0',
            available_version: '1.1',
            app_type: 'T',
          },
          {
            app_id: 'b',
            name: { 'en-US': 'Only English' },
            install_status: 'INSTALL_STATUS_NOT_INSTALLED',
            installed_version: null,
            available_version: null,
            app_type: null,
          },
        ],
      },
    });
  });

  it('leaves an unexpected envelope untouched', () => {
    const env = { success: true, data: { something: 'else' } };
    expect(tool('nas_app_list').project!(env)).toEqual(env);
    expect(tool('nas_app_list').project!({ success: true })).toEqual({ success: true });
  });

  it('does not project the detail and status views', () => {
    expect(tool('nas_app_get').project).toBeUndefined();
  });

  it('sets registration bounds and follow-up advice', () => {
    expect([tool('nas_storage_info').toolset, tool('nas_storage_info').minRisk, tool('nas_storage_info').maxRisk]).toEqual(['storage', 'read', 'admin']);
    expect([tool('nas_app_manage').toolset, tool('nas_app_manage').minRisk, tool('nas_app_manage').maxRisk]).toEqual(['app', 'admin', 'admin']);
    expect([tool('nas_app_list').minRisk, tool('nas_app_list').maxRisk]).toEqual(['read', 'read']);
    expect(tool('nas_app_manage').followUp!(parse('nas_app_manage', { action: 'install', app_ids: ['a'] }))).toContain('nas_app_get');
  });
});
