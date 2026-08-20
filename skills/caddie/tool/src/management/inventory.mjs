import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { loadRegistry } from '../registry/load-registry.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import { ManagementError } from './request.mjs';
import { inspectProjectCheckout } from './local-source.mjs';
import { inspectLegacyProjectRepair } from './project-actions.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { scopeLayout } = require('../layout');
const execFileAsync = promisify(execFile);
const projectWorkerPath = fileURLToPath(new URL('./project-inventory-worker.mjs', import.meta.url));
const PROJECT_INSPECTION_TIMEOUT_MS = 8_000;

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
      origin: skillOrigin(null, selection.sourceId, selection.sourceDefinition, selection.selectedPath, {
        inspection: selection.inspection,
      }),
      status: statusBySelection.get(selection.id) ?? 'manual-only',
    }));
  }
  for (const skill of inventory.installedUserSkills) {
    if (managedPaths.has(path.resolve(skill.installedPath))) continue;
    userRows.push(inventoryRecord({
      scope: 'user', projectRoot: null, name: skill.name, installedPath: skill.installedPath,
      enabled: true, managed: false, selectionId: null, origin: null,
      status: skill.permissionFolder ? 'attention' : 'unmanaged',
      permissionFolder: skill.permissionFolder,
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
      if (['EACCES', 'EPERM'].includes(error?.code)) {
        skills.push({ name: entry.name, installedPath, permissionFolder: installedPath });
        continue;
      }
      if (['ENOENT', 'EISDIR', 'ENOTDIR', 'ELOOP'].includes(error?.code) || error?.code?.startsWith('skill-')) continue;
      throw error;
    }
  }
  return skills;
}

export async function inspectProjectSkillInventory(home, { runProjectWorker = defaultRunProjectWorker } = {}) {
  const registry = await loadRegistry({}, home);
  if (registry.status === 'unsupported') throw new ManagementError('unsupported-registry', 'Caddie Registry version is not supported', 'needs-user');
  const result = { projectSkills: [], skillInventory: [], projects: [] };
  for (const projectRoot of registry.registeredProjects) {
    const checkout = await inspectProjectCheckout({ projectRoot }).catch(() => null);
    try {
      appendProjectResult(result, await runProjectWorker(projectRoot, home, checkout));
    } catch (error) {
      appendProjectResult(result, unavailableProject(projectRoot, checkout, error));
    }
  }
  return result;
}

export async function inspectProjectSkillInventoryInProcess(home, registeredProjects, checkoutByRoot = {}) {
  const projectSkills = [];
  const skillInventory = [];
  const projects = [];
  for (const projectRoot of registeredProjects) {
    const layout = scopeLayout({ id: `project:${projectRoot}`, root: projectRoot }, home);
    const checkout = checkoutByRoot[projectRoot]
      ?? await inspectProjectCheckout({ projectRoot }).catch(() => null);
    let installed = [];
    let manifest;
    let ledger;
    try {
      installed = await inspectInstalledSkills(layout.canonicalSkillsRoot);
      manifest = await parseManifest(layout.manifestPath, 'project', projectRoot);
      ledger = await optionalJson(layout.ledgerPath);
      if (ledger !== null) validateOwnershipLedger(ledger, { expectedScopeId: `project:${projectRoot}` });
    } catch (error) {
      const repairAvailable = await inspectLegacyProjectRepair(projectRoot, home).then(() => true).catch(() => false);
      let projectError = repairAvailable
        ? new ManagementError('legacy-project-scope', 'Project ownership uses an older folder identity', 'needs-user')
        : error;
      let hasNoProjectState = false;
      if (error?.code === 'ENOENT') {
        try {
          const entries = await readdir(layout.stateRoot);
          hasNoProjectState = entries.length === 0;
          if (!hasNoProjectState) {
            projectError = new ManagementError('incomplete-project-state', 'Project Caddie state has no Manifest', 'needs-user');
          }
        }
        catch (stateError) {
          if (stateError?.code === 'ENOENT') hasNoProjectState = true;
          else projectError = stateError;
        }
      }
      if (hasNoProjectState) {
        const rows = installed.map((skill) => inventoryRecord({
          scope: 'project', projectRoot, name: skill.name, installedPath: skill.installedPath,
          enabled: true, managed: false, selectionId: null, origin: null,
          status: skill.permissionFolder ? 'attention' : 'unmanaged',
          permissionFolder: skill.permissionFolder,
        }));
        skillInventory.push(...rows);
        projects.push(projectSummary(projectRoot, rows, rows.some((item) => item.status === 'attention') ? 'attention' : 'current', {
          checkout, selectedSkillCount: 0,
        }));
        continue;
      }
      projectSkills.push({ version: 2, id: `project:${projectRoot}`, projectRoot, status: 'attention', code: projectError.code ?? 'incomplete-evidence' });
      const rows = installed.map((skill) => inventoryRecord({
        scope: 'project', projectRoot, name: skill.name, installedPath: skill.installedPath,
        enabled: true, managed: false, selectionId: null, origin: null,
        status: skill.permissionFolder ? 'attention' : 'unmanaged',
        permissionFolder: skill.permissionFolder,
      }));
      if (['EACCES', 'EPERM'].includes(projectError?.code)) {
        rows.push(inventoryRecord({
          scope: 'project', projectRoot, name: 'Project Skills', installedPath: layout.canonicalSkillsRoot,
          enabled: true, managed: false, selectionId: null, origin: null, status: 'attention',
          permissionFolder: layout.canonicalSkillsRoot,
        }));
      }
      skillInventory.push(...rows);
      projects.push(projectSummary(projectRoot, rows, 'attention', {
        checkout, selectedSkillCount: manifest?.skills?.length ?? 0,
        issueCode: projectError.code ?? 'incomplete-evidence', repairAvailable,
      }));
      continue;
    }
    const managedPaths = new Set();
    for (const selection of manifest.skills) {
      const source = manifest.sources[selection.source];
      const id = `project:${projectRoot}:${selectionId(selection.source, selection.path)}`;
      if (source.type !== 'local') {
        const entry = exactLedgerEntry(ledger, selection);
        const fallbackName = path.basename(selection.path);
        const entryPath = entry ? canonicalProjectSkillPath(layout.canonicalSkillsRoot, entry.name) : null;
        const name = entryPath ? entry.name : fallbackName;
        const installedPath = path.join(layout.canonicalSkillsRoot, name);
        const conflictingEntry = entry ? null : ledger?.entries?.find((item) => item?.name === name);
        if (conflictingEntry || (entry && (entryPath === null || path.resolve(entry.path) !== installedPath))) {
          managedPaths.add(path.resolve(installedPath));
          projectSkills.push({
            version: 2, id, projectRoot, name, sourceId: selection.source,
            selectedPath: selection.path, status: 'attention', code: 'invalid-ledger-content',
          });
          skillInventory.push(inventoryRecord({
            scope: 'project', projectRoot, name, installedPath,
            enabled: selection.enabled ?? true, managed: false, selectionId: id,
            origin: skillOrigin(projectRoot, selection.source, source, selection.path, { checkout }), status: 'attention',
          }));
          continue;
        }
        projectSkills.push({
          version: 2, id, projectRoot, name, sourceId: selection.source,
          selectedPath: selection.path, status: 'manual-only',
        });
        managedPaths.add(path.resolve(installedPath));
        skillInventory.push(inventoryRecord({
          scope: 'project', projectRoot, name, installedPath,
          enabled: selection.enabled ?? true, managed: true, selectionId: id,
          origin: skillOrigin(projectRoot, selection.source, source, selection.path, { checkout }), status: 'manual-only',
        }));
        continue;
      }
      let inspectedName = null;
      try {
        const selectedRoot = path.resolve(source.path, selection.path);
        const skillFile = path.join(selectedRoot, 'SKILL.md');
        const name = extractSkillName(await readFile(skillFile, 'utf8'), skillFile, path.basename(selectedRoot));
        inspectedName = name;
        const sourceFingerprint = await fingerprint(selectedRoot);
        const entry = exactLedgerEntry(ledger, selection);
        const installedPath = path.join(layout.canonicalSkillsRoot, name);
        const conflictingEntry = entry ? null : ledger?.entries?.find((item) => item?.name === name);
        if (conflictingEntry || (entry && (entry.name !== name || path.resolve(entry.path) !== path.resolve(installedPath)))) {
          throw new ManagementError('invalid-ledger-content', 'Project Skill ownership does not match its exact selection', 'needs-user');
        }
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
          managed: true, selectionId: id,
          origin: skillOrigin(projectRoot, selection.source, source, selection.path, { checkout }), status,
        }));
      } catch (error) {
        projectSkills.push({
          version: 2, id, projectRoot, sourceId: selection.source, selectedPath: selection.path,
          status: 'attention', code: unavailableCode(error),
        });
        const entry = exactLedgerEntry(ledger, selection);
        const name = inspectedName ?? entry?.name ?? path.basename(selection.path);
        const safeName = canonicalProjectSkillPath(layout.canonicalSkillsRoot, name) ? name : path.basename(selection.path);
        const installedPath = path.join(layout.canonicalSkillsRoot, safeName);
        const ownsInstalledPath = error?.code !== 'invalid-ledger-content'
          && (!entry || (entry.name === safeName && path.resolve(entry.path) === path.resolve(installedPath)));
        managedPaths.add(path.resolve(installedPath));
        skillInventory.push(inventoryRecord({
          scope: 'project', projectRoot, name: safeName, installedPath,
          enabled: selection.enabled ?? true, managed: ownsInstalledPath, selectionId: id,
          origin: skillOrigin(projectRoot, selection.source, source, selection.path, { checkout }), status: 'attention',
        }));
      }
    }
    for (const skill of installed) {
      if (managedPaths.has(path.resolve(skill.installedPath))) continue;
      skillInventory.push(inventoryRecord({
        scope: 'project', projectRoot, name: skill.name, installedPath: skill.installedPath,
        enabled: true, managed: false, selectionId: null, origin: null,
        status: skill.permissionFolder ? 'attention' : 'unmanaged',
        permissionFolder: skill.permissionFolder,
      }));
    }
    const rows = skillInventory.filter((item) => item.projectRoot === projectRoot);
    const hasAttention = projectSkills.some((item) => item.projectRoot === projectRoot && item.status === 'attention')
      || rows.some((item) => item.status === 'attention');
    projects.push(projectSummary(projectRoot, rows, hasAttention ? 'attention' : 'current', {
      checkout, selectedSkillCount: manifest.skills.length,
      issueCode: hasAttention ? projectSkills.find((item) => item.projectRoot === projectRoot && item.status === 'attention')?.code ?? null : null,
      repairAvailable: false,
    }));
  }
  return { projectSkills, skillInventory, projects };
}

