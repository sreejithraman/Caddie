import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

import { planHarnessSettingsBatch } from '../harness/enablement.mjs';
import { inspectInvocation } from '../invocation/project.mjs';
import { parseManifestValue } from '../manifest/parse-manifest.mjs';
import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { invalid } from '../protocol/errors.mjs';
import { ledgerEntrySourceId, loadOwnershipLedger } from '../protocol/ledger-ownership.mjs';

const require = createRequire(import.meta.url);
const { fingerprint, fingerprintIfPresent } = require('../apply/filesystem');
const { scopeLayout } = require('../layout');
const { createInternalPlan } = require('../plans');

const {
  areDisjointRenamePairs,
  isRenameIdentity,
  isSafeSelectionPath,
  renameSelectionKey,
} = require('./contract');

export async function createSkillRenamePlan(input) {
  const { scope, home, registration = null } = input;
  const layout = scopeLayout(scope, home);
  const pairs = normalisePairs(input.renames);
  const materializations = normaliseMaterializations(input.materializations, pairs);
  const manifestState = await manifestStateForRename(input.manifest, scope, layout.manifestPath);
  validateManifestTransition(manifestState, pairs);

  const ledger = await loadOwnershipLedger(layout.ledgerPath, {
    expectedScopeId: scope.id,
    label: 'Skill Rename ledger',
  });
  const ledgerFingerprint = await fingerprint(layout.ledgerPath);
  const oldState = await inspectOldState({ pairs, ledger, layout });
  const newState = await inspectNewState({ pairs, materializations, ledger, layout, manifest: manifestState.final });

  const settings = await planRenameSettings({
    scope,
    home,
    pairs,
    manifest: manifestState.final,
    ownership: ledger.harnessSettings ?? [],
    layout,
  });
  const nextLedger = replacementLedger({ ledger, oldState, newState, settings });
  const operations = [
    ...(registration ? [registration] : []),
    ...newState.materializations,
    ...newState.exposures,
    ...settings.operations,
    ...manifestState.operations,
    ...await lockOperations(input.lock, layout.lockPath),
    ...oldState.exposureRemovals,
    ...oldState.skillRemovals,
    {
      type: 'write-ledger',
      path: layout.ledgerPath,
      content: `${JSON.stringify(nextLedger, null, 2)}\n`,
      expected: { state: 'file', fingerprint: ledgerFingerprint },
    },
  ];
  const intent = {
    type: 'skill-rename',
    renames: pairs.map((pair) => {
      const old = oldState.entries.get(renameSelectionKey(pair.from));
      const next = newState.entries.get(renameSelectionKey(pair.to));
      return {
        from: { ...pair.from, fingerprint: fingerprintDigest(old.fingerprint) },
        to: { ...pair.to, fingerprint: fingerprintDigest(next.fingerprint) },
      };
    }),
  };
  return createInternalPlan({ kind: 'reconcile', home, scope, operations, intent });
}

function normalisePairs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid('invalid-skill-renames', 'Skill Rename requires one or more exact rename pairs');
  }
  const pairs = value.map((pair) => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)
      || Object.keys(pair).sort().join(',') !== 'from,to') {
      throw invalid('invalid-skill-renames', 'Every Skill Rename must contain only from and to identities');
    }
    const from = normaliseIdentity(pair.from, 'from');
    const to = normaliseIdentity(pair.to, 'to');
    if (from.name === to.name) {
      throw invalid('invalid-skill-renames', 'A Skill Rename must change its name');
    }
    return { from, to };
  });
  if (!areDisjointRenamePairs(pairs)) {
    throw invalid('overlapping-skill-renames', 'Skill Rename pairs must be disjoint and cannot form chains or swaps');
  }
  return pairs;
}

function normaliseIdentity(value, label) {
  if (!isRenameIdentity(value)) {
    throw invalid('invalid-skill-renames', `Skill Rename ${label} must bind a safe name, source, and relative path`);
  }
  return { name: value.name, source: value.source, path: value.path };
}

