import { locate } from './locate.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { resolveSelectionsWithEvidence } from '../manifest/resolve-selections.mjs';
import { classifyFingerprints, fingerprintDirectory } from '../fingerprint/index.mjs';
import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { scopeLayout } = require('../layout');

export async function inspect(input, runtime = {}) {
  const context = await locate(input, runtime);
  const scopes = { user: scopeEvidence(context.user), project: scopeEvidence(context.project) };
  const availableSkills = [];

  for (const scope of ['user', 'project']) {
    const located = context[scope];
    if (located.status !== 'found') continue;
    let manifest;
    try {
      manifest = await parseManifest(located.manifestPath, scope, located.root);
    } catch (error) {
      if (error?.code !== 'unsupported-manifest-version') throw error;
      scopes[scope] = {
        status: 'unsupported',
        manifestPath: located.manifestPath,
        ...error.details,
      };
      context.coverage.status = 'partial';
      context.coverage.issues.push({
        scope,
        code: error.code,
        path: located.manifestPath,
        supported: error.details.supported,
        received: error.details.received,
      });
      continue;
    }
    const layout = scopeLayout({ id: scope, root: located.root }, envHome(runtime));
    const lock = await readJson(layout.lockPath);
    const env = runtime.env ?? process.env;
    const cacheHome = input.cacheHome ?? env.XDG_CACHE_HOME ?? path.join(env.HOME ?? os.homedir(), '.cache');
    const selectionEvidence = await resolveSelectionsWithEvidence(manifest, {
      lock,
      cacheDir: path.join(cacheHome, 'caddie', 'sources'),
    });
    for (const finding of selectionEvidence.coverage.findings) {
      context.coverage.issues.push({ scope, ...finding });
    }
    if (!selectionEvidence.coverage.complete) context.coverage.status = 'partial';
    const skills = await enrichLiveState(
      selectionEvidence.skills,
      manifest,
      scope,
      located.root,
      envHome(runtime),
    );
    scopes[scope] = {
      status: 'inspected',
      manifestPath: manifest.manifestPath,
      manifestVersion: manifest.manifestVersion,
      skills,
    };
    availableSkills.push(...skills);
  }

  const effectiveByName = new Map();
  const shadowedSkills = [];
  for (const skill of availableSkills) {
    const previous = effectiveByName.get(skill.name);
    if (previous && previous.scope === 'user' && skill.scope === 'project') {
      shadowedSkills.push({ name: skill.name, selected: skill, shadowed: previous });
    } else if (previous) {
      throw invalid('skill-name-collision', `Available Skill name collision within ${skill.scope} scope: ${skill.name}`, {
        name: skill.name,
        selections: [previous, skill],
      });
    }
    effectiveByName.set(skill.name, skill);
  }

  const result = {
    focus: { cwd: input.cwd ?? runtime.cwd ?? process.cwd(), projectRoot: context.project.root },
    scopes,
    availableSkills: [...effectiveByName.values()],
    shadowedSkills,
    registry: context.registry,
    coverage: context.coverage,
  };
  if (input.birdseye === true) result.birdseye = await inspectBirdseye(input, runtime, context);
  else if (runtime._skipElsewhere !== true) result.elsewhere = await inspectElsewhere(input, runtime, context);
  return result;
}

function scopeEvidence(located) {
  return { status: 'missing', root: located.root, manifestPath: located.manifestPath };
}

async function inspectBirdseye(input, runtime, context) {
  const focusedRoot = context.project.root;
  const roots = [...context.registry.registeredProjects];
  roots.sort((left, right) => {
    if (left === focusedRoot) return -1;
    if (right === focusedRoot) return 1;
    return left.localeCompare(right);
  });
  const inspected = await Promise.all(roots.map((root) => inspectRegisteredProject(input, runtime, root)));
  const projects = inspected.map(({ root, evidence, finding }) => {
    if (finding) {
      return {
        root,
        focus: root === focusedRoot,
        scopes: { user: { status: 'unknown' }, project: { status: 'failed' } },
        availableSkills: [],
        coverage: {
          status: 'partial',
          issues: [{ scope: finding.scope, code: finding.code, disposition: finding.disposition }],
        },
      };
    }
    return {
      root,
      focus: root === focusedRoot,
      scopes: evidence.scopes,
      availableSkills: evidence.availableSkills,
      coverage: evidence.coverage,
    };
  });
  return {
    projects,
    usageEvidence: 'not-inspected',
    coverage: {
      status: projects.some((project) => project.coverage.status !== 'complete') ? 'partial' : 'complete',
      issues: projects.flatMap((project) => project.coverage.issues.map((issue) => ({ root: project.root, ...issue }))),
    },
  };
}

