import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const execFileAsync = promisify(execFile);

const READ_ONLY_GIT_COMMANDS = Object.freeze([
  Object.freeze(['rev-parse', '--show-toplevel']),
  Object.freeze(['symbolic-ref', '--quiet', '--short', 'HEAD']),
  Object.freeze(['rev-parse', '--verify', 'HEAD^{commit}']),
  Object.freeze(['status', '--porcelain=v1', '--untracked-files=all']),
  Object.freeze(['ls-files', '--others', '--ignored', '--exclude-standard']),
  Object.freeze(['diff', '--quiet', 'HEAD', '--']),
  Object.freeze(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--']),
  Object.freeze(['merge-base', '--is-ancestor']),
]);

const MAX_SELECTED_TRACKED_FILES = 10_000;
const MAX_SELECTED_TRACKED_BYTES = 64 * 1024 * 1024;

export class LocalSourceInspectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSourceInspectionError';
    this.code = code;
    this.details = details;
  }
}

export async function inspectLocalGitSource({ checkout, selectedPath, acceptedCommit = null, runGit = defaultRunGit }) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) {
    throw new LocalSourceInspectionError('invalid-checkout', 'Local checkout must be an absolute path');
  }
  const relativeSelection = safeRelative(selectedPath);
  const exactCheckout = await realpath(checkout);
  const selected = path.resolve(exactCheckout, relativeSelection);
  if (!inside(exactCheckout, selected)) throw new LocalSourceInspectionError('selection-outside-checkout', 'Selected path leaves its checkout');

  let root;
  try {
    root = (await git(runGit, exactCheckout, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (cause) {
    return {
      kind: 'non-git', checkout: exactCheckout, selectedPath: relativeSelection,
      fingerprint: await fingerprint(selected), cause: boundedCause(cause),
    };
  }
  if (await realpath(root) !== exactCheckout) {
    return { kind: 'nested-git', checkout: exactCheckout, repositoryRoot: await realpath(root), selectedPath: relativeSelection };
  }

  let branch = null;
  try { branch = (await git(runGit, exactCheckout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(); } catch {}
  const commit = (await git(runGit, exactCheckout, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase();
  const selectedStatus = (await git(runGit, exactCheckout, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', relativeSelection,
  ])).stdout.trim();
  const ignoredSelected = (await git(runGit, exactCheckout, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '--', relativeSelection,
  ])).stdout.trim();
  let trackedBytesChanged = false;
  try {
    await git(runGit, exactCheckout, ['diff', '--quiet', 'HEAD', '--', relativeSelection]);
  } catch (error) {
    if (error?.code === 1 || error?.exitCode === 1) trackedBytesChanged = true;
    else throw error;
  }
  const exactBytesMatch = await selectedBytesMatchHead(runGit, exactCheckout, relativeSelection);
  if (!exactBytesMatch) trackedBytesChanged = true;
  const repositoryStatus = (await git(runGit, exactCheckout, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.', `:(exclude)${relativeSelection}`,
  ])).stdout.trim();
  let descendant = null;
  if (acceptedCommit !== null) {
    if (typeof acceptedCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(acceptedCommit)) {
      throw new LocalSourceInspectionError('invalid-accepted-commit', 'Accepted commit must be a full object ID');
    }
    try {
      await git(runGit, exactCheckout, ['merge-base', '--is-ancestor', acceptedCommit.toLowerCase(), commit]);
      descendant = true;
    } catch (error) {
      if (error?.code === 1 || error?.exitCode === 1) descendant = false;
      else throw error;
    }
  }
  return {
    kind: 'git', checkout: exactCheckout, repositoryRoot: exactCheckout, selectedPath: relativeSelection,
    branch, commit, descendant,
    selectedPathDirty: selectedStatus.length > 0 || ignoredSelected.length > 0 || trackedBytesChanged,
    committedContentMatch: selectedStatus.length === 0 && ignoredSelected.length === 0 && !trackedBytesChanged,
    unrelatedDirty: repositoryStatus.length > 0,
    selectedStatus: lines(selectedStatus),
    ignoredSelected: lines(ignoredSelected),
    unrelatedStatus: lines(repositoryStatus),
    fingerprint: await fingerprint(selected),
  };
}

async function selectedBytesMatchHead(runGit, checkout, selectedPath) {
  const raw = (await git(runGit, checkout, [
    'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', selectedPath,
  ])).stdout;
  const entries = raw.split('\0').filter(Boolean);
  if (entries.length > MAX_SELECTED_TRACKED_FILES) return false;
  let totalBytes = 0;
  for (const record of entries) {
    const separator = record.indexOf('\t');
    if (separator < 0) return false;
    const [mode, type, objectId] = record.slice(0, separator).split(' ');
    const filePath = record.slice(separator + 1);
    if (type !== 'blob') return false;
    let worktreeId;
    try {
      if (mode === '120000') {
        const target = await readlink(path.join(checkout, filePath));
        const content = Buffer.from(target);
        totalBytes += content.length;
        if (totalBytes > MAX_SELECTED_TRACKED_BYTES) return false;
        worktreeId = gitBlobId(content, objectId.length);
      } else {
        const absoluteFile = path.join(checkout, filePath);
        const stat = await lstat(absoluteFile);
        if (!stat.isFile()) return false;
        totalBytes += stat.size;
        if (totalBytes > MAX_SELECTED_TRACKED_BYTES) return false;
        worktreeId = await gitBlobIdFromFile(absoluteFile, stat.size, objectId.length);
      }
    } catch {
      return false;
    }
    if (worktreeId.toLowerCase() !== objectId.toLowerCase()) return false;
  }
  return true;
}

async function gitBlobIdFromFile(filePath, size, objectIdLength) {
  const algorithm = objectIdLength === 64 ? 'sha256' : 'sha1';
  const hash = createHash(algorithm).update(`blob ${size}\0`);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function gitBlobId(content, objectIdLength) {
  const algorithm = objectIdLength === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function localGitCommandPolicy() {
  return READ_ONLY_GIT_COMMANDS.map((entry) => [...entry]);
}

async function defaultRunGit(args, options) {
  return execFileAsync('git', args, options);
}

async function git(runGit, checkout, command) {
  assertReadOnly(command);
  return runGit(['--no-optional-locks', '-C', checkout, ...command], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
}

function assertReadOnly(command) {
  const allowed = READ_ONLY_GIT_COMMANDS.some((prefix) => prefix.every((part, index) => command[index] === part));
  if (!allowed) throw new LocalSourceInspectionError('git-command-not-allowed', 'Local Source Inspection tried a non-read-only Git command');
}

function safeRelative(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || path.isAbsolute(candidate)) {
    throw new LocalSourceInspectionError('invalid-selection-path', 'Selected path must be relative');
  }
  const normal = path.normalize(candidate);
  if (normal === '..' || normal.startsWith(`..${path.sep}`)) {
    throw new LocalSourceInspectionError('invalid-selection-path', 'Selected path leaves its checkout');
  }
  return normal;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function boundedCause(cause) {
  return { code: typeof cause?.code === 'string' ? cause.code : 'not-a-repository' };
}

function lines(value) {
  return value ? value.split('\n').slice(0, 100) : [];
}
