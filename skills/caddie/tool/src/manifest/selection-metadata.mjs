import path from 'node:path';

import { invalid } from '../protocol/errors.mjs';
import { validateInvocationPolicy } from '../invocation/project.mjs';

export function validateSelectionMetadata(selection, sources, manifestPath) {
  if (Object.hasOwn(selection, 'enabled') && typeof selection.enabled !== 'boolean') {
    throw invalid('invalid-skill-enabled', 'Skill Selection enabled must be a boolean when present', { manifestPath });
  }
  if (Object.hasOwn(selection, 'derivedFrom')) {
    validateDerivedFrom(selection.derivedFrom, sources, manifestPath);
  }
  if (Object.hasOwn(selection, 'migrationRecord')) {
    validateMigrationRecord(selection.migrationRecord, manifestPath);
  }
  if (Object.hasOwn(selection, 'invocation')) {
    try {
      validateInvocationPolicy(selection.invocation);
    } catch (cause) {
      throw invalid('invalid-invocation-policy', cause.message, { manifestPath, received: selection.invocation });
    }
  }
  return selection;
}

function validateDerivedFrom(value, sources, manifestPath) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('invalid-lineage', 'Skill Selection derivedFrom must contain one or more exact source/path origins', { manifestPath });
  }
  const seen = new Set();
  for (const origin of value) {
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)
      || Object.keys(origin).some((key) => !['source', 'path'].includes(key))
      || typeof origin.source !== 'string' || !origin.source
      || typeof origin.path !== 'string' || !safeRelativePath(origin.path)
      || !Object.hasOwn(sources, origin.source)) {
      throw invalid('invalid-lineage', 'Every Lineage origin must name an existing source and an exact relative selection path', {
        manifestPath,
      });
    }
    const identity = `${origin.source}\0${origin.path}`;
    if (seen.has(identity)) {
      throw invalid('invalid-lineage', 'Lineage origins must be distinct', { manifestPath, source: origin.source, path: origin.path });
    }
    seen.add(identity);
  }
}

function validateMigrationRecord(value, manifestPath) {
  if (typeof value !== 'string' || !safeRelativePath(value) || path.posix.extname(value).toLowerCase() !== '.md') {
    throw invalid('invalid-migration-record', 'migrationRecord must be a relative Markdown path within the manifest scope', {
      manifestPath,
    });
  }
}

function safeRelativePath(value) {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}