function normaliseMaterializations(value, pairs) {
  if (!Array.isArray(value) || value.length !== pairs.length) {
    throw invalid('invalid-rename-materializations', 'Skill Rename requires one inspected materialization for each destination');
  }
  const byIdentity = new Map();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.keys(candidate).some((key) => ![
        'name', 'sourceId', 'selectedPath', 'sourcePath', 'sourceFingerprint', 'sourceCleanup',
      ].includes(key))
      || typeof candidate.name !== 'string' || typeof candidate.sourceId !== 'string'
      || typeof candidate.selectedPath !== 'string' || typeof candidate.sourcePath !== 'string'
      || !path.isAbsolute(candidate.sourcePath) || typeof candidate.sourceFingerprint !== 'string') {
      throw invalid('invalid-rename-materializations', 'Each rename materialization must bind its inspected source and fingerprint');
    }
    const identity = renameSelectionKey({ source: candidate.sourceId, path: candidate.selectedPath });
    if (byIdentity.has(identity)) throw invalid('invalid-rename-materializations', 'Rename materializations must be distinct');
    byIdentity.set(identity, { ...candidate });
  }
  for (const pair of pairs) {
    const candidate = byIdentity.get(renameSelectionKey(pair.to));
    if (!candidate || candidate.name !== pair.to.name) {
      throw invalid('invalid-rename-materializations', `Missing exact materialization for renamed skill: ${pair.to.name}`);
    }
  }
  return byIdentity;
}

async function manifestStateForRename(finalValue, scope, manifestPath) {
  if (!finalValue || typeof finalValue !== 'object' || Array.isArray(finalValue)) {
    throw invalid('invalid-rename-manifest', 'Skill Rename requires the exact final Caddie Manifest');
  }
  const currentText = await fs.readFile(manifestPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw invalid('rename-manifest-missing', 'Skill Rename requires an existing Caddie Manifest');
    throw error;
  });
  let currentValue;
  try { currentValue = JSON.parse(currentText); } catch {
    throw invalid('invalid-manifest-json', `Caddie Manifest is not valid JSON: ${manifestPath}`);
  }
  const expectedScope = scope.id === 'user' ? 'user' : 'project';
  const current = parseManifestValue(currentValue, expectedScope, scope.root, manifestPath);
  const final = parseManifestValue(finalValue, expectedScope, scope.root, manifestPath);
  validateRenameManifest(current, 'Current');
  validateRenameManifest(final, 'Final');
  const finalText = `${JSON.stringify(finalValue, null, 2)}\n`;
  const operations = finalText === currentText ? [] : [{
    type: 'write-manifest',
    path: manifestPath,
    content: finalText,
    expected: { state: 'file', fingerprint: await fingerprint(manifestPath) },
  }];
  return { current, final, operations };
}

function validateManifestTransition({ current, final }, pairs) {
  const renamedSelections = new Set();
  for (const pair of pairs) {
    const currentFrom = selectionCount(current.skills, pair.from);
    const currentTo = selectionCount(current.skills, pair.to);
    const sameIdentity = renameSelectionKey(pair.from) === renameSelectionKey(pair.to);
    if (sameIdentity ? currentFrom !== 1 : currentFrom + currentTo !== 1) {
      throw invalid('invalid-rename-manifest-transition', `Current Manifest must select exactly one side of ${pair.from.name} to ${pair.to.name}`);
    }
    if ((!sameIdentity && selectionCount(final.skills, pair.from) !== 0)
      || selectionCount(final.skills, pair.to) !== 1) {
      throw invalid('invalid-rename-manifest-transition', `Final Manifest must replace ${pair.from.name} with ${pair.to.name}`);
    }
    renamedSelections.add(renameSelectionKey(pair.from));
    renamedSelections.add(renameSelectionKey(pair.to));
  }
  const currentUnrelated = unrelatedSelections(current.skills, renamedSelections);
  const finalUnrelated = unrelatedSelections(final.skills, renamedSelections);
  if (!isDeepStrictEqual(currentUnrelated, finalUnrelated)) {
    throw invalid('invalid-rename-manifest-transition', 'Skill Rename cannot change unrelated Skill Selections');
  }
  const sharedSources = new Set(currentUnrelated.map(({ source }) => source));
  for (const source of finalUnrelated.map(({ source }) => source)) sharedSources.add(source);
  for (const source of sharedSources) {
    if (!isDeepStrictEqual(current.sources[source], final.sources[source])) {
      throw invalid('invalid-rename-manifest-transition', `Skill Rename cannot change a source used by unrelated selections: ${source}`);
    }
  }
}

