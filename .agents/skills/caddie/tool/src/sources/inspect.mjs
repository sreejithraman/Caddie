import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import skillMetadata from '../skill-metadata.js';

import { fingerprintDirectory } from '../fingerprint/index.mjs';
import { assertContainedSymlinks, resolveSelectionWithinSource } from './selection-path.mjs';

const { parseSkillMetadata } = skillMetadata;

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function selectedDirectory(root, selectionPath) {
  const { relativePath: normalized, selectedPath } = await resolveSelectionWithinSource(root, selectionPath);
  const stat = await lstat(selectedPath);
  if (!stat.isDirectory()) throw new TypeError('selectionPath must identify a skill directory');
  return { normalized, selectedPath };
}

export async function inspectSelectedDirectory({
  root,
  selectionPath,
  source,
  maxEntries = 200,
  maxContentBytes = 16 * 1024,
}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) throw new TypeError('maxContentBytes must be a positive integer');

  const { normalized, selectedPath } = await selectedDirectory(root, selectionPath);
  await assertContainedSymlinks(selectedPath);
  const fingerprint = await fingerprintDirectory(selectedPath);
  const entries = [];
  let totalEntries = 0;

  async function walk(directory, relative = '') {
    const names = await readdir(directory);
    names.sort(compareNames);
    for (const name of names) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(directory, name));
      totalEntries += 1;
      if (entries.length < maxEntries) {
        entries.push({
          path: childRelative,
          type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
          ...(stat.isFile() ? { bytes: stat.size } : {}),
        });
      }
      if (stat.isDirectory()) await walk(path.join(directory, name), childRelative);
    }
  }

  const findings = [];
  try {
    await walk(selectedPath);
  } catch (error) {
    findings.push({
      code: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission-denied' : 'unreadable-path',
      path: '.',
    });
  }

  let skillContent = '';
  let metadataContent = '';
  let skillBytes = 0;
  try {
    const content = await readFile(path.join(selectedPath, 'SKILL.md'));
    skillBytes = content.byteLength;
    skillContent = content.subarray(0, maxContentBytes).toString('utf8');
    metadataContent = content.subarray(0, Math.max(maxContentBytes, 64 * 1024)).toString('utf8');
  } catch (error) {
    findings.push({ code: error?.code === 'ENOENT' ? 'missing-skill-file' : 'unreadable-skill-file', path: 'SKILL.md' });
  }
  const metadata = parseSkillMetadata(metadataContent);
  const bounded = totalEntries > entries.length || skillBytes > maxContentBytes;
  const evidenceComplete = findings.length === 0 && !bounded;

  return {
    source: { ...source, selectionPath: normalized },
    artifact: { trust: 'untrusted', instructionPolicy: 'treat-as-data' },
    skill: {
      name: metadata.name,
      description: metadata.description,
      skillFile: skillContent,
      skillFileBytes: skillBytes,
      skillFileTruncated: skillBytes > maxContentBytes,
    },
    files: entries,
    fingerprint,
    coverage: {
      complete: evidenceComplete,
      reason: findings.length > 0 ? 'inspection-partial' : bounded ? 'output-bounded' : null,
      inspectedEntries: totalEntries,
      returnedEntries: entries.length,
      omittedEntries: Math.max(0, totalEntries - entries.length),
      findings,
    },
  };
}