async function defaultRunProjectWorker(projectRoot, home, checkout) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      projectWorkerPath, JSON.stringify({ projectRoot, home, checkout }),
    ], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: PROJECT_INSPECTION_TIMEOUT_MS,
      killSignal: 'SIGKILL', windowsHide: true,
    });
    const response = JSON.parse(stdout);
    if (response.ok === true) return response.result;
    throw Object.assign(new Error(response.error?.message ?? 'Project folder could not be inspected'), {
      code: response.error?.code ?? 'source-unavailable',
    });
  } catch (error) {
    if (error?.killed || error?.signal === 'SIGKILL' || error?.code === 'ETIMEDOUT') {
      throw Object.assign(new Error('Project folder did not respond in time'), { code: 'source-unavailable' });
    }
    throw error;
  }
}

function unavailableProject(projectRoot, checkout, error) {
  const code = ['EACCES', 'EPERM'].includes(error?.code) ? 'permission-denied' : 'source-unavailable';
  return {
    projectSkills: [{ version: 2, id: `project:${projectRoot}`, projectRoot, status: 'attention', code }],
    skillInventory: [],
    projects: [projectSummary(projectRoot, [], 'attention', {
      checkout, selectedSkillCount: 0, issueCode: code, repairAvailable: false,
    })],
  };
}