function validateRenameManifest(manifest, label) {
  const identities = new Set();
  for (const selection of manifest.skills) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || typeof selection.source !== 'string' || selection.source.length === 0
      || typeof selection.path !== 'string' || !isSafeSelectionPath(selection.path)) {
      throw invalid('invalid-skill-selection', `${label} Manifest has an invalid Skill Selection`);
    }
    if (!Object.hasOwn(manifest.sources, selection.source)) {
      throw invalid('unknown-source', `${label} Manifest selects an unknown Skill Source: ${selection.source}`);
    }
    const identity = renameSelectionKey(selection);
    if (identities.has(identity)) {
      throw invalid('duplicate-skill-selection', `${label} Manifest repeats a Skill Selection`);
    }
    identities.add(identity);
  }
}

function unrelatedSelections(selections, renamedSelections) {
  return selections
    .filter((selection) => !renamedSelections.has(renameSelectionKey(selection)))
    .map((selection) => structuredClone(selection))
    .sort((left, right) => renameSelectionKey(left).localeCompare(renameSelectionKey(right)));
}

async function inspectOldState({ pairs, ledger, layout }) {
  const entries = new Map();
  const removedEntries = new Set();
  const removedLinks = new Set();
  const skillRemovals = [];
  const exposureRemovals = [];
  for (const pair of pairs) {
    const matches = ledger.entries.filter((entry) => entry.name === pair.from.name
      && ledgerEntrySourceId(entry) === pair.from.source && entry.selectedPath === pair.from.path);
    if (matches.length !== 1) {
      throw invalid('rename-ownership-unbound', `Skill Rename requires one exact old Ledger entry: ${pair.from.name}`);
    }
    const entry = matches[0];
    const skillPath = path.join(layout.canonicalSkillsRoot, pair.from.name);
    if (path.resolve(entry.path) !== path.resolve(skillPath)) {
      throw invalid('rename-ownership-unbound', `Old Ledger path is not canonical: ${pair.from.name}`);
    }
    const expectedFingerprint = fingerprintDigest(entry.fingerprint);
    const actualFingerprint = await fingerprintIfPresent(skillPath);
    if (actualFingerprint && actualFingerprint !== expectedFingerprint) {
      throw invalid('skill-rename-drift', `Old Materialized Skill has Drift: ${pair.from.name}`);
    }
    if (actualFingerprint) {
      skillRemovals.push({
        type: 'remove-materialized-skill', path: skillPath,
        expected: { state: 'fingerprint', fingerprint: actualFingerprint },
      });
    }
    const linkPath = path.join(layout.claudeSkillsRoot, pair.from.name);
    const ownedLink = (ledger.harnessLinks ?? [])
      .some((candidate) => path.resolve(candidate) === path.resolve(linkPath));
    const linkStat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (linkStat && !ownedLink) {
      throw invalid('skill-rename-exposure-unowned', `Old Claude exposure is not Caddie-owned: ${pair.from.name}`);
    }
    if (ownedLink) {
      removedLinks.add(path.resolve(linkPath));
      const expected = await ownedExposureState(linkPath, skillPath, pair.from.name);
      if (expected) exposureRemovals.push({
        type: 'remove-harness-exposure', harness: 'claude', path: linkPath, expected,
      });
    }
    entries.set(renameSelectionKey(pair.from), entry);
    removedEntries.add(entry);
  }
  return { entries, removedEntries, removedLinks, skillRemovals, exposureRemovals };
}

