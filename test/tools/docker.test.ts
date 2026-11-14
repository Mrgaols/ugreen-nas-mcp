import { describe, it, expect } from 'vitest';
import { tool, parse, call, checkRows, type Row } from './helpers.js';
import { ToolInputError } from '../../src/tools/types.js';

const rows: Row[] = [
  ['nas_docker_containers', {}, ['docker', 'ps'], 'read'],
  [
    'nas_docker_containers',
    { name: 'nginx', status: ['running'], type: ['app', 'project'], update_state: ['available'], sort_by: 'name', order: 'asc' },
    ['docker', 'ps', '--name=nginx', '--status=running', '--type=app,project', '--update-state=available', '--sort-by=name', '--order=asc'],
    'read',
  ],
  ['nas_docker_images', {}, ['docker', 'images'], 'read'],
  [
    'nas_docker_images',
    { name: 'ng', status: ['unused'], sort_by: 'size', order: 'desc' },
    ['docker', 'images', '--name=ng', '--status=unused', '--sort-by=size', '--order=desc'],
    'read',
  ],
  ['nas_docker_images', { source: 'registry', name: 'redis', page: 1, page_size: 10 }, ['docker', 'search', '--page=1', '--page-size=10', '--', 'redis'], 'read'],
  ['nas_docker_projects', {}, ['docker', 'compose', 'ls'], 'read'],
  [
    'nas_docker_projects',
    { name: 'blog', status: ['running', 'exited'], update_available: false, kind: 'ordinary', sort_by: 'status' },
    ['docker', 'compose', 'ls', '--name=blog', '--status=running,exited', '--update-available=false', '--ordinary-only', '--sort-by=status'],
    'read',
  ],
  ['nas_docker_projects', { update_available: true, kind: 'app' }, ['docker', 'compose', 'ls', '--update-available=true', '--app-only'], 'read'],
  ['nas_docker_logs', { target: 'container', id: '-rf' }, ['docker', 'logs', '--', '-rf'], 'read'],
  ['nas_docker_logs', { target: 'project', id: 'blog' }, ['docker', 'compose', 'logs', '--', 'blog'], 'read'],
  ['nas_docker_check', { kind: 'port', port: 53, protocol: 'udp' }, ['docker', 'port-check', '--protocol=udp', '--', '53'], 'read'],
  ['nas_docker_check', { kind: 'port', port: 8080 }, ['docker', 'port-check', '--', '8080'], 'read'],
  ['nas_docker_check', { kind: 'dir', dir: '/volume1/docker/app' }, ['docker', 'dir-check', '--', '/volume1/docker/app'], 'read'],
  ['nas_docker_check', { kind: 'gpu', vendor: 'nvidia' }, ['docker', 'gpu-check', '--vendor=nvidia'], 'read'],
  ['nas_docker_app_usage', {}, ['docker', 'stats'], 'read'],
  ['nas_docker_app_usage', { app_ids: ['com.ugreen.docker.openlist'] }, ['docker', 'stats', '--', 'com.ugreen.docker.openlist'], 'read'],
  ['nas_docker_pull', { image: 'nginx:latest' }, ['docker', 'pull', '--', 'nginx:latest'], 'write'],
  ['nas_docker_container_control', { action: 'stop', container_ids: ['c0ffee', 'dead'] }, ['docker', 'stop', '--', 'c0ffee', 'dead'], 'admin'],
  ['nas_docker_container_control', { action: 'start', container_ids: ['c0ffee'] }, ['docker', 'start', '--', 'c0ffee'], 'admin'],
  ['nas_docker_project_control', { action: 'restart', project: 'blog' }, ['docker', 'compose', 'restart', '--', 'blog'], 'admin'],
  [
    'nas_docker_project_control',
    { action: 'delete', project: 'blog', delete_images: true },
    ['docker', 'compose', 'delete', '--delete-images', '--', 'blog'],
    'admin',
  ],
  [
    'nas_docker_project_create',
    { name: 'blog', path: '/volume1/docker/blog', compose_yaml: 'services: {}', run: true, latest_images: true },
    ['docker', 'compose', 'up', '--name=blog', '--path=/volume1/docker/blog', '--run', '--latest-images'],
    'admin',
  ],
  [
    'nas_docker_app_rebuild',
    {
      app_id: 'com.ugreen.docker.jellyfin',
      path: '/volume1/docker/jellyfin',
      params: [
        { key: 'TZ', value: 'Asia/Shanghai' },
        { key: 'MEDIA', value: '/volume1/media', kind: 'path' },
        { key: 'DNS', value: ['1.1.1.1', '8.8.8.8'] },
      ],
    },
    [
      'docker', 'rebuild', '--path=/volume1/docker/jellyfin', '--param=TZ=Asia/Shanghai', '--param-path=MEDIA=/volume1/media',
      '--param-multi=DNS=1.1.1.1,8.8.8.8', '--', 'com.ugreen.docker.jellyfin',
    ],
    'admin',
  ],
  ['nas_docker_app_rebuild', { app_id: 'a.b' }, ['docker', 'rebuild', '--', 'a.b'], 'admin'],
];

