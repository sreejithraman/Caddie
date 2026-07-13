import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ToolError, invalid } from '../protocol/errors.mjs';
import { validateGitRef, validateGitUrl } from '../sources/git-client.mjs';
import { validateSelectionMetadata } from './selection-metadata.mjs';

export const MANIFEST_VERSION = 1;

export async function parseManifest(manifestPath, expectedScope) {
  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (cause) {
    if (cause?.code === 'EACCES') {
      throw new ToolError(
        'manifest-permission-denied', `Cannot read Caddie Manifest: ${manifestPath}`, 'needs-permission', { manifestPath },
      );
    }
    throw cause;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('invalid-manifest-json', `Caddie Manifest is not valid JSON: ${manifestPath}`, { manifestPath });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw invalid('invalid-manifest', `Caddie Manifest must be an object: ${manifestPath}`, { manifestPath });
  }

  const version = value.manifestVersion ?? value.version;
  if (version !== MANIFEST_VERSION) {
    throw invalid('unsupported-manifest-version', `Unsupported Caddie Manifest version: ${String(version)}`, {
      manifestPath,
      supported: [MANIFEST_VERSION],
      received: version ?? null,
    });
  }
  if (value.scope !== expectedScope) {
    throw invalid('manifest-scope-mismatch', `Expected a ${expectedScope}-scoped Caddie Manifest`, {
      manifestPath,
      expected: expectedScope,
      received: value.scope ?? null,
    });
  }

  const sources = normaliseSources(value.sources, manifestPath);
  const skills = value.skills ?? value.selections ?? [];
  if (!Array.isArray(skills)) {
    throw invalid('invalid-skill-selections', 'Caddie Manifest skills must be an array', { manifestPath });
  }
  for (const selection of skills) {
    if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
      validateSelectionMetadata(selection, sources, manifestPath);
    }
  }

  return { manifestVersion: version, scope: value.scope, sources, skills, manifestPath };
}

function normaliseSources(raw, manifestPath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) && raw.some((item) => !item || typeof item !== 'object')) {
    throw invalid('invalid-sources', 'Caddie Manifest sources must be an object or array', { manifestPath });
  }
  const entries = Array.isArray(raw)
    ? raw.map((source) => [source.name ?? source.id, source])
    : Object.entries(raw);
  const sources = {};
  for (const [name, source] of entries) {
    if (typeof name !== 'string' || !name || !source || typeof source !== 'object') {
      throw invalid('invalid-source', 'Every Skill Source must have a name', { manifestPath });
    }
    if (sources[name]) throw invalid('duplicate-source', `Duplicate Skill Source: ${name}`, { manifestPath, source: name });
    if (source.type !== 'local' && source.type !== 'git') {
      throw invalid('unsupported-source-type', `Unsupported Skill Source type: ${String(source.type)}`, {
        manifestPath, source: name, supported: ['local', 'git'], received: source.type ?? null,
      });
    }
    if (source.type === 'local') {
      if (typeof source.path !== 'string' || !source.path || Object.hasOwn(source, 'url') || Object.hasOwn(source, 'ref')) {
        throw invalid('invalid-local-source', `Local Skill Source ${name} must have only a path`, { manifestPath, source: name });
      }
      sources[name] = { name, type: 'local', path: path.resolve(path.dirname(manifestPath), source.path) };
      continue;
    }
    if (Object.hasOwn(source, 'path')) {
      throw invalid('invalid-git-source', `Git Skill Source ${name} cannot have a local path`, { manifestPath, source: name });
    }
    try {
      validateGitUrl(source.url);
      validateGitRef(source.ref);
    } catch (cause) {
      throw invalid('invalid-git-source', `Git Skill Source ${name} must have a valid url and optional ref`, {
        manifestPath, source: name, reason: cause.message,
      });
    }
    sources[name] = { name, type: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}) };
  }
  return sources;
}
