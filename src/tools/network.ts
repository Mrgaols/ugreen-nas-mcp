import { z } from 'zod';
import { ToolInputError, cmd, defineTool, type ToolSpec } from './types.js';

const networkInfo = defineTool({
  name: 'nas_network_info',
  toolset: 'network',
  title: 'Network interfaces and general network settings',
  description:
    'kind "interfaces" (default) lists network interfaces (data.ifaces[]) with link state, speed, MAC and ' +
    'IPv4/IPv6 settings; pass iface to see only one. To find the NAS address, take an interface whose ' +
    'connection is CONNECT_STATUS_CONNECTED and whose ipv4.ip_addr is not empty: decide by ip_addr, not by ' +
    'ipv4.status, which reads "enabled" even without an address. A speed of -1 or 0 means no link. An unknown ' +
    'interface name returns an empty list rather than an error. kind "general" returns the default gateway, ' +
    'DNS mode and servers, and proxy settings; the manual DNS list there only applies in manual mode and may ' +
    'differ from the per-interface DNS, so report both when asked about DNS. Network settings cannot be ' +
    'changed through this server.',
  input: {
    kind: z.enum(['interfaces', 'general']).default('interfaces').describe('Interfaces, or gateway/DNS/proxy.'),
    iface: z.string().min(1).optional().describe('"interfaces" only: one interface name, for example eth0.'),
  },
  minRisk: 'read',
  maxRisk: 'read',
  risk: () => 'read',
  build: (a) => {
    if (a.kind === 'general') {
      if (a.iface) throw new ToolInputError('iface only applies to kind "interfaces".');
      return { argv: cmd(['network', 'general']) };
    }
    return { argv: cmd(['network', 'iface', 'ls'], [], a.iface ? [a.iface] : []) };
  },
});

export const networkTools: ToolSpec[] = [networkInfo];