async function inspectElsewhere(input, runtime, context) {
  const focusedRoot = path.resolve(context.project.root);
  const roots = context.registry.registeredProjects
    .map((root) => path.resolve(root))
    .filter((root) => root !== focusedRoot)
    .sort((left, right) => left.localeCompare(right));
  const inspected = await Promise.all(roots.map((root) => inspectRegisteredProject(input, runtime, root)));
  const projects = inspected.map(({ root, evidence, finding }) => {
    if (finding) return { root, findings: [{ type: 'coverage', ...finding }] };
    const coverageIssues = evidence.coverage.issues
      .filter((issue) => issue.scope === 'project')
      .map((issue) => ({ type: 'coverage', ...issue }));
    const reconciliationFindings = (evidence.scopes.project.skills ?? [])
      .filter((skill) => !['unchanged', 'in-place'].includes(skill.reconciliation?.kind))
      .map((skill) => ({
        type: 'reconciliation',
        name: skill.name,
        kind: skill.reconciliation.kind,
        label: skill.reconciliation.label,
      }));
    return { root, findings: [...coverageIssues, ...reconciliationFindings] };
  });
  const projectsWithFindings = projects.filter((project) => project.findings.length > 0);
  return {
    registeredProjects: roots.length,
    projectsWithFindings: projectsWithFindings.length,
    relevantFindings: projectsWithFindings.reduce((count, project) => count + project.findings.length, 0),
    projects: projectsWithFindings,
  };
}

async function inspectRegisteredProject(input, runtime, root) {
  try {
    const evidence = await inspect(
      { ...input, cwd: root, projectManifestPath: undefined, birdseye: false },
      { ...runtime, _skipElsewhere: true },
    );
    return { root, evidence };
  } catch (error) {
    return {
      root,
      finding: {
        scope: 'project',
        code: error?.code ?? 'inspection-failed',
        disposition: error?.disposition ?? 'bug',
      },
    };
  }
}

async function enrichLiveState(skills, manifest, scopeId, scopeRoot, home) {
  const scope = { id: scopeId, root: scopeRoot };
  const layout = scopeLayout(scope, home);
  const ledger = await readLedger(layout.ledgerPath);
  const entries = new Map((ledger?.entries ?? []).map((entry) => [entry.name, entry]));
  return Promise.all(skills.map(async (skill) => {
    const source = manifest.sources[skill.source];
    const installationPath = path.join(layout.canonicalSkillsRoot, skill.name);
    const inPlace = source?.type === 'local' && await sameLocation(skill.skillPath, installationPath);
    if (inPlace) {
      return {
        ...skill,
        provenance: provenance(skill, source, null),
        reconciliation: { kind: 'in-place', label: 'In-place Skill', safeToReplace: false },
      };
    }

    const entry = entries.get(skill.name);
    const [sourceFingerprint, installationFingerprint] = await Promise.all([
      liveFingerprint(skill.skillPath, skill.fingerprint),
      liveFingerprint(installationPath),
    ]);
    const lastReconciled = storedFingerprint(entry?.fingerprint);
    return {
      ...skill,
      provenance: provenance(skill, source, entry),
      installationPath,
      reconciliation: classifyFingerprints({
        lastReconciled,
        source: sourceFingerprint,
        installation: installationFingerprint,
      }),
    };
  }));
}

function envHome(runtime = {}) {
  return runtime.env?.HOME ?? os.homedir();
}

async function sameLocation(left, right) {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function provenance(skill, source, entry) {
  return {
    source: skill.source,
    sourceType: source?.type ?? null,
    selectedPath: skill.selectedPath,
    resolvedCommit: skill.resolvedCommit ?? null,
    repositoryRoot: skill.repositoryRoot ?? null,
    repositoryDirty: skill.repositoryDirty ?? null,
    lastReconciledFingerprint: entry?.fingerprint ?? null,
    invocation: skill.invocation ?? null,
    invocationEvidence: skill.invocationEvidence ?? null,
    ...(skill.derivedFrom ? { derivedFrom: structuredClone(skill.derivedFrom) } : {}),
    ...(skill.migrationRecord ? { migrationRecord: skill.migrationRecord } : {}),
  };
}

function storedFingerprint(value) {
  if (typeof value === 'string') {
    return { algorithm: 'sha256-tree-v1', digest: value, complete: true, findings: [] };
  }
  if (value?.complete === true && typeof value.digest === 'string') return value;
  return null;
}

async function liveFingerprint(candidate, existing) {
  if (existing?.complete === true) return existing;
  if (!candidate) return null;
  try {
    return await fingerprintDirectory(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return {
      algorithm: 'sha256-tree-v1',
      digest: null,
      complete: false,
      findings: [{ code: error?.code ?? 'unreadable-path', path: candidate }],
    };
  }
}

async function readLedger(candidate) {
  try {
    const value = JSON.parse(await readFile(candidate, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function readJson(candidate) {
  try {
    const value = JSON.parse(await readFile(candidate, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}
