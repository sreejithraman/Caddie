import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ManagementError } from './request.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');

export async function optionalJson(filePath, label = 'state') {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new ManagementError(`invalid-${label}`, `Caddie ${label} is not valid JSON`, 'needs-user');
    }
    throw error;
  }
}

export function validLock(lock) {
  if (!plainObject(lock) || Object.keys(lock).sort().join(',') !== 'sources,version' || lock.version !== 1) return false;
  const entries = Array.isArray(lock.sources) ? lock.sources : plainObject(lock.sources) ? Object.values(lock.sources) : null;
  return entries !== null && entries.every((entry) => plainObject(entry)
    && entry.type === 'git' && typeof entry.url === 'string' && entry.url.length > 0
    && typeof entry.commit === 'string' && /^[0-9a-f]{40,64}$/i.test(entry.commit)
    && (entry.ref === undefined || typeof entry.ref === 'string'));
}

export function stableCondition(error) {
  return String(error?.code ?? error?.message ?? 'unknown').slice(0, 256);
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function fingerprintIfPresent(target) {
  if (!target) return null;
  try { await access(target); return await fingerprint(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function selectionId(sourceId, selectedPath) {
  return `${sourceId}:${path.normalize(selectedPath)}`;
}
