import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The compiled server lives at server/dist/server/src while the TypeScript source
// runs from server/src, so a fixed number of ".." segments is wrong for one of them.
// Walk up to the package.json named "outboxrelay" instead.
export function findPackageDir(startDir: string, packageName: string): string {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === packageName) return dir;
      } catch {
        // Unreadable package.json on the way up; keep looking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find a package.json named "${packageName}" above ${startDir}`);
    }
    dir = parent;
  }
}

export function repoRoot(): string {
  return findPackageDir(path.dirname(fileURLToPath(import.meta.url)), 'outboxrelay');
}

/** OUTBOXRELAY_DB_PATH if set, otherwise data/outbox.db at the repository root. */
export function defaultDatabasePath(): string {
  const configured = process.env.OUTBOXRELAY_DB_PATH;
  if (configured && configured.trim() !== '') return path.resolve(configured);
  return path.join(repoRoot(), 'data', 'outbox.db');
}
