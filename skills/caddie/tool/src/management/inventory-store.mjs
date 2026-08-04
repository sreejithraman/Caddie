import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validProjectSummary, validSkillInventory } from './formats.mjs';
import { ManagementError } from './request.mjs';

const INVENTORY_STORE_VERSION = 1;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;

export function inventoryStorePath(statePath) { return `${statePath}.inventory-v1.json`; }

export async function readInventoryProjection(candidate, revision) {
  const store = await readStore(candidate);
  return store?.projections.filter((item) => item.revision <= revision).at(-1) ?? null;
}

export async function preflightInventoryProjection(candidate, projection, retainedRevisions) {
  await nextStore(candidate, projection, retainedRevisions);
}

export async function writeInventoryProjection(candidate, projection, retainedRevisions) {
  const value = await nextStore(candidate, projection, retainedRevisions);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(candidate), { recursive: true });
  const temporary = path.join(path.dirname(candidate), `.${path.basename(candidate)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, candidate);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function nextStore(candidate, projection, retainedRevisions) {
  if (!validProjection(projection)) throw new ManagementError('invalid-inventory-projection', 'Caddie inventory projection is invalid', 'bug');
  const prior = await readStore(candidate) ?? { version: INVENTORY_STORE_VERSION, projections: [] };
  const byRevision = new Map(prior.projections.map((item) => [item.revision, item]));
  const latest = prior.projections.at(-1);
  if (!latest || !sameInventory(latest, projection)) byRevision.set(projection.revision, projection);
  const floor = Math.min(projection.revision, ...retainedRevisions);
  const older = [...byRevision.values()].filter((item) => item.revision < floor).at(-1);
  const projections = [...byRevision.values()]
    .filter((item) => item.revision >= floor || item === older)
    .sort((left, right) => left.revision - right.revision);
  const value = { version: INVENTORY_STORE_VERSION, projections };
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > MAX_INVENTORY_BYTES) {
    throw new ManagementError('inventory-capacity', 'Caddie inventory history is too large', 'needs-user');
  }
  return value;
}

function sameInventory(left, right) {
  return JSON.stringify(left.skillInventory) === JSON.stringify(right.skillInventory)
    && JSON.stringify(left.projects) === JSON.stringify(right.projects);
}

async function readStore(candidate) {
  let raw;
  try { raw = await readFile(candidate, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (Buffer.byteLength(raw) > MAX_INVENTORY_BYTES) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'projections,version'
      || value.version !== INVENTORY_STORE_VERSION || !Array.isArray(value.projections)
      || value.projections.some((item) => !validProjection(item))) return null;
  value.projections.sort((left, right) => left.revision - right.revision);
  return value;
}

function validProjection(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'projects,revision,skillInventory'
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Array.isArray(value.skillInventory) && value.skillInventory.every(validSkillInventory)
    && Array.isArray(value.projects) && value.projects.every(validProjectSummary);
}
