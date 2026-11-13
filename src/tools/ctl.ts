import { z } from 'zod';
import { ToolInputError, cmd, csv, defineTool, opt, type ToolSpec } from './types.js';

const idName = z.string().regex(/^\d+:.+$/, 'Use the form ID:name, for example 1001:bob');

const users = defineTool({
  name: 'nas_users',
  toolset: 'ctl',
  title: 'List users or groups',
  description:
    'kind "users" (default) lists NAS accounts (data.users[]): uid is a number, role is in user_base.role, ' +
    'group membership in user_base.groups[], and an expired account has user_base.is_expired true (there is no ' +
    'server-side filter for expiry, so list all and check the field). names matches exactly and is case ' +
    'sensitive. kind "groups" lists user-created groups with their members (data.groups[]); gid there is a ' +
    'string. The built-in groups admin, users and ughomeusers are not listed and cannot take new members. ' +
    'Passwords are never returned. Users cannot be modified or deleted and groups cannot be created through ' +
    'this server; that is done in the NAS control panel.',
  input: {
    kind: z.enum(['users', 'groups']).default('users').describe('List accounts or user-created groups.'),
    names: z.array(z.string().min(1)).min(1).max(50).optional().describe('"users" only: exact user names.'),
    uids: z.array(z.number().int().min(0)).min(1).max(50).optional().describe('"users" only: user IDs.'),
    role: z.enum(['all', 'admin', 'users']).optional().describe('"users" only: filter by role.'),
    keyword: z.string().min(1).optional().describe('"users" only: text in the user name or description.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.kind === 'groups') {
      if (a.names || a.uids || a.role || a.keyword) {
        throw new ToolInputError('names, uids, role and keyword only apply to kind "users".');
      }
      return { argv: cmd(['ctl', 'group', 'ls']) };
    }
    return {
      argv: cmd(['ctl', 'user', 'ls'], [
        ...(a.names ?? []).map((n) => opt('name', n)),
        csv('uid', a.uids),
        opt('role', a.role),
        opt('keyword', a.keyword),
      ]),
    };
  },
});

const HARDWARE = ['fan', 'beep', 'cpu', 'led', 'zram', 'power', 'ups'] as const;

const systemInfo = defineTool({
  name: 'nas_system_info',
  toolset: 'ctl',
  title: 'System version and hardware settings',
  description:
    'Read one group of system settings. "identity": device model and system version. "update_status": whether ' +
    'a system update exists (read-only; it never starts a check or an update, and UNSPECIFIED means unknown, ' +
    'not up to date). "fan", "beep", "cpu", "led", "zram", "power" and "ups": the corresponding control panel ' +
    'settings. For cpu, when is_support says frequency control is unsupported, the frequency value is ' +
    'meaningless. For ups, read right_now first (true means act immediately); otherwise a standby_time of ' +
    '"-1" means "when the UPS battery is low", not "unset". "identity", "update_status" and "zram" are missing ' +
    'on older control panel versions and then report "not available"; do not retry, and use nas_status with ' +
    'doctor: true for the firmware version instead. Nothing here can be changed through this server.',
  input: {
    kind: z.enum(['identity', 'update_status', ...HARDWARE]).describe('Which settings to read.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.kind === 'identity') return { argv: cmd(['ctl', 'os', 'identity']) };
    if (a.kind === 'update_status') return { argv: cmd(['ctl', 'os', 'update-status']) };
    return { argv: cmd(['ctl', 'hardware', a.kind]) };
  },
});

const userCreate = defineTool({
  name: 'nas_user_create',
  toolset: 'ctl',
  title: 'Create a NAS user',
  description:
    'Create a local NAS account. role "admin" grants administrator rights and must only be used when the user ' +
    'explicitly asked for an administrator. The password is sent to the NAS without appearing in any command ' +
    'line or preview; do not repeat it in your reply. groups takes entries of the form GID:name taken from ' +
    'nas_users with kind "groups". On success data.value is the new uid. If the call fails, check with ' +
    'nas_users whether the account exists before doing anything else, and do not retry automatically; an ' +
    'existing user name is reported as a uniqueness error.',
  input: {
    username: z.string().min(1).describe('Login name of the new account.'),
    password: z.string().min(1).describe('Initial password. Never echo it back to the user.'),
    role: z.enum(['users', 'admin']).default('users').describe('"users" for a normal account, "admin" for an administrator.'),
    nickname: z.string().min(1).optional().describe('Display name.'),
    description: z.string().min(1).optional().describe('Free-text description.'),
    email: z.string().min(1).optional().describe('E-mail address.'),
    groups: z.array(idName).min(1).max(20).optional().describe('Groups to join, each as GID:name.'),
    force_change_password: z.boolean().default(false).describe('Require a password change at first login.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  // The password is read by unc from stdin, so it never shows up in the process list.
  build: (a) => ({
    argv: cmd(
      ['ctl', 'user', 'create'],
      [
        '--password-stdin',
        opt('role', a.role),
        opt('nickname', a.nickname),
        opt('description', a.description),
        opt('email', a.email),
        ...(a.groups ?? []).map((g) => opt('group', g)),
        opt('force-change-password', a.force_change_password),
      ],
      [a.username],
    ),
    stdin: a.password,
  }),
  followUp: () => 'Verify with nas_users (names: [username]) that the account exists. Do not repeat the password.',
});

const groupAddMember = defineTool({
  name: 'nas_group_add_member',
  toolset: 'ctl',
  title: 'Add users to a group',
  description:
    'Add users to a user-created group. Before calling, look up both sides with nas_users: the group must ' +
    'appear under kind "groups" (take its gid), each user must exist (take uid and user name), and must not ' +
    'already be a member. If any of that does not hold, stop and tell the user instead of calling this tool; ' +
    'do not create a user on your own. Members are written as UID:username. The built-in groups admin (gid ' +
    '10), users (100) and ughomeusers (133) cannot take members; the user has to create a group in the NAS ' +
    'control panel first. This only adds members; it never removes any.',
  input: {
    gid: z.number().int().min(1).describe('Group ID from nas_users kind "groups".'),
    members: z.array(idName).min(1).max(20).describe('Users to add, each as UID:username.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => ({ argv: cmd(['ctl', 'group', 'add-member'], [], [String(a.gid), ...a.members]) }),
  followUp: () => 'Verify with nas_users kind "groups" that the members now appear in the group.',
});

export const ctlTools: ToolSpec[] = [users, systemInfo, userCreate, groupAddMember];
