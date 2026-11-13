import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_users', {}, ['ctl', 'user', 'ls'], 'read'],
  [
    'nas_users',
    { names: ['bob', 'amy'], uids: [1000, 1001], role: 'admin', keyword: 'ali' },
    ['ctl', 'user', 'ls', '--name=bob', '--name=amy', '--uid=1000,1001', '--role=admin', '--keyword=ali'],
    'read',
  ],
  ['nas_users', { kind: 'groups' }, ['ctl', 'group', 'ls'], 'read'],
  ['nas_system_info', { kind: 'identity' }, ['ctl', 'os', 'identity'], 'read'],
  ['nas_system_info', { kind: 'update_status' }, ['ctl', 'os', 'update-status'], 'read'],
  ['nas_system_info', { kind: 'fan' }, ['ctl', 'hardware', 'fan'], 'read'],
  ['nas_system_info', { kind: 'ups' }, ['ctl', 'hardware', 'ups'], 'read'],
  [
    'nas_user_create',
    {
      username: 'bob',
      password: 's3cret',
      nickname: 'Bob',
      description: 'x y',
      email: 'b@e.com',
      groups: ['1000:family', '1001:work'],
      force_change_password: true,
    },
    [
      'ctl', 'user', 'create', '--password-stdin', '--role=users', '--nickname=Bob', '--description=x y', '--email=b@e.com',
      '--group=1000:family', '--group=1001:work', '--force-change-password', '--', 'bob',
    ],
    'admin',
  ],
  ['nas_user_create', { username: 'root2', password: 'p', role: 'admin' }, ['ctl', 'user', 'create', '--password-stdin', '--role=admin', '--', 'root2'], 'admin'],
  [
    'nas_group_add_member',
    { gid: 1000, members: ['1001:bob', '1002:amy'] },
    ['ctl', 'group', 'add-member', '--', '1000', '1001:bob', '1002:amy'],
    'admin',
  ],
  ['nas_network_info', {}, ['network', 'iface', 'ls'], 'read'],
  ['nas_network_info', { iface: 'eth0' }, ['network', 'iface', 'ls', '--', 'eth0'], 'read'],
  ['nas_network_info', { kind: 'general' }, ['network', 'general'], 'read'],
  ['nas_performance', {}, ['taskmgr', 'overview'], 'read'],
  ['nas_performance', { kind: 'net' }, ['taskmgr', 'net'], 'read'],
  ['nas_performance', { kind: 'volume' }, ['taskmgr', 'volume'], 'read'],
  ['nas_performance', { kind: 'processes', sort: 'cpu' }, ['taskmgr', 'process', 'ls', '--sort=cpu', '--top=10'], 'read'],
  ['nas_performance', { kind: 'processes' }, ['taskmgr', 'process', 'ls', '--top=10'], 'read'],
  ['nas_performance', { kind: 'processes', sort: 'pid', top: 0 }, ['taskmgr', 'process', 'ls', '--sort=pid', '--top=0'], 'read'],
  ['nas_performance', { kind: 'services', sort: 'mem', top: 5 }, ['taskmgr', 'service', 'ls', '--sort=mem', '--top=5'], 'read'],
];

describe('ctl, network and taskmgr tools', () => {
  checkRows(rows);

  it('sends the password through stdin, never argv', () => {
    const c = call('nas_user_create', { username: 'bob', password: 's3cret' });
    expect(c.stdin).toBe('s3cret');
    expect(c.argv.join(' ')).not.toContain('s3cret');
  });

  it('validates combinations', () => {
    expect(() => call('nas_users', { kind: 'groups', role: 'admin' })).toThrowError(ToolInputError);
    expect(() => call('nas_users', { kind: 'groups', names: ['bob'] })).toThrowError(ToolInputError);
    expect(() => call('nas_network_info', { kind: 'general', iface: 'eth0' })).toThrowError(ToolInputError);
    expect(() => call('nas_performance', { kind: 'services', sort: 'pid' })).toThrowError(ToolInputError);
    expect(() => call('nas_performance', { kind: 'cpu', sort: 'cpu' })).toThrowError(ToolInputError);
  });

  it('validates values with the schema', () => {
    tool('nas_group_add_member');
    expect(() => parse('nas_group_add_member', { gid: 1000, members: ['bob'] })).toThrow();
    expect(() => parse('nas_group_add_member', { gid: 1000, members: [] })).toThrow();
    expect(() => parse('nas_user_create', { username: 'bob', password: '' })).toThrow();
    expect(() => parse('nas_user_create', { username: 'bob', password: 'p', groups: ['family'] })).toThrow();
    expect(() => parse('nas_user_create', { username: 'bob', password: 'p', role: 'root' })).toThrow();
    expect(() => parse('nas_system_info', { kind: 'bios' })).toThrow();
    expect(() => parse('nas_performance', { kind: 'processes', top: 201 })).toThrow();
  });

  it('sets registration bounds and follow-up advice', () => {
    expect([tool('nas_users').toolset, tool('nas_users').maxRisk]).toEqual(['ctl', 'read']);
    expect([tool('nas_system_info').toolset, tool('nas_system_info').maxRisk]).toEqual(['ctl', 'read']);
    expect([tool('nas_user_create').toolset, tool('nas_user_create').minRisk]).toEqual(['ctl', 'admin']);
    expect([tool('nas_group_add_member').toolset, tool('nas_group_add_member').minRisk]).toEqual(['ctl', 'admin']);
    expect([tool('nas_network_info').toolset, tool('nas_network_info').maxRisk]).toEqual(['network', 'read']);
    expect([tool('nas_performance').toolset, tool('nas_performance').maxRisk]).toEqual(['taskmgr', 'read']);
    expect(tool('nas_group_add_member').followUp!(parse('nas_group_add_member', { gid: 1000, members: ['1:a'] }))).toContain('nas_users');
    expect(tool('nas_user_create').followUp!(parse('nas_user_create', { username: 'b', password: 'p' }))).toContain('nas_users');
  });
});