describe('docker tools', () => {
  checkRows(rows);

  it('sends compose YAML through stdin, never argv', () => {
    const yaml = 'services:\n  db:\n    environment:\n      PASSWORD: hunter2\n';
    const c = call('nas_docker_project_create', { name: 'x', path: '/p', compose_yaml: yaml });
    expect(c.stdin).toBe(yaml);
    expect(c.argv.join(' ')).not.toContain('hunter2');
  });

  it('validates combinations', () => {
    expect(() => call('nas_docker_images', { source: 'registry' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_images', { source: 'registry', name: 'x', status: ['unused'] })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_images', { name: 'x', page: 2 })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'port' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'dir' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_check', { kind: 'gpu' })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_project_control', { action: 'stop', project: 'b', delete_images: true })).toThrowError(ToolInputError);
    expect(() => call('nas_docker_app_rebuild', { app_id: 'a', params: [{ key: 'A=B', value: 'x' }] })).toThrowError(ToolInputError);
  });

  it('validates values with the schema', () => {
    tool('nas_docker_pull');
    expect(() => parse('nas_docker_pull', { image: 'nginx' })).toThrow();
    expect(() => parse('nas_docker_pull', { image: 'registry.local:5000/team/app' })).toThrow();
    expect(parse('nas_docker_pull', { image: 'registry.local:5000/team/app:1.2' }).image).toBe('registry.local:5000/team/app:1.2');
    expect(parse('nas_docker_pull', { image: `nginx@sha256:${'a'.repeat(64)}` }).image).toContain('@sha256:');
    expect(() => parse('nas_docker_project_create', { name: 'x', path: '/p', compose_yaml: '' })).toThrow();
    expect(() => parse('nas_docker_check', { kind: 'port', port: 70000 })).toThrow();
    expect(() => parse('nas_docker_container_control', { action: 'stop', container_ids: [] })).toThrow();
    expect(() => parse('nas_docker_containers', { status: ['CONTAINER_STATUS_RUNNING'] })).toThrow();
  });

  it('warns that lifecycle operations are asynchronous', () => {
    expect(
      tool('nas_docker_project_control').followUp!(parse('nas_docker_project_control', { action: 'delete', project: 'b' })),
    ).toContain('nas_docker_projects');
    expect(tool('nas_docker_pull').followUp!(parse('nas_docker_pull', { image: 'nginx:latest' }))).toContain('nas_docker_images');
    expect(
      tool('nas_docker_project_create').followUp!(parse('nas_docker_project_create', { name: 'x', path: '/p', compose_yaml: 'a: 1' })),
    ).toContain('nas_docker_projects');
    expect(tool('nas_docker_app_rebuild').followUp!(parse('nas_docker_app_rebuild', { app_id: 'a' }))).toContain('nas_docker_containers');
  });

  it('sets registration bounds', () => {
    for (const n of ['nas_docker_containers', 'nas_docker_images', 'nas_docker_projects', 'nas_docker_logs', 'nas_docker_check', 'nas_docker_app_usage']) {
      expect([tool(n).toolset, tool(n).minRisk, tool(n).maxRisk]).toEqual(['docker', 'read', 'read']);
    }
    expect([tool('nas_docker_pull').minRisk, tool('nas_docker_pull').maxRisk]).toEqual(['write', 'write']);
    for (const n of ['nas_docker_container_control', 'nas_docker_project_control', 'nas_docker_project_create', 'nas_docker_app_rebuild']) {
      expect([tool(n).minRisk, tool(n).maxRisk]).toEqual(['admin', 'admin']);
    }
  });
});

describe('review: synchronous docker operations', () => {
  it('get a longer unc request timeout', () => {
    expect(tool('nas_docker_app_rebuild')).toBeDefined();
    expect(call('nas_docker_app_rebuild', { app_id: 'a.b' })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 315_000 });
    expect(call('nas_docker_container_control', { action: 'restart', container_ids: ['a', 'b'] })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 615_000 });
  });
});

describe('second review: docker', () => {
  it('puts the folder of a dir check under the path allowlist', () => {
    const check = tool('nas_docker_check');
    expect(check.nasPaths!(parse('nas_docker_check', { kind: 'dir', dir: '/volume1/docker' }))).toEqual(['/volume1/docker']);
    expect(check.nasPaths!(parse('nas_docker_check', { kind: 'port', port: 80 }))).toEqual([]);
  });

  it('gives project creation a longer request timeout and a size limit', () => {
    expect(call('nas_docker_project_create', { name: 'n', path: '/volume1/docker/n', compose_yaml: 'services: {}' })).toMatchObject({ requestTimeoutSeconds: 300, timeoutMs: 315_000 });
    expect(() => parse('nas_docker_project_create', { name: 'n', path: '/p', compose_yaml: 'x'.repeat(1_048_577) })).toThrow();
  });
});
