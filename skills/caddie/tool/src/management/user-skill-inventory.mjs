import { createRequire } from 'node:module';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { validateOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import {
  digest,
  fingerprintIfPresent,
  optionalJson,
  selectionId,
  stableCondition,
  validLock,
} from './management-helpers.mjs';
import { ManagementError } from './request.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { scopeLayout } = require('../layout');

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

export async function inspectUserSkillInventory(state, runtime, { onlySelectionId = null } = {}) {
  const layout = scopeLayout({ id: 'user', root: runtime.home }, runtime.home);
  const manifest = await parseManifest(layout.manifestPath, 'user', runtime.home);
  const ledger = await optionalJson(layout.ledgerPath, 'ledger');
  if (ledger !== null) {
    try { validateOwnershipLedger(ledger, { expectedScopeId: 'user' }); } catch (error) {
      throw new ManagementError('invalid-ledger', 'Caddie Ledger is malformed or unsupported', 'needs-user', {
        cause: error.code ?? 'invalid-ledger',
      });
    }
  }
  const lock = await optionalJson(layout.lockPath, 'lock');
  if (!validLock(lock)) {
    throw new ManagementError('invalid-lock', 'Caddie Lock is missing, malformed, or unsupported', 'needs-user');
  }
  const [lockFingerprint, ledgerFingerprint] = await Promise.all([
    fingerprint(layout.lockPath), fingerprint(layout.ledgerPath),
  ]);
  const selections = [];
  const unavailableLocalSources = new Map();
  const selectedManifestSkills = manifest.skills.filter((raw) => (
    onlySelectionId === null || selectionId(raw.source, raw.path) === onlySelectionId
  ));
  const inspectOne = async (raw) => {
    const source = manifest.sources[raw.source];
    const id = selectionId(raw.source, raw.path);
    if (source.type !== 'local') {
      const entry = ledger?.entries.find((item) => item?.sourceId === raw.source && item?.selectedPath === raw.path) ?? null;
      return {
        id, name: entry?.name ?? null, sourceId: raw.source, selectedPath: raw.path, enabled: raw.enabled ?? true,
        sourceType: source.type, sourceDefinition: source, installedPath: entry?.path ?? null, statusOnly: true,
      };
    }
    const selectedRoot = path.resolve(source.path, raw.path);
    const provenanceEntry = ledger?.entries.find((item) => item?.sourceId === raw.source && item?.selectedPath === raw.path) ?? null;
    const skillFile = path.join(selectedRoot, 'SKILL.md');
    let name;
    let inspection;
    const knownFailure = unavailableLocalSources.get(raw.source);
    if (knownFailure) {
      name = provenanceEntry?.name ?? null;
      inspection = {
        kind: 'unavailable', code: knownFailure.code, detail: knownFailure.detail,
        checkout: source.path, selectedPath: raw.path,
      };
    } else try {
      name = extractSkillName(await runtime.readSourceText(skillFile), skillFile, path.basename(selectedRoot));
      const authorization = state.authorizations[id];
      inspection = await runtime.inspectGit({
        checkout: source.path, selectedPath: raw.path, acceptedCommit: authorization?.acceptedCommit ?? null,
      });
    } catch (error) {
      name = provenanceEntry?.name ?? null;
      inspection = {
        kind: 'unavailable', code: unavailableCode(error), detail: stableCondition(error),
        checkout: source.path, selectedPath: raw.path,
      };
      if (inspection.code === 'source-unavailable') unavailableLocalSources.set(raw.source, inspection);
    }
    const entry = provenanceEntry ?? ledger?.entries.find((item) => item?.name === name) ?? null;
    const installedPath = entry?.path ?? (name ? path.join(layout.canonicalSkillsRoot, name) : null);
    const installedFingerprint = await fingerprintIfPresent(installedPath);
    const ownership = await inspectOwnedExposure(ledger, name);
    const ownershipDigest = ownership.digest;
    const baselineClean = inspection.kind === 'git' && inspection.branch !== null && !inspection.selectedPathDirty
      && installedFingerprint !== null && installedFingerprint === inspection.fingerprint
      && entry?.fingerprint === installedFingerprint && entry?.sourceId === raw.source && entry?.selectedPath === raw.path
      && ownership.complete;
    return {
      id, name, sourceId: raw.source, selectedPath: raw.path, enabled: raw.enabled ?? true,
      sourceType: source.type, sourceDefinition: source, sourceRoot: source.path, selectedRoot, installedPath,
      installedFingerprint, inspection, ledgerEntry: entry, ownershipDigest, baselineClean, lockFingerprint,
      ledgerFingerprint,
    };
  };
  const inspectionConcurrency = 6;
  for (let offset = 0; offset < selectedManifestSkills.length; offset += inspectionConcurrency) {
    selections.push(...await Promise.all(selectedManifestSkills.slice(offset, offset + inspectionConcurrency).map(inspectOne)));
  }
  const installedUserSkills = onlySelectionId === null ? await inspectInstalledSkills(layout.canonicalSkillsRoot) : [];
  const watchPaths = [
    layout.stateRoot,
    ...selections.flatMap((selection) => [
      selection.sourceRoot,
      selection.inspection?.repositoryRoot !== selection.inspection?.checkout ? selection.inspection?.repositoryRoot : null,
      selection.installedPath,
    ]),
    ...(ledger?.harnessSettings ?? []).map((entry) => entry?.settingsPath ?? entry?.path)
      .filter((item) => typeof item === 'string'),
  ];
  return {
    manifest, lock, lockFingerprint, ledger, ledgerFingerprint, selections, installedUserSkills, layout, watchPaths,
  };
}

async function inspectOwnedExposure(ledger, name) {
  const links = [];
  for (const linkPath of (ledger?.harnessLinks ?? []).filter((item) => path.basename(item) === name).sort()) {
    try {
      const stat = await lstat(linkPath);
      links.push({
        path: linkPath, kind: stat.isSymbolicLink() ? 'symlink' : 'other',
        target: stat.isSymbolicLink() ? await readlink(linkPath) : null,
      });
    } catch (error) {
      if (error.code === 'ENOENT') links.push({ path: linkPath, kind: 'missing', target: null });
      else throw error;
    }
  }
  const settings = [];
  for (const entry of (ledger?.harnessSettings ?? []).filter((item) => item?.skill === name || item?.name === name)) {
    const settingsPath = entry.settingsPath ?? entry.path;
    settings.push({
      ...entry,
      liveFingerprint: typeof settingsPath === 'string' ? await fingerprintIfPresent(settingsPath) : null,
    });
  }
  return {
    digest: digest({ links, settings }),
    complete: links.every((item) => item.kind === 'symlink')
      && settings.every((item) => item.liveFingerprint !== null),
  };
}

function unavailableCode(error) {
  if (error?.code === 'ENOENT') return 'missing-content';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  if (error?.code === 'source-unavailable') return 'source-unavailable';
  return 'incomplete-evidence';
}
