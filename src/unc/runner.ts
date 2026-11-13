import { spawn } from 'node:child_process';

export interface UncResult {
  /** null when the process was killed or never started. */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** Error code from the operating system when the process could not be started, e.g. ENOENT. */
  spawnError?: string;
}

export type UncRunner = (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<UncResult>;

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs the unc binary without a shell, so argument values can never be interpreted as shell syntax.
 * The returned function never rejects: every failure mode is described in the result.
 */
export function createRunner(uncBin: string, env: NodeJS.ProcessEnv = process.env): UncRunner {
  return (argv, opts = {}) =>
    new Promise<UncResult>((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
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
          exitCode: timedOut ? null : exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          ...(spawnError ? { spawnError } : {}),
        });
      };

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err: NodeJS.ErrnoException) => finish(null, err.code ?? 'UNKNOWN'));
      child.on('close', (code) => finish(code));

      // The process may exit before reading its input; that must not crash the server.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin ?? '');
    });
}
