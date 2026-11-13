import { z } from 'zod';

/** Upper limit for a streaming unc command. */
export const timeoutSeconds = (defaultSeconds = 120) =>
  z
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(defaultSeconds)
    .describe(
      `Time limit in seconds (default ${defaultSeconds}, max 1800). Raise it for large folders or files; ` +
        'a result cut off by the limit is incomplete.',
    );

/** A size such as 500, 10K, 4M or 2G. */
export const sizeFilter = (what: string) =>
  z
    .string()
    .regex(/^\d+[KMG]?$/, 'Use a whole number with an optional K, M or G suffix, for example 500, 10K, 4M, 2G')
    .describe(`${what} Bytes, or a number with K, M or G, for example 10K or 4M.`);

export const unixSeconds = (what: string) => z.number().int().min(0).describe(`${what} Unix time in seconds.`);

export const sortOrder = z.enum(['asc', 'desc']).describe('Sort direction.');

/** KEY=VALUE pairs must be split at the first "=", so the key itself may not contain one. */
export function assertParamKey(key: string, makeError: (message: string) => Error): void {
  if (key.length === 0 || key.includes('=')) {
    throw makeError(`Parameter key must be non-empty and must not contain "=": ${JSON.stringify(key)}`);
  }
}
