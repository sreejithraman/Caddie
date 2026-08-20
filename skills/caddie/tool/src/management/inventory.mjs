import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { loadRegistry } from '../registry/load-registry.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import { ManagementError } from './request.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { scopeLayout } = require('../layout');

export function buildSkillInventory(inventory, statuses) {
  const statusBySelection = new Map(statuses.map((item) => [item.id, item.status]));
  const managedPaths = new Set();
  const userRows = [];
  for (const selection of inventory.selections) {
    if (!selection.name || !selection.installedPath) continue;
    managedPaths.add(path.resolve(selection.installedPath));
    userRows.push(inventoryRecord({
      scope: 'user', projectRoot: null, name: selection.name, installedPath: selection.installedPath,
      enabled: selection.enabled, managed: true, selectionId: selection.id,
      origin: skillOrigin(null, selection.sourceId, selection.sourceDefinition, selection.selectedPath),
      status: statusBySelection.get(selection.id) ?? 'manual-only',
    }));
  }
  for (const skill of inventory.installedUserSkills) {
    if (managedPaths.has(path.resolve(skill.installedPath))) continue;
    userRows.push(inventoryRecord({
      scope: 'user', projectRoot: null, name: skill.name, installedPath: skill.installedPath,
      enabled: true, managed: false, selectionId: null, origin: null, status: 'unmanaged',
    }));
  }
  const userByName = new Map(userRows.map((item) => [item.name, item]));
  const enabledUserNames = new Set(userRows.filter((item) => item.enabled).map((item) => item.name));
  const projectRows = inventory.projectInventory.map((item) => ({
    ...item, shadowsSkillId: userByName.get(item.name)?.id ?? null,
  }));
  const projects = inventory.projectSummaries.map((project) => {
    const rows = projectRows.filter((item) => item.projectRoot === project.root);
    const names = new Set(rows.map((item) => item.name));
    return {
      ...project,
      projectSkillCount: rows.length,
      inheritedUserSkillCount: [...enabledUserNames].filter((name) => !names.has(name)).length,
      overrideCount: [...names].filter((name) => userByName.has(name)).length,
    };
  });
  return {
    skillInventory: [...userRows, ...projectRows].sort((left, right) => (
      `${left.scope}:${left.projectRoot ?? ''}:${left.name}`.localeCompare(`${right.scope}:${right.projectRoot ?? ''}:${right.name}`)
    )),
    projects: projects.sort((left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root)),
  };
}

export async function inspectInstalledSkills(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const skills = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const installedPath = path.join(root, entry.name);
    const skillFile = path.join(installedPath, 'SKILL.md');
    try {
      const name = extractSkillName(await readFile(skillFile, 'utf8'), skillFile, entry.name);
      skills.push({ name, installedPath });
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) || error?.code?.startsWith('skill-')) continue;
      throw error;
    }
  }
  return skills;
}

