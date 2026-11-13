import { z } from 'zod';
import { assertParamKey, sortOrder } from './schemas.js';
import { ToolInputError, cmd, csv, defineTool, opt, requestTimeout, type ToolSpec } from './types.js';

/** Seconds allowed for one synchronous start, stop, restart or rebuild. */
const SLOW_REQUEST_SECONDS = 300;

const inputError = (message: string) => new ToolInputError(message);

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

const dockerContainers = defineTool({
  name: 'nas_docker_containers',
  toolset: 'docker',
  title: 'List Docker containers',
  description:
    'List containers with their state, image, CPU and memory use, and published ports (data.result[]). This is ' +
    'the place to read a container\'s CPU and memory; mem_used is a string holding bytes. The status filter ' +
    'takes "running" or "stopped", while the status field in the response uses a different set ' +
    '(CONTAINER_DETAIL_STATUS_RUNNING, _EXITED, _RESTARTING, _UPDATING), so do not feed response values back ' +
    'into the filter. port_mappings is only filled for running containers, so an empty list does not prove that ' +
    'no ports are configured. Mounts, environment variables, restart policy, network mode and health checks ' +
    'cannot be read through this server; point the user to the Docker app on the NAS for those.',
  input: {
    name: z.string().min(1).optional().describe('Only containers whose name contains this text.'),
    status: z.array(z.enum(['running', 'stopped'])).min(1).optional().describe('Only containers in these states.'),
    type: z
      .array(z.enum(['app', 'general', 'project']))
      .min(1)
      .optional()
      .describe('Only app-center apps, plain containers, or Compose project containers.'),
    update_state: z.array(z.enum(['available', 'none'])).min(1).optional().describe('Filter by image update availability.'),
    sort_by: z.enum(['create-time', 'name', 'status']).optional().describe('Sort key.'),
    order: sortOrder.optional(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => ({
    argv: cmd(['docker', 'ps'], [
      opt('name', a.name),
      csv('status', a.status),
      csv('type', a.type),
      csv('update-state', a.update_state),
      opt('sort-by', a.sort_by),
      opt('order', a.order),
    ]),
  }),
});

const dockerImages = defineTool({
  name: 'nas_docker_images',
  toolset: 'docker',
  title: 'List local images or search a registry',
  description:
    'source "local" (default) lists the images stored on the NAS (data.result[]), optionally filtered by name ' +
    'or status and sorted; image_size is a string holding bytes. To find what can be cleaned up, filter status ' +
    '"unused" and sort by size. source "registry" searches the remote image registry for name ' +
    '(data.search_image[]) and supports page and page_size. Images cannot be deleted through this server; the ' +
    'user has to do that in the Docker app on the NAS.',
  input: {
    source: z.enum(['local', 'registry']).default('local').describe('Images on the NAS, or the remote registry.'),
    name: z.string().min(1).optional().describe('Name filter for "local"; the search term (required) for "registry".'),
    status: z.array(z.enum(['in-use', 'unused', 'error'])).min(1).optional().describe('"local" only: image states.'),
    sort_by: z.enum(['name', 'size']).optional().describe('"local" only: sort key.'),
    order: sortOrder.optional(),
    page: z.number().int().min(1).optional().describe('"registry" only: page number.'),
    page_size: z.number().int().min(1).max(100).optional().describe('"registry" only: results per page.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.source === 'registry') {
      if (!a.name) throw new ToolInputError('source "registry" needs name as the search term.');
      if (a.status || a.sort_by || a.order) {
        throw new ToolInputError('status, sort_by and order only apply to source "local".');
      }
      return { argv: cmd(['docker', 'search'], [opt('page', a.page), opt('page-size', a.page_size)], [a.name]) };
    }
    if (a.page !== undefined || a.page_size !== undefined) {
      throw new ToolInputError('page and page_size only apply to source "registry".');
    }
    return {
      argv: cmd(['docker', 'images'], [opt('name', a.name), csv('status', a.status), opt('sort-by', a.sort_by), opt('order', a.order)]),
    };
  },
});

const dockerProjects = defineTool({
  name: 'nas_docker_projects',
  toolset: 'docker',
  title: 'List Compose projects',
  description:
    'List Docker Compose projects (data.projects[]) with status, path, container counts and whether image ' +
    'updates are available. Projects that carry an application_id are managed by the app center: they cannot ' +
    'be deleted here and must be uninstalled with nas_app_manage. update_available is three-state: omit it for ' +
    'no filter, true for projects with updates, false for projects without. A status ending in _OPERATING ' +
    'means an operation is still in progress. data.original_total is the unfiltered project count.',
  input: {
    name: z.string().min(1).optional().describe('Only projects whose name contains this text.'),
    status: z
      .array(z.enum(['abnormal', 'creating', 'exited', 'failed', 'operating', 'running', 'updating']))
      .min(1)
      .optional()
      .describe('Only projects in these states.'),
    update_available: z.boolean().optional().describe('true: only with image updates; false: only without.'),
    kind: z.enum(['app', 'ordinary']).optional().describe('Only app-center projects, or only user-created ones.'),
    sort_by: z.enum(['create-time', 'name', 'status']).optional().describe('Sort key.'),
    order: sortOrder.optional(),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => ({
    argv: cmd(['docker', 'compose', 'ls'], [
      opt('name', a.name),
      csv('status', a.status),
      a.update_available === undefined ? undefined : `--update-available=${a.update_available}`,
      a.kind === 'app' ? '--app-only' : a.kind === 'ordinary' ? '--ordinary-only' : undefined,
      opt('sort-by', a.sort_by),
      opt('order', a.order),
    ]),
  }),
});

const dockerLogs = defineTool({
  name: 'nas_docker_logs',
  toolset: 'docker',
  title: 'Read container or project logs',
  description:
    'Fetch recent log output (data.logs, one multi-line string). target "container" takes the full ' +
    'container_id from nas_docker_containers and returns the latest 200 entries. target "project" takes a ' +
    'project_name from nas_docker_projects and returns the combined log of all its containers, 200 lines in ' +
    'total, possibly with ANSI colour codes. There is no way to get older lines, follow the log or filter by ' +
    'time; for that the user needs the Docker app on the NAS.',
  input: {
    target: z.enum(['container', 'project']).describe('Whose log to read.'),
    id: z.string().min(1).describe('Full container_id, or the Compose project_name.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => ({ argv: cmd(a.target === 'container' ? ['docker', 'logs'] : ['docker', 'compose', 'logs'], [], [a.id]) }),
});

const dockerCheck = defineTool({
  name: 'nas_docker_check',
  toolset: 'docker',
  title: 'Pre-deployment checks',
  description:
    'Check for conflicts before deploying. kind "port" tells whether a host port is taken by a container ' +
    '(needs port; protocol optional). kind "dir" tells whether a folder is mounted by a container (needs dir). ' +
    'kind "gpu" tells whether an app is using the discrete GPU of the given vendor (needs vendor; ask the user ' +
    'if unknown). These checks only see Docker containers: occupied: false does not guarantee that the port is ' +
    'free, because other services on the NAS are not covered.',
  input: {
    kind: z.enum(['port', 'dir', 'gpu']).describe('What to check.'),
    port: z.number().int().min(1).max(65535).optional().describe('For "port": the host port.'),
    protocol: z.enum(['tcp', 'udp']).optional().describe('For "port": protocol; omit for the NAS default.'),
    dir: z.string().min(1).optional().describe('For "dir": absolute NAS folder.'),
    vendor: z.enum(['nvidia', 'amd', 'intel']).optional().describe('For "gpu": GPU vendor.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.kind === 'port') {
      if (a.port === undefined) throw new ToolInputError('kind "port" needs port.');
      return { argv: cmd(['docker', 'port-check'], [opt('protocol', a.protocol)], [String(a.port)]) };
    }
    if (a.kind === 'dir') {
      if (!a.dir) throw new ToolInputError('kind "dir" needs dir.');
      return { argv: cmd(['docker', 'dir-check'], [], [a.dir]) };
    }
    if (!a.vendor) throw new ToolInputError('kind "gpu" needs vendor (nvidia, amd or intel).');
    return { argv: cmd(['docker', 'gpu-check'], [opt('vendor', a.vendor)]) };
  },
});

const dockerAppUsage = defineTool({
  name: 'nas_docker_app_usage',
  toolset: 'docker',
  title: 'Resource use of app-center Docker apps',
  description:
    'Report CPU, memory, network and disk rates for Docker-based apps installed from the app center ' +
    '(data.usages, keyed by app ID). It only covers app-center apps: a plain container or a self-made Compose ' +
    'project, or a misspelled ID, comes back as all zeros without an error, so zeros do not mean idle. App IDs ' +
    'are the application field of nas_docker_containers. For any container\'s CPU and memory use ' +
    'nas_docker_containers instead. Rates are strings in bytes per second.',
  input: {
    app_ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('App IDs; omit for all app-center apps.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => ({ argv: cmd(['docker', 'stats'], [], a.app_ids ?? []) }),
});

// ---------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------

const dockerPull = defineTool({
  name: 'nas_docker_pull',
  toolset: 'docker',
  title: 'Pull an image',
  description:
    'Ask the NAS to pull a Docker image. The reference must include a tag or digest, such as nginx:latest or ' +
    'library/redis:7.2; if the user named no tag, ask which one or say that latest will be used. The call ' +
    'returns as soon as the pull is submitted. Poll nas_docker_images (filter by name) until the image shows ' +
    'as completed; a failed pull shows as failed, or its entry disappears when the registry is unreachable. ' +
    'Pulling adds an image and uses disk space and bandwidth but does not change existing containers.',
  input: {
    image: z
      .string()
      .regex(/^\S+(:[\w.-]+|@sha256:[0-9a-f]{64})$/, 'Include a tag or digest, for example nginx:latest')
      .describe('Image reference with tag or digest.'),
  },
  minRisk: 'write',
  maxRisk: 'write',
  risk: () => 'write',
  build: (a) => ({ argv: cmd(['docker', 'pull'], [], [a.image]) }),
  followUp: () => 'The pull runs in the background. Confirm with nas_docker_images that the image arrived before reporting success.',
});

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

const dockerContainerControl = defineTool({
  name: 'nas_docker_container_control',
  toolset: 'docker',
  title: 'Start, stop or restart containers',
  description:
    'Start, stop or restart containers by their full container_id from nas_docker_containers. The operation is ' +
    'synchronous: success means it is done. Stopping or restarting interrupts the service. The result has ' +
    'items[], one per container. Stopping a container that is already stopped fails with "already closed"; ' +
    'that is not a fault, so check the status first. For containers that belong to a Compose project, prefer ' +
    'nas_docker_project_control on the whole project. If the NAS answers with HTTP 401 and "user information ' +
    'is required", that is a known problem on the NAS side which logging in again does not fix: use ' +
    'nas_docker_project_control instead and tell the user.',
  input: {
    action: z.enum(['start', 'stop', 'restart']).describe('What to do.'),
    container_ids: z.array(z.string().min(1)).min(1).max(20).describe('Full container IDs.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => ({
    argv: cmd(['docker', a.action], [], a.container_ids),
    ...requestTimeout(SLOW_REQUEST_SECONDS, a.container_ids.length),
  }),
});

const dockerProjectControl = defineTool({
  name: 'nas_docker_project_control',
  toolset: 'docker',
  title: 'Start, stop, restart or delete a Compose project',
  description:
    'Control a Compose project by its project_name from nas_docker_projects. All four actions are ' +
    'asynchronous: the response is an empty object that only means "accepted". Poll nas_docker_projects until ' +
    'the status is no longer _OPERATING, and do not send the same request again meanwhile. "delete" runs ' +
    'compose down and removes the project record; it cannot be undone, though the compose file stays in the ' +
    'project folder. Deleting a project managed by the app center (one with an application_id), or one that ' +
    'does not exist, is silently ignored and still reports success, so never report a deletion until ' +
    'nas_docker_projects shows the project is gone. delete_images also removes images used only by this project.',
  input: {
    action: z.enum(['start', 'stop', 'restart', 'delete']).describe('What to do.'),
    project: z.string().min(1).describe('project_name from nas_docker_projects.'),
    delete_images: z.boolean().default(false).describe('For "delete": also remove images no other project uses.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => {
    if (a.delete_images && a.action !== 'delete') throw new ToolInputError('delete_images only applies to action "delete".');
    return { argv: cmd(['docker', 'compose', a.action], [opt('delete-images', a.delete_images)], [a.project]) };
  },
  followUp: (a) =>
    'Accepted, not finished. Poll nas_docker_projects until the status settles.' +
    (a.action === 'delete' ? ' For delete, confirm the project is gone before reporting success.' : ''),
});

const dockerProjectCreate = defineTool({
  name: 'nas_docker_project_create',
  toolset: 'docker',
  title: 'Create a Compose project',
  description:
    'Create a Docker Compose project from YAML. The name, the folder and the YAML must come from the user; do ' +
    'not invent them. path must be an existing folder (create it with nas_file_mkdir first). Check ' +
    'nas_docker_projects beforehand: a project of the same name is refused, but reusing the folder of another ' +
    'project succeeds and silently overwrites that project\'s compose file, so never reuse a folder. Containers ' +
    'are created even without run; run also starts them. The response is an empty object; verify with ' +
    'nas_docker_projects. An error mentioning code 2040 means the YAML is invalid: do not retry the same content.',
  input: {
    name: z.string().min(1).describe('Project name.'),
    path: z.string().min(1).describe('Existing NAS folder for the project, for example /volume1/docker/blog.'),
    compose_yaml: z.string().min(1).describe('The full docker-compose YAML.'),
    run: z.boolean().default(false).describe('Start the project right after creating it.'),
    latest_images: z.boolean().default(false).describe('Pull the newest images.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  // Compose files often hold passwords, so the YAML goes through stdin instead of the argument list.
  build: (a) => ({
    argv: cmd(['docker', 'compose', 'up'], [
      opt('name', a.name),
      opt('path', a.path),
      opt('run', a.run),
      opt('latest-images', a.latest_images),
    ]),
    stdin: a.compose_yaml,
  }),
  followUp: () => 'Verify with nas_docker_projects that the project exists and has the expected status.',
});

const dockerAppRebuild = defineTool({
  name: 'nas_docker_app_rebuild',
  toolset: 'docker',
  title: 'Rebuild an app-center container app',
  description:
    'Rebuild a Docker app from the app center with new parameters. app_id is the full app ID ' +
    '(com.ugreen.docker.<name>), not a container or project name. The app ID, the path and every parameter ' +
    'must be supplied by the user: none of them can be discovered with the query tools, and guessing rebuilds ' +
    'the app with a wrong configuration. If the user only said "rebuild X", ask for these values. The call is ' +
    'synchronous and the container ID changes. An error containing "record not found" means the app_id is ' +
    'wrong; do not retry. Use kind "path" for parameters that are NAS paths, and a list of strings for ' +
    'multi-value parameters.',
  input: {
    app_id: z.string().min(1).describe('Full app-center app ID.'),
    path: z.string().min(1).optional().describe('App path as defined by the app center.'),
    params: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.union([z.string(), z.array(z.string()).min(1)]),
          kind: z.enum(['plain', 'path']).optional(),
        }),
      )
      .max(50)
      .optional()
      .describe('Parameters as { key, value }; value may be a list; kind "path" marks a NAS path.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => {
    const params = (a.params ?? []).map((p) => {
      assertParamKey(p.key, inputError);
      if (Array.isArray(p.value)) return `--param-multi=${p.key}=${p.value.join(',')}`;
      return p.kind === 'path' ? `--param-path=${p.key}=${p.value}` : `--param=${p.key}=${p.value}`;
    });
    return {
      argv: cmd(['docker', 'rebuild'], [opt('path', a.path), ...params], [a.app_id]),
      ...requestTimeout(SLOW_REQUEST_SECONDS),
    };
  },
  followUp: () => 'Verify with nas_docker_containers that the app is running again; its container ID has changed.',
});

export const dockerTools: ToolSpec[] = [
  dockerContainers,
  dockerImages,
  dockerProjects,
  dockerLogs,
  dockerCheck,
  dockerAppUsage,
  dockerPull,
  dockerContainerControl,
  dockerProjectControl,
  dockerProjectCreate,
  dockerAppRebuild,
];
