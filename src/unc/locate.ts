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
 * Finds the official unc binary. An explicit path is authoritative: if it does not work there is no
 * fallback, so a typo in the configuration is reported instead of silently using another binary.
 */
export async function locateUnc(explicit: string | null, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (explicit !== null) return (await isExecutableFile(explicit)) ? explicit : null;

  const names = process.platform === 'win32' ? ['unc.exe', 'unc.cmd', 'unc'] : ['unc'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  const home = env.HOME ?? env.USERPROFILE;
  if (home) dirs.push(path.join(home, '.local', 'bin'));

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
