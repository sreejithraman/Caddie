import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL('./local-source-worker.mjs', import.meta.url));
const WORKER_TIMEOUT_MS = Object.freeze({
  'read-text': 3_000,
  'inspect-local-git': 8_000,
  'inspect-project-checkout': 3_000,
  'inspect-project-marker': 3_000,
});

const READ_ONLY_GIT_COMMANDS = Object.freeze([
  Object.freeze(['rev-parse', '--show-toplevel']),
  Object.freeze(['rev-parse', '--git-common-dir']),
  Object.freeze(['symbolic-ref', '--quiet', '--short', 'HEAD']),
  Object.freeze(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
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

export async function readLocalSourceText(filePath, { runWorker = defaultRunWorker } = {}) {
  const result = await runWorker('read-text', { filePath });
  return result.text;
}

export async function inspectLocalGitSource({ checkout, selectedPath, acceptedCommit = null, runGit = null }) {
  if (runGit === null) {
    return defaultRunWorker('inspect-local-git', { checkout, selectedPath, acceptedCommit });
  }
  return inspectLocalGitSourceInProcess({ checkout, selectedPath, acceptedCommit, runGit });
}

export async function inspectLocalGitSourceInProcess({ checkout, selectedPath, acceptedCommit = null, runGit = defaultRunGit }) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) {
    throw new LocalSourceInspectionError('invalid-checkout', 'Local checkout must be an absolute path');
  }
  const relativeSelection = safeRelative(selectedPath);
  const exactCheckout = await realpath(checkout);
  const selected = path.resolve(exactCheckout, relativeSelection);
  if (!inside(exactCheckout, selected)) throw new LocalSourceInspectionError('selection-outside-checkout', 'Selected path leaves its checkout');
  const exactSelected = await realpath(selected);
  if (!inside(exactCheckout, exactSelected)) throw new LocalSourceInspectionError('selection-outside-checkout', 'Selected path leaves its checkout');

  let root;
  try {
    root = (await git(runGit, exactCheckout, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (cause) {
    return {
      kind: 'non-git', checkout: exactCheckout, selectedPath: relativeSelection,
      fingerprint: await fingerprint(selected), cause: boundedCause(cause),
    };
  }
  if (!path.isAbsolute(root)) throw new LocalSourceInspectionError('invalid-repository-root', 'Git returned a non-absolute repository root');
  const repositoryRoot = await realpath(root);
  if (!inside(repositoryRoot, exactCheckout)) {
    throw new LocalSourceInspectionError('invalid-repository-root', 'Git returned a repository root outside the local source');
  }
  const commonValue = (await git(runGit, repositoryRoot, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const commonDirectory = await realpath(path.resolve(repositoryRoot, commonValue));
  const mainRepositoryRoot = path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : repositoryRoot;
  const checkoutKind = path.resolve(repositoryRoot) === path.resolve(mainRepositoryRoot) ? 'main' : 'worktree';
  const sourceRootRelativePath = path.relative(repositoryRoot, exactCheckout) || '.';
  const repositorySelection = path.relative(repositoryRoot, exactSelected);
  const selectedPathspec = repositorySelection === '' ? '.' : `:(literal)${repositorySelection}`;

  let branch = null;
  try { branch = (await git(runGit, repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(); } catch {}
  const commit = (await git(runGit, repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim().toLowerCase();
  const selectedStatus = (await git(runGit, repositoryRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', selectedPathspec,
  ])).stdout.trim();
  const ignoredSelected = (await git(runGit, repositoryRoot, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '--', selectedPathspec,
  ])).stdout.trim();
  let trackedBytesChanged = false;
  try {
    await git(runGit, repositoryRoot, ['diff', '--quiet', 'HEAD', '--', selectedPathspec]);
  } catch (error) {
    if (error?.code === 1 || error?.exitCode === 1) trackedBytesChanged = true;
    else throw error;
  }
  const exactBytesMatch = await selectedBytesMatchHead(runGit, repositoryRoot, selectedPathspec);
  if (!exactBytesMatch) trackedBytesChanged = true;
  const repositoryStatus = repositorySelection === '' ? '' : (await git(runGit, repositoryRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--', '.', `:(exclude,literal)${repositorySelection}`,
  ])).stdout.trim();
  let descendant = null;
  if (acceptedCommit !== null) {
    if (typeof acceptedCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(acceptedCommit)) {
      throw new LocalSourceInspectionError('invalid-accepted-commit', 'Accepted commit must be a full object ID');
    }
    try {
      await git(runGit, repositoryRoot, ['merge-base', '--is-ancestor', acceptedCommit.toLowerCase(), commit]);
      descendant = true;
    } catch (error) {
      if (error?.code === 1 || error?.exitCode === 1) descendant = false;
      else throw error;
    }
  }
  return {
    kind: 'git', checkout: exactCheckout, repositoryRoot,
    repositoryId: repositoryId(commonDirectory, ''), checkoutKind, sourceRootRelativePath,
    selectedPath: relativeSelection,
    branch, commit, descendant,
    selectedPathDirty: selectedStatus.length > 0 || ignoredSelected.length > 0 || trackedBytesChanged,
    committedContentMatch: selectedStatus.length === 0 && ignoredSelected.length === 0 && !trackedBytesChanged,
    unrelatedDirty: repositoryStatus.length > 0,
    selectedStatus: lines(selectedStatus),
    ignoredSelected: lines(ignoredSelected),
    unrelatedStatus: lines(repositoryStatus),
    fingerprint: await fingerprint(exactSelected),
  };
}

export async function inspectProjectCheckout({ projectRoot, runGit = null }) {
  if (runGit === null) {
    try {
      return await defaultRunWorker('inspect-project-checkout', { projectRoot });
    } catch {
      return defaultRunWorker('inspect-project-marker', { projectRoot })
        .catch(() => plainProjectCheckout(projectRoot));
    }
  }
  return inspectProjectCheckoutInProcess({ projectRoot, runGit });
}

export async function inspectProjectCheckoutInProcess({ projectRoot, runGit = defaultRunGit }) {
  const exactProjectRoot = await realpath(projectRoot);
  let repositoryRoot;
  try {
    repositoryRoot = await realpath((await git(runGit, exactProjectRoot, ['rev-parse', '--show-toplevel'])).stdout.trim());
  } catch {
    return plainProjectCheckout(exactProjectRoot);
  }
  if (!inside(repositoryRoot, exactProjectRoot)) return plainProjectCheckout(exactProjectRoot);
  const relativeProjectPath = path.relative(repositoryRoot, exactProjectRoot);
  const commonValue = (await git(runGit, repositoryRoot, ['rev-parse', '--git-common-dir'])).stdout.trim();
  const commonDirectory = await realpath(path.resolve(repositoryRoot, commonValue));
  const mainRepositoryRoot = path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : repositoryRoot;
  const mainProjectRoot = path.resolve(mainRepositoryRoot, relativeProjectPath);
  let branch = null;
  try { branch = (await git(runGit, repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(); } catch {}
  const status = (await git(runGit, repositoryRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--branch',
  ])).stdout.trim().split('\n').filter(Boolean);
  const header = status[0]?.startsWith('## ') ? status[0] : '';
  const workingTreeClean = status.slice(header ? 1 : 0).length === 0;
  const upstreamState = header.includes('[gone]') ? 'gone' : header.includes('...') ? 'tracked' : 'none';
  let includedInDefaultBranch = null;
  try {
    const defaultBranch = (await git(runGit, repositoryRoot, [
      'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD',
    ])).stdout.trim();
    try {
      await git(runGit, repositoryRoot, ['merge-base', '--is-ancestor', 'HEAD', defaultBranch]);
      includedInDefaultBranch = true;
    } catch (error) {
      if (error?.code === 1 || error?.exitCode === 1) includedInDefaultBranch = false;
    }
  } catch {}
  const checkoutKind = path.resolve(exactProjectRoot) === mainProjectRoot ? 'main' : 'worktree';
  return {
    repositoryId: `repository-${createHash('sha256').update(`${commonDirectory}\0${relativeProjectPath}`).digest('hex').slice(0, 24)}`,
    gitRepositoryId: repositoryId(commonDirectory, ''), repositoryRoot,
    checkoutKind, branch: branch || null, mainProjectRoot,
    workingTreeClean, upstreamState, includedInDefaultBranch,
    lifecycle: checkoutKind === 'worktree' && workingTreeClean && upstreamState === 'gone'
      && includedInDefaultBranch === true ? 'likely-finished' : 'active',
  };
}

function plainProjectCheckout(projectRoot) {
  return {
    repositoryId: repositoryId(path.join(projectRoot, '.git'), ''),
    gitRepositoryId: null, repositoryRoot: null,
    checkoutKind: 'project', branch: null, mainProjectRoot: projectRoot,
    workingTreeClean: null, upstreamState: 'unknown', includedInDefaultBranch: null, lifecycle: 'active',
  };
}

export async function inspectProjectCheckoutMarkerInProcess({ projectRoot }) {
  const exactProjectRoot = await realpath(projectRoot);
  let repositoryRoot = exactProjectRoot;
  let marker = null;
  while (true) {
    const candidate = path.join(repositoryRoot, '.git');
    try {
      const stat = await lstat(candidate);
      if (stat.isDirectory()) marker = { kind: 'main', commonDirectory: candidate };
      else if (stat.isFile()) {
        const content = await readFile(candidate, 'utf8');
        const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
        if (match) {
          const gitDirectory = path.resolve(repositoryRoot, match[1]);
          marker = {
            kind: 'worktree',
            commonDirectory: path.basename(path.dirname(gitDirectory)) === 'worktrees'
              ? path.dirname(path.dirname(gitDirectory)) : gitDirectory,
          };
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (marker || path.dirname(repositoryRoot) === repositoryRoot) break;
    repositoryRoot = path.dirname(repositoryRoot);
  }
  if (!marker) return plainProjectCheckout(exactProjectRoot);
  const relativeProjectPath = path.relative(repositoryRoot, exactProjectRoot);
  const mainRepositoryRoot = path.dirname(marker.commonDirectory);
  return {
    repositoryId: repositoryId(marker.commonDirectory, relativeProjectPath),
    gitRepositoryId: repositoryId(marker.commonDirectory, ''), repositoryRoot,
    checkoutKind: marker.kind,
    branch: null,
    mainProjectRoot: path.resolve(mainRepositoryRoot, relativeProjectPath),
    workingTreeClean: null,
    upstreamState: 'unknown',
    includedInDefaultBranch: null,
    lifecycle: 'active',
  };
}

async function selectedBytesMatchHead(runGit, checkout, selectedPathspec) {
  const raw = (await git(runGit, checkout, [
    'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', selectedPathspec,
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

async function defaultRunWorker(operation, input) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [workerPath, operation, JSON.stringify(input)], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: WORKER_TIMEOUT_MS[operation] ?? 3_000,
      killSignal: 'SIGKILL', windowsHide: true,
    });
    const response = JSON.parse(stdout);
    if (response.ok === true) return response.result;
    throw workerError(response.error);
  } catch (error) {
    if (error?.killed || error?.signal === 'SIGKILL' || error?.code === 'ETIMEDOUT') {
      throw new LocalSourceInspectionError('source-unavailable', 'Local source did not respond in time');
    }
    if (error instanceof LocalSourceInspectionError) throw error;
    throw new LocalSourceInspectionError('source-unavailable', 'Local source could not be inspected', boundedCause(error));
  }
}

function repositoryId(commonDirectory, relativeProjectPath) {
  return `repository-${createHash('sha256').update(`${commonDirectory}\0${relativeProjectPath}`).digest('hex').slice(0, 24)}`;
}

function workerError(value) {
  return new LocalSourceInspectionError(
    typeof value?.code === 'string' ? value.code : 'source-unavailable',
    typeof value?.message === 'string' ? value.message : 'Local source could not be inspected',
    value?.details && typeof value.details === 'object' ? value.details : {},
  );
}

async function git(runGit, checkout, command) {
  assertReadOnly(command);
  return runGit(['--no-optional-locks', '-C', checkout, ...command], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 2_500, killSignal: 'SIGKILL',
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
