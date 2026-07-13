import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import skillMetadata from '../skill-metadata.js';

import { invalid } from '../protocol/errors.mjs';
import { inspectLockedGitSource } from '../sources/index.mjs';
import { resolveSelectionWithinSource } from '../sources/selection-path.mjs';
import { validateSelectionMetadata } from './selection-metadata.mjs';

const { parseSkillMetadata } = skillMetadata;
const execFileAsync = promisify(execFile);

export async function resolveSelections(manifest, options = {}) {
  return (await resolveSelectionsWithEvidence(manifest, options)).skills;
}

export async function resolveSelectionsWithEvidence(manifest, {
  lock = null,
  cacheDir = null,
  gitClient,
  maxFindings = 100,
  evidenceLimits = {},
} = {}) {
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1) throw new TypeError('maxFindings must be a positive integer');
  const skills = [];
  const findings = [];
  let omittedFindings = 0;
  const lockVersion = lock?.version ?? lock?.lockVersion;
  const lockSupported = lock == null || lockVersion === 1;

  function record(finding) {
    if (findings.length < maxFindings) findings.push(finding);
    else omittedFindings += 1;
  }

  for (const selection of manifest.skills) {
    validateSelection(selection, manifest);
    const source = manifest.sources[selection.source];
    if (!source) {
      throw invalid('unknown-source', `Unknown Skill Source: ${String(selection.source)}`, {
        manifestPath: manifest.manifestPath, source: selection.source ?? null,
      });
    }

    if (source.type === 'local') {
      skills.push(await resolveLocalSelection(manifest, source, selection));
      continue;
    }

    if (!lockSupported) {
      record({ code: 'unsupported-lock-version', source: source.name, received: lockVersion ?? null, supported: [1] });
      continue;
    }

    const lockEntry = findLockEntry(lock, source.name);
    if (!lockEntry) {
      record({ code: 'git-lock-missing', source: source.name, path: selection.path });
      continue;
    }
    if (!validLockEntry(lockEntry, source)) {
      record({ code: 'git-lock-invalid', source: source.name, path: selection.path });
      continue;
    }
    if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
      record({ code: 'git-cache-unconfigured', source: source.name, path: selection.path, commit: lockEntry.commit });
      continue;
    }

    const inspected = await inspectLockedGitSource({
      sourceId: source.name,
      url: source.url,
      commit: lockEntry.commit,
      selectionPath: selection.path,
      cacheDir,
      gitClient,
      ...evidenceLimits,
    });
    if (!inspected.evidence) {
      for (const finding of inspected.findings) {
        record({ ...finding, source: source.name, path: selection.path, commit: lockEntry.commit });
      }
      continue;
    }
    if (!inspected.coverage.complete) {
      record({
        code: 'git-source-evidence-partial',
        source: source.name,
        path: selection.path,
        commit: lockEntry.commit,
        reason: inspected.coverage.reason,
      });
      for (const finding of inspected.findings) {
        record({ ...finding, source: source.name, path: selection.path, commit: lockEntry.commit });
      }
    }
    const name = requireSkillName(inspected.evidence.skill, 'SKILL.md');
    skills.push({
      name,
      scope: manifest.scope,
      source: source.name,
      sourceType: 'git',
      selectedPath: selection.path,
      commit: lockEntry.commit.toLowerCase(),
      resolvedCommit: lockEntry.commit.toLowerCase(),
      fingerprint: inspected.evidence.fingerprint,
      freshness: inspected.resolution.freshness,
      ...lineageFields(selection),
    });
  }

  return {
    skills,
    coverage: {
      complete: findings.length === 0 && omittedFindings === 0,
      reason: findings.length > 0 || omittedFindings > 0 ? 'selection-evidence-partial' : null,
      findings,
      omittedFindings,
    },
  };
}

async function resolveLocalSelection(manifest, source, selection) {
  let resolved;
  try {
    resolved = await resolveSelectionWithinSource(source.path, selection.path);
  } catch (cause) {
    if (cause?.code === 'selection-outside-source') {
      throw invalid('selection-outside-source', cause.message, {
        manifestPath: manifest.manifestPath, source: source.name, path: selection.path,
      });
    }
    throw cause;
  }
  const skillPath = resolved.selectedPath;
  const skillFile = path.join(skillPath, 'SKILL.md');
  let content;
  try {
    content = await readFile(skillFile, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw invalid('skill-file-missing', `Selected skill has no SKILL.md: ${skillPath}`, { skillPath });
    }
    throw cause;
  }
  const name = extractSkillName(content, skillFile);
  const git = await localGitProvenance(skillPath);
  return {
    name,
    scope: manifest.scope,
    source: source.name,
    sourceType: 'local',
    selectedPath: selection.path,
    skillPath,
    skillFile,
    ...(git ?? {}),
    ...lineageFields(selection),
  };
}

function lineageFields(selection) {
  return {
    ...(selection.derivedFrom ? { derivedFrom: structuredClone(selection.derivedFrom) } : {}),
    ...(selection.migrationRecord ? { migrationRecord: selection.migrationRecord } : {}),
  };
}

async function localGitProvenance(skillPath) {
  try {
    const [{ stdout: root }, { stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['-C', skillPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execFileAsync('git', ['-C', skillPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      execFileAsync('git', ['-C', skillPath, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }),
    ]);
    return {
      repositoryRoot: root.trim(),
      resolvedCommit: commit.trim(),
      repositoryDirty: status.trim().length > 0,
    };
  } catch {
    return null;
  }
}

function validateSelection(selection, manifest) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw invalid('invalid-skill-selection', 'Every Skill Selection must be an object', { manifestPath: manifest.manifestPath });
  }
  if (typeof selection.path !== 'string' || !selection.path) {
    throw invalid('invalid-selection-path', 'Every Skill Selection must have a path', { manifestPath: manifest.manifestPath });
  }
  validateSelectionMetadata(selection, manifest.sources, manifest.manifestPath);
}

function findLockEntry(lock, sourceName) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return null;
  const entries = lock.sources;
  if (Array.isArray(entries)) return entries.find((entry) => entry?.sourceId === sourceName || entry?.name === sourceName) ?? null;
  if (entries && typeof entries === 'object') return entries[sourceName] ?? null;
  return null;
}

function validLockEntry(entry, source) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && entry.type === 'git'
    && entry.url === source.url
    && typeof entry.commit === 'string'
    && /^[0-9a-f]{40,64}$/i.test(entry.commit);
}

function requireSkillName(metadata, skillFile) {
  if (!metadata?.name) throw invalid('skill-name-missing', `SKILL.md frontmatter has no name: ${skillFile}`, { skillFile });
  return metadata.name;
}

export function extractSkillName(content, skillFile = 'SKILL.md') {
  const metadata = parseSkillMetadata(content);
  if (!metadata.frontmatterPresent) {
    throw invalid('skill-frontmatter-missing', `SKILL.md has no YAML frontmatter: ${skillFile}`, { skillFile });
  }
  return requireSkillName(metadata, skillFile);
}
