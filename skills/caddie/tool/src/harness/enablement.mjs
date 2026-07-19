import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { extractSkillName } from '../manifest/resolve-selections.mjs';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { invalid } from '../protocol/errors.mjs';
import { ledgerEntrySourceId, loadOwnershipLedger } from '../protocol/ledger-ownership.mjs';
import { settingsAdapters } from './settings-adapters.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { createPlan } = require('../plans');
const { harnessSettingsLayout, scopeLayout } = require('../layout');

export async function createEnablementPlan(input, runtime = {}) {
  const home = runtimeHome(input, runtime);
  const scope = normaliseScope(input.scope, home);
  if (typeof input.enabled !== 'boolean') throw invalid('invalid-skill-enabled', 'Skill Enablement requires an enabled boolean');
  const requested = normaliseSelection(input.selection);
  const layout = scopeLayout(scope, home);
  const manifestScope = scope.id === 'user' ? 'user' : 'project';
  const manifest = await parseManifest(layout.manifestPath, manifestScope, scope.root);
  const rawManifest = await readJsonObject(layout.manifestPath, 'Caddie Manifest');
  const collectionKey = Array.isArray(rawManifest.skills) ? 'skills' : 'selections';
  const selections = rawManifest[collectionKey];
  if (!Array.isArray(selections)) throw invalid('invalid-skill-selections', 'Caddie Manifest has no Skill Selections');
  const rawMatches = selections.filter((selection) => sameSelection(selection, requested));
  if (rawMatches.length !== 1) throw exactSelectionError(requested, rawMatches.length);

  const ledger = await loadOwnershipLedger(layout.ledgerPath, {
    expectedScopeId: scope.id, allowMissing: true, label: 'Skill Enablement ledger',
  });
  const selected = await resolveSelectedSkill({ manifest, requested, ledger });
  const installedSkillFile = path.join(layout.canonicalSkillsRoot, selected.name, 'SKILL.md');
  const installedContent = await fs.readFile(installedSkillFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw invalid('materialized-skill-missing', `Selected skill is not installed: ${selected.name}`);
    throw error;
  });
  extractSkillName(installedContent, installedSkillFile, selected.name);

  const nextManifest = structuredClone(rawManifest);
  const nextSelection = nextManifest[collectionKey].find((selection) => sameSelection(selection, requested));
  if (input.enabled) delete nextSelection.enabled;
  else nextSelection.enabled = false;

  const currentLedger = ledger ?? { version: 1, scopeId: scope.id, harnessLinks: [], entries: [] };
  let ownership = [...(currentLedger.harnessSettings ?? [])];
  const operations = [];
  if (input.registration) operations.push(input.registration);

  const manifestContent = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const currentManifestContent = await fs.readFile(layout.manifestPath, 'utf8');
  if (manifestContent !== currentManifestContent) {
    operations.push({
      type: 'write-manifest', path: layout.manifestPath, content: manifestContent,
      expected: { state: 'file', fingerprint: await fingerprint(layout.manifestPath) },
    });
  }

  const harnessPlan = await planHarnessSettings({
    scope, home, skill: selected.name, skillFile: installedSkillFile, enabled: input.enabled, ownership,
  });
  operations.push(...harnessPlan.operations);
  ownership = harnessPlan.ownership;

  const nextLedger = { ...currentLedger, version: 1, scopeId: scope.id, harnessSettings: ownership };
  if (JSON.stringify(nextLedger) !== JSON.stringify(currentLedger)) {
    operations.push({
      type: 'write-ledger', path: layout.ledgerPath, content: `${JSON.stringify(nextLedger, null, 2)}\n`,
      expected: ledger
        ? { state: 'file', fingerprint: await fingerprint(layout.ledgerPath) }
        : { state: 'absent' },
    });
  }

  if (operations.length === 0) return { status: 'unchanged', enabled: input.enabled, skill: selected.name, plan: null };
  return {
    status: 'planned', enabled: input.enabled, skill: selected.name,
    plan: createPlan({ kind: 'reconcile', home, scope, operations }),
  };
}

export async function planHarnessSettings({ scope, home, skill, skillFile, enabled, ownership = [], states = new Map() }) {
  if (typeof enabled !== 'boolean') throw invalid('invalid-skill-enabled', 'Harness settings enabled must be a boolean');
  let nextOwnership = [...ownership];
  const operations = [];
  for (const adapter of settingsAdapters) {
    const rendered = await renderHarness({
      adapter, scope, home, skill, skillFile, desired: enabled, ownership: nextOwnership, states,
    });
    if (rendered.operation) operations.push(rendered.operation);
    nextOwnership = rendered.ownership;
  }
  return { operations, ownership: nextOwnership.sort(compareOwnership), states };
}

