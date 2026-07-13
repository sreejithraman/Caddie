import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  cursor = null,
}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) throw new TypeError('maxContentBytes must be a positive integer');

  const { normalized, selectedPath } = await selectedDirectory(root, selectionPath);
  await assertContainedSymlinks(selectedPath);
  const fingerprint = await fingerprintDirectory(selectedPath);
  const offset = continuationOffset(cursor, { fingerprint, maxEntries, maxContentBytes });
  const entries = [];
  let totalEntries = 0;

  async function walk(directory, relative = '') {
    const names = await readdir(directory);
    names.sort(compareNames);
    for (const name of names) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(directory, name));
      totalEntries += 1;
      if (totalEntries > offset && entries.length < maxEntries) {
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
  if (offset > totalEntries) throw continuationError('continuation-exhausted', 'Continuation starts beyond the available evidence', 'invalid');
  const nextOffset = offset + entries.length;
  const continuationCursor = nextOffset < totalEntries
    ? createContinuation({ fingerprint, maxEntries, maxContentBytes, offset: nextOffset })
    : null;
  const bounded = offset > 0 || continuationCursor !== null || skillBytes > maxContentBytes;
  const evidenceComplete = findings.length === 0 && !bounded;
  const cacheReference = bounded ? `sha256:${digest(JSON.stringify({
    version: 1,
    fingerprint: fingerprint.digest,
    maxEntries,
    maxContentBytes,
  }))}` : null;

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
      omittedEntries: Math.max(0, totalEntries - nextOffset),
      findings,
      ...(cacheReference ? { cacheReference } : {}),
      ...(continuationCursor ? { continuationCursor } : {}),
    },
  };
}

function continuationOffset(cursor, { fingerprint, maxEntries, maxContentBytes }) {
  if (cursor == null) return 0;
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw continuationError('invalid-continuation', 'Continuation cursor must be a non-empty string', 'invalid');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw continuationError('invalid-continuation', 'Continuation cursor is malformed', 'invalid');
  }
  const payload = value ? {
    version: value.version,
    fingerprint: value.fingerprint,
    maxEntries: value.maxEntries,
    maxContentBytes: value.maxContentBytes,
    offset: value.offset,
  } : {};
  const checksum = value?.checksum;
  if (value?.version !== 1 || typeof checksum !== 'string' || checksum !== digest(JSON.stringify(payload))
    || !Number.isSafeInteger(value.offset) || value.offset < 1 || typeof value.fingerprint !== 'string') {
    throw continuationError('invalid-continuation', 'Continuation cursor failed integrity validation', 'invalid');
  }
  if (value.maxEntries !== maxEntries || value.maxContentBytes !== maxContentBytes) {
    throw continuationError('continuation-limits-mismatch', 'Continuation must use the originally approved evidence limits', 'invalid');
  }
  if (value.fingerprint !== fingerprint.digest) {
    throw continuationError('stale-continuation', 'Skill evidence changed after the continuation was issued', 'replan');
  }
  return value.offset;
}

function createContinuation({ fingerprint, maxEntries, maxContentBytes, offset }) {
  const payload = { version: 1, fingerprint: fingerprint.digest, maxEntries, maxContentBytes, offset };
  return Buffer.from(JSON.stringify({ ...payload, checksum: digest(JSON.stringify(payload)) })).toString('base64url');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function continuationError(code, message, disposition) {
  return Object.assign(new Error(message), { code, disposition });
}
