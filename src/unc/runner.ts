import { spawn } from 'node:child_process';

export interface UncResult {
  /** null when the process was killed or never started. */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** True when the process was stopped because it printed more than the output cap. */
  overflow?: boolean;
  /** Error code from the operating system when the process could not be started, e.g. ENOENT. */
  spawnError?: string;
}

export type UncRunner = (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<UncResult>;

export const DEFAULT_TIMEOUT_MS = 60_000;
/** Far above any useful result (results are cut to tens of thousands of characters) and far below memory limits. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs the unc binary without a shell, so argument values can never be interpreted as shell syntax.
 * The returned function never rejects: every failure mode is described in the result.
 */
export function createRunner(
  uncBin: string,
  env: NodeJS.ProcessEnv = process.env,
  limits: { maxOutputBytes?: number } = {},
): UncRunner {
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return (argv, opts = {}) =>
    new Promise<UncResult>((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let received = 0;
      let timedOut = false;
      let overflow = false;
      let settled = false;

      const child = spawn(uncBin, argv, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const finish = (exitCode: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: timedOut || overflow ? null : exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          ...(overflow ? { overflow } : {}),
          ...(spawnError ? { spawnError } : {}),
        });
      };

      // A listing without a limit can be gigabytes; buffering it would take the whole server down.
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        if (overflow) return;
        received += chunk.length;
        if (received > maxOutputBytes) {
          overflow = true;
          child.kill('SIGKILL');
          return;
        }
        into.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (err: NodeJS.ErrnoException) => finish(null, err.code ?? 'UNKNOWN'));
      child.on('close', (code) => finish(code));

      // The process may exit before reading its input; that must not crash the server.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin ?? '');
    });
}