export function enablementForMaterialization(manifest, materialization, scopeRoot, ledger) {
  if (!manifest) return null;
  const selections = manifest.skills ?? manifest.selections;
  if (!Array.isArray(selections)) throw invalid('invalid-skill-selections', 'Caddie Manifest has no Skill Selections');
  const ledgerEntry = (ledger?.entries ?? []).find((entry) => entry.name === materialization.name
    && path.resolve(entry.path) === path.resolve(materialization.destinationPath));
  const ledgerSourceId = ledgerEntrySourceId(ledgerEntry);
  if (typeof ledgerSourceId === 'string' && typeof ledgerEntry?.selectedPath === 'string') {
    const exact = selections.filter((selection) => selection?.source === ledgerSourceId
      && selection?.path === ledgerEntry.selectedPath);
    if (exact.length !== 1) {
      throw invalid('materialization-selection-unbound', `Materialized skill does not bind one Skill Selection: ${materialization.name}`);
    }
    return exact[0].enabled ?? true;
  }
  const exactLocal = [];
  for (const selection of selections) {
    if (!selection || typeof selection !== 'object' || typeof selection.source !== 'string' || typeof selection.path !== 'string') continue;
    if (Object.hasOwn(selection, 'enabled') && typeof selection.enabled !== 'boolean') {
      throw invalid('invalid-skill-enabled', 'Skill Selection enabled must be a boolean when present');
    }
    const source = manifest.sources?.[selection.source];
    if (source?.type === 'local' && typeof source.path === 'string') {
      const sourceRoot = path.resolve(scopeRoot, source.path);
      if (path.resolve(sourceRoot, selection.path) === path.resolve(materialization.sourcePath)) exactLocal.push(selection);
    }
  }
  if (exactLocal.length === 0) return null;
  if (exactLocal.length !== 1) {
    throw invalid('materialization-selection-ambiguous', `Materialized skill does not bind one Skill Selection: ${materialization.name}`);
  }
  return exactLocal[0].enabled ?? true;
}

async function renderHarness({ adapter, scope, home, skill, skillFile, desired, ownership, states }) {
  const settings = harnessSettingsLayout(adapter.harness, scope, home);
  const owned = ownership.find((entry) => entry.harness === adapter.harness
    && entry.skill === skill && entry.settingsPath === settings.path);
  let current = states.get(settings.path);
  if (!current) {
    const observed = await readOptional(settings.path);
    current = {
      ...observed,
      expected: observed.exists
        ? { state: 'file', fingerprint: await fingerprint(settings.path) }
        : { state: 'absent' },
    };
  }
  const rendered = adapter.render({ text: current.text, skill, skillFile, desired, owned });
  const nextOwnership = ownership.filter((entry) => entry !== owned);
  if (rendered.transferContainerOwnership) {
    const index = nextOwnership.findIndex((entry) => entry.harness === adapter.harness
      && entry.settingsPath === settings.path);
    if (index >= 0) nextOwnership[index] = { ...nextOwnership[index], containerCreated: true };
  }
  if (rendered.owned) {
    nextOwnership.push({
      ...(owned ?? {}),
      harness: adapter.harness, skill, settingsPath: settings.path,
      ...adapter.ownership({ skill, skillFile }),
      ...(rendered.ownership ?? {}),
    });
  }
  const operation = rendered.changed ? {
    type: 'write-harness-settings', harness: adapter.harness, skill,
    path: settings.path, content: rendered.text, expected: current.expected,
  } : null;
  states.set(settings.path, { ...current, exists: true, text: rendered.text });
  return { operation, ownership: nextOwnership };
}

async function resolveSelectedSkill({ manifest, requested, ledger }) {
  const ledgerMatches = (ledger?.entries ?? []).filter(
    (entry) => ledgerEntrySourceId(entry) === requested.source && entry.selectedPath === requested.path,
  );
  if (ledgerMatches.length > 1) throw exactSelectionError(requested, ledgerMatches.length);
  if (ledgerMatches.length === 1) return { name: ledgerMatches[0].name };

  const source = manifest.sources[requested.source];
  if (source?.type !== 'local') {
    throw invalid('skill-selection-unbound', 'Git Skill Enablement requires reconciled Ledger provenance', requested);
  }
  const selectedPath = path.resolve(source.path, requested.path);
  const skillFile = path.join(selectedPath, 'SKILL.md');
  const content = await fs.readFile(skillFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw invalid('skill-file-missing', `Selected skill has no SKILL.md: ${selectedPath}`);
    throw error;
  });
  return { name: extractSkillName(content, skillFile, path.basename(selectedPath)) };
}

function normaliseSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || typeof selection.source !== 'string' || !selection.source
    || typeof selection.path !== 'string' || !selection.path
    || Object.hasOwn(selection, 'name')) {
    throw invalid('invalid-enablement-selection', 'Skill Enablement requires exact source and path');
  }
  return { source: selection.source, path: selection.path };
}

function sameSelection(selection, requested) {
  return selection?.source === requested.source && selection?.path === requested.path;
}

function exactSelectionError(requested, matches) {
  return invalid('skill-selection-not-found', 'Skill Enablement requires one exact Skill Selection', {
    source: requested.source, path: requested.path, matches,
  });
}

function normaliseScope(scope, home) {
  if (!scope || typeof scope !== 'object' || typeof scope.id !== 'string'
    || typeof scope.root !== 'string' || !path.isAbsolute(scope.root)) {
    throw invalid('invalid-enablement-scope', 'Skill Enablement requires an absolute scope');
  }
  if (scope.id === 'user' && path.resolve(scope.root) !== home) {
    throw invalid('invalid-enablement-scope', 'User Skill Enablement scope must equal runtime HOME');
  }
  return { ...scope, root: path.resolve(scope.root) };
}

function runtimeHome(input, runtime) {
  const candidate = input.home ?? runtime.env?.HOME;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw invalid('invalid-runtime-home', 'Runtime HOME must be absolute');
  return path.resolve(candidate);
}

async function readJsonObject(candidate, label) {
  let value;
  try { value = JSON.parse(await fs.readFile(candidate, 'utf8')); } catch {
    throw invalid('invalid-manifest-json', `${label} is not valid JSON: ${candidate}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('invalid-manifest', `${label} must be an object`);
  return value;
}

async function readOptional(candidate) {
  try { return { exists: true, text: await fs.readFile(candidate, 'utf8') }; } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

function compareOwnership(left, right) {
  return `${left.harness}\0${left.skill}`.localeCompare(`${right.harness}\0${right.skill}`);
}