async function inspectNewState({ pairs, materializations, ledger, layout, manifest }) {
  const entries = new Map();
  const materializationOperations = [];
  const exposures = [];
  for (const pair of pairs) {
    const candidate = materializations.get(renameSelectionKey(pair.to));
    const actualSource = await fingerprint(candidate.sourcePath);
    if (actualSource !== candidate.sourceFingerprint) {
      throw invalid('stale-rename-source', `Inspected rename source changed: ${pair.to.name}`);
    }
    const skillFile = path.join(candidate.sourcePath, 'SKILL.md');
    const sourceName = extractSkillName(await fs.readFile(skillFile, 'utf8'), skillFile, path.basename(candidate.sourcePath));
    if (sourceName !== pair.to.name) {
      throw invalid('rename-name-mismatch', `Renamed SKILL.md name does not match its destination: ${pair.to.name}`);
    }
    const selection = manifest.skills.find((candidateSelection) => sameSelection(candidateSelection, pair.to));
    if (selection.invocation === 'user-only') {
      const invocation = await inspectInvocation(candidate.sourcePath);
      if (invocation.classification !== 'user-only' || invocation.findings?.length > 0) {
        throw invalid('rename-invocation-mismatch', `Renamed skill does not apply its final Invocation Policy: ${pair.to.name}`);
      }
    }
    const destinationPath = path.join(layout.canonicalSkillsRoot, pair.to.name);
    const ownedMatches = ledger.entries.filter((entry) => entry.name === pair.to.name
      || path.resolve(entry.path) === path.resolve(destinationPath));
    if (ownedMatches.length > 1) throw invalid('rename-destination-collision', `Rename destination ownership is ambiguous: ${pair.to.name}`);
    const owned = ownedMatches[0] ?? null;
    if (owned && (owned.name !== pair.to.name || path.resolve(owned.path) !== path.resolve(destinationPath)
      || ledgerEntrySourceId(owned) !== pair.to.source || owned.selectedPath !== pair.to.path)) {
      throw invalid('rename-destination-collision', `Rename destination belongs to a different Skill Selection: ${pair.to.name}`);
    }
    const actualDestination = await fingerprintIfPresent(destinationPath);
    if (actualDestination && (!owned || actualDestination !== fingerprintDigest(owned.fingerprint))) {
      throw invalid('rename-destination-collision', `Rename destination contains unowned or changed content: ${pair.to.name}`);
    }
    if (actualDestination !== candidate.sourceFingerprint || candidate.sourceCleanup) {
      materializationOperations.push({
        ...candidate,
        type: 'materialize-skill',
        destinationPath,
        expectedDestination: actualDestination
          ? { state: 'fingerprint', fingerprint: actualDestination }
          : { state: 'absent' },
      });
    }
    const entry = {
      ...(owned ?? {}),
      name: pair.to.name,
      path: destinationPath,
      fingerprint: candidate.sourceFingerprint,
      sourceId: pair.to.source,
      selectedPath: pair.to.path,
    };
    delete entry.source;
    entries.set(renameSelectionKey(pair.to), entry);
    const linkPath = path.join(layout.claudeSkillsRoot, pair.to.name);
    const ownedLink = (ledger.harnessLinks ?? [])
      .some((candidateLink) => path.resolve(candidateLink) === path.resolve(linkPath));
    exposures.push({
      type: 'ensure-harness-exposure',
      harness: 'claude',
      linkPath,
      targetPath: destinationPath,
      targetFingerprint: candidate.sourceFingerprint,
      expected: await expectedExposure(linkPath, destinationPath, pair.to.name, Boolean(owned && ownedLink)),
    });
  }
  return { entries, materializations: materializationOperations, exposures };
}

