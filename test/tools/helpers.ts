import { it, expect } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS } from '../../src/tools/index.js';
import type { BuildContext, ToolSpec, UncCall } from '../../src/tools/types.js';
import type { Risk } from '../../src/policy.js';

export function tool(name: string): ToolSpec {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`tool is not registered: ${name}`);
  return found;
}

/** Validates like the server does, so defaults are applied. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parse(name: string, args: Record<string, unknown>): any {
  return z.object(tool(name).input).parse(args);
}

export function call(name: string, args: Record<string, unknown>, ctx: BuildContext = {}): UncCall {
  return tool(name).build(parse(name, args), ctx);
}

export function riskOf(name: string, args: Record<string, unknown>): Risk {
  return tool(name).risk(parse(name, args));
}

export type Row = [name: string, args: Record<string, unknown>, argv: string[], risk: Risk];

/** One test per row: the arguments must produce exactly this unc argument list and this risk. */
export function checkRows(rows: Row[]): void {
  it.each(rows)('%s %j', (name, args, argv, risk) => {
    expect(call(name, args).argv).toEqual(argv);
    expect(riskOf(name, args)).toBe(risk);
  });
}
