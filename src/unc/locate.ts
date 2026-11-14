import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Folders where command-line tools usually live. Desktop apps started from the Dock or a launcher do not
 * load the shell profile, so these are often missing from their PATH.
 */
export const DEFAULT_FALLBACK_DIRS: readonly string[] = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin'];

/**
 * File names to look for. On Windows only a real executable works: .cmd and .bat shims need a shell,
 * and this server never runs unc through one.
 */
export function candidateNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['unc.exe'] : ['unc'];
}

/**
 * Finds the official unc binary. An explicit path is authoritative: if it does not work there is no
 * fallback, so a typo in the configuration is reported instead of silently using another binary.
 */
export async function locateUnc(
  explicit: string | null,
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = process.platform === 'win32' ? [] : DEFAULT_FALLBACK_DIRS,
): Promise<string | null> {
  if (explicit !== null) return (await isExecutableFile(explicit)) ? explicit : null;

  const names = candidateNames();
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  const home = env.HOME ?? env.USERPROFILE;
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  dirs.push(...fallbackDirs);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
