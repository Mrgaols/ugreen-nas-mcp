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
    'missing disk does not make the call fail. Serial numbers are masked unless show_serial is true, which is ' +
    'only for an explicit request. Raw SMART attributes are a separate tool, nas_storage_smart. Pools and ' +
    'volumes cannot be created, expanded or deleted through this server.',
  input: {
    kind: z.enum(['disks', 'pools', 'volumes']).describe('What to read.'),
    show_serial: z.boolean().default(false).describe('For "disks": show real serial numbers.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.show_serial && a.kind !== 'disks') throw new ToolInputError('show_serial only applies to kind "disks".');
    switch (a.kind) {
      case 'disks':
        return { argv: cmd(['storage', 'disk', 'ls'], [opt('show-serial', a.show_serial)]) };
      case 'pools':
        return { argv: cmd(['storage', 'pool', 'ls']) };
      default:
        return { argv: cmd(['storage', 'volume', 'ls']) };
    }
  },
});

// Kept apart from nas_storage_info so that everyday space and health queries stay a plain read-only tool:
// a tool that can reach admin risk is announced to clients as destructive as a whole.
const storageSmart = defineTool({
  name: 'nas_storage_smart',
  toolset: 'storage',
  title: 'Raw SMART data of the disks',
  description:
    'Read the raw SMART attributes of every internal disk. This is sensitive diagnostic data: it needs admin ' +
    'access and a confirmation, and should be requested only when the user explicitly asks for SMART details. ' +
    'For the usual health question use nas_storage_info with kind "disks" and "pools" instead. Serial numbers ' +
    'are masked unless show_serial is true. Nothing on the NAS is changed by this call.',
  input: {
    show_serial: z.boolean().default(false).describe('Show real serial numbers.'),
  },
  minRisk: 'admin',
  maxRisk: 'admin',
  risk: () => 'admin',
  build: (a) => ({ argv: cmd(['storage', 'disk', 'smart'], [opt('show-serial', a.show_serial)]) }),
});

export const storageTools: ToolSpec[] = [storageInfo, storageSmart];