async function planRenameSettings({ scope, home, pairs, manifest, ownership, layout }) {
  const oldTargets = pairs.map(({ from }) => ({
    skill: from.name,
    skillFile: path.join(layout.canonicalSkillsRoot, from.name, 'SKILL.md'),
    enabled: true,
    allowMissingOwned: true,
  }));
  const newTargets = pairs.map(({ to }) => {
    const selection = manifest.skills.find((candidate) => sameSelection(candidate, to));
    return {
      skill: to.name,
      skillFile: path.join(layout.canonicalSkillsRoot, to.name, 'SKILL.md'),
      enabled: selection.enabled ?? true,
    };
  });
  return planHarnessSettingsBatch({ scope, home, targets: [...oldTargets, ...newTargets], ownership: [...ownership] });
}

function replacementLedger({ ledger, oldState, newState, settings }) {
  const entries = ledger.entries.filter((entry) => !oldState.removedEntries.has(entry));
  for (const next of newState.entries.values()) {
    const index = entries.findIndex((entry) => entry.name === next.name || path.resolve(entry.path) === path.resolve(next.path));
    if (index >= 0) entries[index] = next;
    else entries.push(next);
  }
  const newLinks = newState.exposures.map(({ linkPath }) => path.resolve(linkPath));
  const harnessLinks = [...new Set([
    ...(ledger.harnessLinks ?? []).filter((link) => !oldState.removedLinks.has(path.resolve(link))),
    ...newLinks,
  ])].sort();
  return {
    ...ledger,
    version: 1,
    harnessLinks,
    harnessSettings: settings.ownership,
    entries,
  };
}

async function lockOperations(finalValue, lockPath) {
  if (finalValue === undefined) return [];
  if (!finalValue || typeof finalValue !== 'object' || Array.isArray(finalValue)) {
    throw invalid('invalid-rename-lock', 'Skill Rename Lock must be a JSON object');
  }
  const content = `${JSON.stringify(finalValue, null, 2)}\n`;
  const current = await fs.readFile(lockPath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (current === content) return [];
  return [{
    type: 'write-lock', path: lockPath, content,
    expected: current === null ? { state: 'absent' } : { state: 'file', fingerprint: await fingerprint(lockPath) },
  }];
}

async function ownedExposureState(linkPath, targetPath, name) {
  const stat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw invalid('skill-rename-exposure-drift', `Owned Claude exposure changed: ${name}`);
  const target = await fs.readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(targetPath)) {
    throw invalid('skill-rename-exposure-drift', `Owned Claude exposure changed: ${name}`);
  }
  return { state: 'symlink', target };
}

async function expectedExposure(linkPath, targetPath, name, owned) {
  const stat = await fs.lstat(linkPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { state: 'absent' };
  if (!owned) throw invalid('rename-destination-collision', `Claude exposure at the new name is not Caddie-owned: ${name}`);
  if (!stat.isSymbolicLink()) throw invalid('rename-destination-collision', `Claude exposure collides at the new name: ${name}`);
  const target = await fs.readlink(linkPath);
  if (path.resolve(path.dirname(linkPath), target) !== path.resolve(targetPath)) {
    throw invalid('rename-destination-collision', `Claude exposure points at different content: ${name}`);
  }
  return { state: 'symlink', target };
}

function fingerprintDigest(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value?.complete === true && typeof value.digest === 'string' && value.digest.length > 0) return value.digest;
  throw invalid('rename-ownership-unbound', 'Skill Rename requires a complete owned fingerprint');
}

function selectionCount(selections, identity) {
  return selections.filter((selection) => sameSelection(selection, identity)).length;
}

function sameSelection(selection, identity) {
  return selection?.source === identity.source && selection?.path === identity.path;
}
