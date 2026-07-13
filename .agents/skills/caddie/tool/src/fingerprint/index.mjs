import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

const ALGORITHM = 'sha256-tree-v1';

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finding(error, relativePath) {
  const code = error?.code === 'EACCES' || error?.code === 'EPERM'
    ? 'permission-denied'
    : error?.code === 'ENOENT'
      ? 'missing-path'
      : 'unreadable-path';
  return { code, path: relativePath || '.', operation: 'fingerprint' };
}

function addRecord(hash, type, relativePath, mode, value = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(type);
  hash.update('\0');
  hash.update(relativePath);
  hash.update('\0');
  hash.update(mode);
  hash.update('\0');
  hash.update(String(bytes.byteLength));
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
}

/**
 * Produces an authoritative, location-independent fingerprint of a directory.
 * Symlinks are hashed as links and are never followed. Any unreadable entry makes
 * the fingerprint incomplete and suppresses the digest so callers cannot use
 * partial content to authorize replacement.
 */
export async function fingerprintDirectory(root, { maxFindings = 50 } = {}) {
  const hash = createHash('sha256');
  const findings = [];
  let fileCount = 0;
  let byteCount = 0;

  async function walk(absolutePath, relativePath) {
    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if (findings.length < maxFindings) findings.push(finding(error, relativePath));
      return;
    }

    const mode = String(stat.mode & 0o111 ? 1 : 0);
    if (stat.isSymbolicLink()) {
      try {
        const target = await readlink(absolutePath);
        addRecord(hash, 'link', relativePath, mode, target);
        fileCount += 1;
        byteCount += Buffer.byteLength(target);
      } catch (error) {
        if (findings.length < maxFindings) findings.push(finding(error, relativePath));
      }
      return;
    }

    if (stat.isDirectory()) {
      if (relativePath) addRecord(hash, 'directory', relativePath, mode);
      let entries;
      try {
        entries = await readdir(absolutePath);
      } catch (error) {
        if (findings.length < maxFindings) findings.push(finding(error, relativePath));
        return;
      }
      entries.sort(compareNames);
      for (const entry of entries) {
        await walk(path.join(absolutePath, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
      return;
    }

    if (stat.isFile()) {
      try {
        const content = await readFile(absolutePath);
        addRecord(hash, 'file', relativePath, mode, content);
        fileCount += 1;
        byteCount += content.byteLength;
      } catch (error) {
        if (findings.length < maxFindings) findings.push(finding(error, relativePath));
      }
      return;
    }

    addRecord(hash, 'other', relativePath, mode);
  }

  await walk(root, '');
  const complete = findings.length === 0;
  return {
    algorithm: ALGORITHM,
    digest: complete ? hash.digest('hex') : null,
    complete,
    fileCount,
    byteCount,
    findings,
  };
}

function usable(value) {
  return Boolean(value && value.complete === true && typeof value.digest === 'string' && value.digest.length > 0);
}

/** Classifies live source and installation facts against the last reconciliation. */
export function classifyFingerprints({ lastReconciled, source, installation }) {
  const evidence = { lastReconciled, source, installation };
  const missing = Object.entries(evidence).filter(([, value]) => value == null).map(([name]) => name);
  const partial = Object.entries(evidence).filter(([, value]) => value != null && !usable(value)).map(([name]) => name);

  if (missing.length > 0 || partial.length > 0) {
    return {
      kind: 'insufficient-evidence',
      label: 'Insufficient Evidence',
      safeToReplace: false,
      coverage: { complete: false, missing, partial },
      evidence,
    };
  }

  const sourceChanged = source.digest !== lastReconciled.digest;
  const installationChanged = installation.digest !== lastReconciled.digest;
  let kind = 'unchanged';
  let label = 'Unchanged';
  if (sourceChanged && installationChanged) {
    kind = source.digest === installation.digest ? 'upstream-change' : 'divergence';
    label = source.digest === installation.digest ? 'Upstream Change' : 'Divergence';
  } else if (sourceChanged) {
    kind = 'upstream-change';
    label = 'Upstream Change';
  } else if (installationChanged) {
    kind = 'drift';
    label = 'Drift';
  }

  return {
    kind,
    label,
    safeToReplace: kind === 'unchanged' || kind === 'upstream-change',
    coverage: { complete: true, missing: [], partial: [] },
    changes: { source: sourceChanged, installation: installationChanged },
    evidence,
  };
}

export const FINGERPRINT_ALGORITHM = ALGORITHM;
