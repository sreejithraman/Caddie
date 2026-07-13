import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export class SelectionOutsideSourceError extends TypeError {
  constructor(selectionPath) {
    super('Skill Selection path escapes its Skill Source');
    this.name = 'SelectionOutsideSourceError';
    this.code = 'selection-outside-source';
    this.selectionPath = selectionPath;
  }
}

export async function resolveSelectionWithinSource(sourceRoot, selectionPath) {
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) throw new TypeError('sourceRoot must be a non-empty path');
  if (typeof selectionPath !== 'string' || selectionPath.length === 0 || path.isAbsolute(selectionPath)) {
    throw new TypeError('selectionPath must be a non-empty relative path');
  }
  const normalized = path.posix.normalize(selectionPath.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new SelectionOutsideSourceError(selectionPath);

  const lexicalRoot = path.resolve(sourceRoot);
  const lexicalSelection = path.resolve(lexicalRoot, normalized);
  if (!isWithin(lexicalRoot, lexicalSelection)) throw new SelectionOutsideSourceError(selectionPath);

  const resolvedRoot = await realpath(lexicalRoot);
  const resolvedSelection = await realpath(lexicalSelection);
  if (!isWithin(resolvedRoot, resolvedSelection)) throw new SelectionOutsideSourceError(selectionPath);
  return { sourceRoot: resolvedRoot, selectedPath: resolvedSelection, relativePath: normalized };
}

export async function assertContainedSymlinks(root) {
  const resolvedRoot = await realpath(root);
  async function visit(directory) {
    for (const entry of await readdir(directory)) {
      const candidate = path.join(directory, entry);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        let target;
        try { target = await realpath(candidate); } catch {
          throw externalSymlink(candidate, 'dangling');
        }
        if (!isWithin(resolvedRoot, target)) throw externalSymlink(candidate, target);
      } else if (stat.isDirectory()) await visit(candidate);
    }
  }
  await visit(resolvedRoot);
}

function externalSymlink(candidate, target) {
  const error = new TypeError(`Skill contains a symlink outside its selected directory: ${candidate}`);
  error.code = 'external-symlink';
  error.target = target;
  return error;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