export async function inspectProjectSkillInventory(home) {
  const registry = await loadRegistry({}, home);
  if (registry.status === 'unsupported') throw new ManagementError('unsupported-registry', 'Caddie Registry version is not supported', 'needs-user');
  const projectSkills = [];
  const skillInventory = [];
  const projects = [];
  for (const projectRoot of registry.registeredProjects) {
    const layout = scopeLayout({ id: `project:${projectRoot}`, root: projectRoot }, home);
    let installed = [];
    let manifest;
    let ledger;
    try {
      installed = await inspectInstalledSkills(layout.canonicalSkillsRoot);
      manifest = await parseManifest(layout.manifestPath, 'project', projectRoot);
      ledger = await optionalJson(layout.ledgerPath);
      if (ledger !== null) validateOwnershipLedger(ledger, { expectedScopeId: `project:${projectRoot}` });
    } catch (error) {
      projectSkills.push({ version: 2, id: `project:${projectRoot}`, projectRoot, status: 'attention', code: error.code ?? 'incomplete-evidence' });
      const rows = installed.map((skill) => inventoryRecord({
        scope: 'project', projectRoot, name: skill.name, installedPath: skill.installedPath,
        enabled: true, managed: false, selectionId: null, origin: null, status: 'unmanaged',
      }));
      if (['EACCES', 'EPERM'].includes(error?.code)) {
        rows.push(inventoryRecord({
          scope: 'project', projectRoot, name: 'Project Skills', installedPath: layout.canonicalSkillsRoot,
          enabled: true, managed: false, selectionId: null, origin: null, status: 'attention',
          permissionFolder: layout.canonicalSkillsRoot,
        }));
      }
      skillInventory.push(...rows);
      projects.push(projectSummary(projectRoot, rows, 'attention'));
      continue;
    }
    const managedPaths = new Set();
    for (const selection of manifest.skills) {
      const source = manifest.sources[selection.source];
      const id = `project:${projectRoot}:${selectionId(selection.source, selection.path)}`;
      if (source.type !== 'local') {
        const entry = exactLedgerEntry(ledger, selection);
        const name = entry?.name ?? path.basename(selection.path);
        const installedPath = entry?.path ?? path.join(layout.canonicalSkillsRoot, name);
        projectSkills.push({
          version: 2, id, projectRoot, name, sourceId: selection.source,
          selectedPath: selection.path, status: 'manual-only',
        });
        managedPaths.add(path.resolve(installedPath));
        skillInventory.push(inventoryRecord({
          scope: 'project', projectRoot, name, installedPath,
          enabled: selection.enabled ?? true, managed: true, selectionId: id,
          origin: skillOrigin(projectRoot, selection.source, source, selection.path), status: 'manual-only',
        }));
        continue;
      }
      try {
        const selectedRoot = path.resolve(source.path, selection.path);
        const skillFile = path.join(selectedRoot, 'SKILL.md');
        const name = extractSkillName(await readFile(skillFile, 'utf8'), skillFile, path.basename(selectedRoot));
        const sourceFingerprint = await fingerprint(selectedRoot);
        const entry = exactLedgerEntry(ledger, selection)
          ?? ledger?.entries?.find((item) => item?.name === name) ?? null;
        const installedPath = entry?.path ?? path.join(layout.canonicalSkillsRoot, name);
        const installedFingerprint = await fingerprintIfPresent(installedPath);
        const status = sourceFingerprint === installedFingerprint && entry?.fingerprint === installedFingerprint
          ? 'current' : 'manual-only';
        projectSkills.push({
          version: 2, id, projectRoot, name, sourceId: selection.source, selectedPath: selection.path,
          enabled: selection.enabled ?? true, status,
        });
        managedPaths.add(path.resolve(installedPath));
        skillInventory.push(inventoryRecord({
          scope: 'project', projectRoot, name, installedPath, enabled: selection.enabled ?? true,
          managed: true, selectionId: id, origin: skillOrigin(projectRoot, selection.source, source, selection.path), status,
        }));
      } catch (error) {
        projectSkills.push({
          version: 2, id, projectRoot, sourceId: selection.source, selectedPath: selection.path,
          status: 'attention', code: unavailableCode(error),
        });
        const entry = exactLedgerEntry(ledger, selection);
        const name = entry?.name ?? path.basename(selection.path);
        const installedPath = entry?.path ?? path.join(layout.canonicalSkillsRoot, name);
        managedPaths.add(path.resolve(installedPath));
        skillInventory.push(inventoryRecord({
          scope: 'project', projectRoot, name, installedPath,
          enabled: selection.enabled ?? true, managed: true, selectionId: id,
          origin: skillOrigin(projectRoot, selection.source, source, selection.path), status: 'attention',
        }));
      }
    }
    for (const skill of installed) {
      if (managedPaths.has(path.resolve(skill.installedPath))) continue;
      skillInventory.push(inventoryRecord({
        scope: 'project', projectRoot, name: skill.name, installedPath: skill.installedPath,
        enabled: true, managed: false, selectionId: null, origin: null, status: 'unmanaged',
      }));
    }
    const rows = skillInventory.filter((item) => item.projectRoot === projectRoot);
    const hasAttention = projectSkills.some((item) => item.projectRoot === projectRoot && item.status === 'attention');
    projects.push(projectSummary(projectRoot, rows, hasAttention ? 'attention' : 'current'));
  }
  return { projectSkills, skillInventory, projects };
}

function exactLedgerEntry(ledger, selection) {
  return ledger?.entries?.find((item) => item?.sourceId === selection.source && item?.selectedPath === selection.path) ?? null;
}

function inventoryRecord({
  scope, projectRoot, name, installedPath, enabled, managed, selectionId, origin, status, permissionFolder = null,
}) {
  return {
    version: 2, id: `inventory-${digest({ scope, projectRoot, installedPath }).slice(0, 24)}`,
    scope, projectRoot, name, installedPath, enabled, managed, selectionId, origin,
    shadowsSkillId: null, status, permissionFolder,
  };
}

function skillOrigin(projectRoot, sourceId, source, selectedPath) {
  if (!source) return null;
  return {
    id: `origin-${digest({ projectRoot, sourceId }).slice(0, 24)}`,
    sourceId, name: source.name ?? sourceId, type: source.type,
    gitUrl: source.type === 'git' ? source.url : null,
    localFolder: source.type === 'local' ? source.path : null,
    selectedPath,
  };
}

function projectSummary(projectRoot, rows, status) {
  return {
    version: 2, id: `project-${digest(projectRoot).slice(0, 24)}`,
    name: path.basename(projectRoot), root: projectRoot,
    projectSkillCount: rows.length, inheritedUserSkillCount: 0,
    overrideCount: rows.filter((item) => item.shadowsSkillId !== null).length,
    status,
  };
}

async function optionalJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new ManagementError('invalid-state', 'Caddie state is not valid JSON', 'needs-user');
    throw error;
  }
}

async function fingerprintIfPresent(target) {
  if (!target) return null;
  try { await access(target); return await fingerprint(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function selectionId(sourceId, selectedPath) { return `${sourceId}:${path.normalize(selectedPath)}`; }
function unavailableCode(error) {
  if (error?.code === 'ENOENT') return 'missing-content';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  return 'incomplete-evidence';
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
