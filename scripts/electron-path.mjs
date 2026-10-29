import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export function electronPath() {
  if (process.env.PORTLEAF_ELECTRON) return process.env.PORTLEAF_ELECTRON;
  // Package runners prepend npm's Electron shim, which cannot run on NixOS.
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (directory.includes('node_modules')) continue;
    const executable = path.join(directory, 'electron');
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error('Electron is unavailable. Enter nix develop or install it with nix profile.');
}
