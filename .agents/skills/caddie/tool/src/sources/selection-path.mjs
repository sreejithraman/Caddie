import { realpath } from 'node:fs/promises';
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