function appendProjectResult(target, source) {
  target.projectSkills.push(...source.projectSkills);
  target.skillInventory.push(...source.skillInventory);
  target.projects.push(...source.projects);
}

function exactLedgerEntry(ledger, selection) {
  return ledger?.entries?.find((item) => item?.sourceId === selection.source && item?.selectedPath === selection.path) ?? null;
}

function canonicalProjectSkillPath(canonicalSkillsRoot, name) {
  if (typeof name !== 'string' || name.length === 0 || path.basename(name) !== name || name === '.' || name === '..') return null;
  const root = path.resolve(canonicalSkillsRoot);
  const candidate = path.resolve(root, name);
  return path.dirname(candidate) === root ? candidate : null;
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

function skillOrigin(projectRoot, sourceId, source, selectedPath, { inspection = null, checkout = null } = {}) {
  if (!source) return null;
  return {
    id: logicalSourceId(source, { projectRoot, inspection, checkout }),
    sourceId, name: source.name ?? sourceId, type: source.type,
    gitUrl: source.type === 'git' ? source.url : null,
    localFolder: source.type === 'local' ? source.path : null,
    selectedPath,
  };
}

function logicalSourceId(source, { projectRoot, inspection, checkout }) {
  if (source.type === 'git') {
    return `origin-remote-git-${digest({ type: 'git', url: source.url, sourceRoot: '.' }).slice(0, 24)}`;
  }
  if (inspection?.kind === 'git' && inspection.repositoryId && inspection.sourceRootRelativePath) {
    return `origin-local-git-${digest({
      type: 'local-git', repositoryId: inspection.repositoryId,
      sourceRoot: portableRelativePath(inspection.sourceRootRelativePath),
    }).slice(0, 24)}`;
  }
  if (checkout?.gitRepositoryId && checkout.repositoryRoot && inside(checkout.repositoryRoot, source.path)) {
    return `origin-local-git-${digest({
      type: 'local-git', repositoryId: checkout.gitRepositoryId,
      sourceRoot: portableRelativePath(path.relative(checkout.repositoryRoot, source.path) || '.'),
    }).slice(0, 24)}`;
  }
  if (['main', 'worktree'].includes(checkout?.checkoutKind) && checkout.repositoryId && projectRoot
      && inside(projectRoot, source.path)) {
    return `origin-local-git-${digest({
      type: 'local-git', repositoryId: checkout.repositoryId,
      sourceRoot: portableRelativePath(path.relative(projectRoot, source.path) || '.'),
    }).slice(0, 24)}`;
  }
  return `origin-local-folder-${digest({
    type: 'local-folder', folder: path.resolve(inspection?.checkout ?? source.path),
  }).slice(0, 24)}`;
}

function portableRelativePath(value) {
  return path.normalize(value).split(path.sep).join('/');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function projectSummary(projectRoot, rows, status, {
  checkout = null, selectedSkillCount = 0, issueCode = null, repairAvailable = false,
} = {}) {
  return {
    version: 2, id: `project-${digest(projectRoot).slice(0, 24)}`,
    name: path.basename(projectRoot), root: projectRoot,
    projectSkillCount: rows.length, inheritedUserSkillCount: 0,
    overrideCount: rows.filter((item) => item.shadowsSkillId !== null).length,
    status, selectedSkillCount, issueCode, repairAvailable,
    repositoryId: checkout?.repositoryId ?? `project-${digest(projectRoot).slice(0, 24)}`,
    checkoutKind: checkout?.checkoutKind ?? 'project', branch: checkout?.branch ?? null,
    mainProjectRoot: checkout?.mainProjectRoot ?? projectRoot,
    workingTreeClean: checkout?.workingTreeClean ?? null,
    upstreamState: checkout?.upstreamState ?? 'unknown',
    includedInDefaultBranch: checkout?.includedInDefaultBranch ?? null,
    lifecycle: checkout?.lifecycle ?? 'active',
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
  if (error?.code === 'invalid-ledger-content') return 'invalid-ledger-content';
  if (error?.code === 'ENOENT') return 'missing-content';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  return 'incomplete-evidence';
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
