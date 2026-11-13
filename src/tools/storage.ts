import { z } from 'zod';
import { ToolInputError, cmd, defineTool, opt, type ToolSpec } from './types.js';

const storageInfo = defineTool({
  name: 'nas_storage_info',
  toolset: 'storage',
  title: 'Disks, storage pools and volumes',
  description:
    'Read storage state. kind "disks" lists internal disks with health and temperature; "volumes" lists ' +
    'storage volumes with total and used space, mount point and warnings; "pools" lists storage pools with ' +
    'RAID level, status and member disks. To answer "are my disks healthy" check both disks and pools; for ' +
    '"how much space is left" use volumes (free = total - used). Sizes are strings in bytes, and a total of ' +
    '"0" means not mounted, so do not compute usage from it. A temperature of 0 means unreadable, not zero ' +
    'degrees. Disk status UNSUPPORTED means health cannot be determined, which is not the same as healthy. A ' +
    'pool reported as GOOD can still contain a missing or unhealthy disk, so also read disks[].status; a ' +
    'missing disk does not make the call fail. kind "smart" returns raw SMART attributes for every disk: this ' +
    'is sensitive diagnostic data, needs admin access and a confirmation, and should be requested only when ' +
    'the user explicitly asks for it. Serial numbers are masked unless show_serial is true, which is likewise ' +
    'only for an explicit request. Pools and volumes cannot be created, expanded or deleted through this server.',
  input: {
    kind: z.enum(['disks', 'pools', 'volumes', 'smart']).describe('What to read.'),
    show_serial: z.boolean().default(false).describe('For "disks" and "smart": show real serial numbers.'),
  },
  minRisk: 'read',
  maxRisk: 'admin',
  risk: (a) => (a.kind === 'smart' ? 'admin' : 'read'),
  build: (a) => {
    if (a.show_serial && a.kind !== 'disks' && a.kind !== 'smart') {
      throw new ToolInputError('show_serial only applies to kind "disks" and "smart".');
    }
    switch (a.kind) {
      case 'disks':
        return { argv: cmd(['storage', 'disk', 'ls'], [opt('show-serial', a.show_serial)]) };
      case 'pools':
        return { argv: cmd(['storage', 'pool', 'ls']) };
      case 'volumes':
        return { argv: cmd(['storage', 'volume', 'ls']) };
      default:
        return { argv: cmd(['storage', 'disk', 'smart'], [opt('show-serial', a.show_serial)]) };
    }
  },
});

export const storageTools: ToolSpec[] = [storageInfo];
