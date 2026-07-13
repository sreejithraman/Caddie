import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  applyPublicationPlan,
  buildPublicationPlan,
  prepareChangeSandbox,
  prepareGitChange,
  resumeGitChange,
} from '../changeset/index.mjs';
import { replan } from '../changeset/errors.mjs';
import { invalid } from './errors.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');

const KINDS = new Set(['prepare-git-change', 'prepare-change-sandbox', 'publish-git-change']);

export async function createPreparationWorkflowPlan(input, runtime = {}) {
  const kind = input.workflow;
  if (!KINDS.has(kind)) throw new TypeError(`Unsupported preparation workflow: ${kind}`);
  if (['prepare-git-change', 'publish-git-change'].includes(kind) && !isExactCommit(input.expectedBaseCommit)) {
    throw invalid(
      'expected-base-commit-required',
      'Git preparation requires an exact expectedBaseCommit before approval',
    );
  }
  const changes = validateChanges(input.changes);
  const validationCommands = validateCommands(input.validationCommands);
  const request = kind !== 'prepare-change-sandbox'
    ? pick(input, ['repository', 'slug', 'baseRef', 'expectedBaseCommit', 'workspaceRoot', 'message', 'authorName', 'authorEmail', 'dependencyCommits'])
    : pick(input, ['source', 'slug', 'workspaceRoot']);
  if (kind === 'publish-git-change') {
    const timestamp = exactTimestamp(input.commitTimestamp ?? new Date().toISOString());
    request.authorDate = timestamp;
    request.committerDate = timestamp;
  }
  let publication;
  if (kind === 'publish-git-change') {
    const callbacks = {
      author: ({ directory }) => applyChanges(directory, changes),
      validate: ({ directory }) => runValidation(directory, validationCommands),
    };
    const preview = await (runtime.previewGitChange ?? previewGitChange)({ ...request, ...callbacks });
    publication = validatePublication({ ...input, headCommit: preview.headCommit });
  }
  const payload = { version: 1, kind, request, changes, validationCommands, ...(publication ? { publication } : {}) };
  return Object.freeze({ ...payload, id: hashValue(payload) });
}

export async function applyPreparationWorkflow(plan, approval, runtime = {}) {
  verifyPreparationPlan(plan, approval);
  const callbacks = {
    author: ({ directory }) => applyChanges(directory, plan.changes),
    validate: ({ directory }) => runValidation(directory, plan.validationCommands),
  };
  if (plan.kind === 'prepare-git-change') {
    return (runtime.prepareGitChange ?? prepareGitChange)({ ...plan.request, ...callbacks });
  }
  if (plan.kind === 'publish-git-change') {
    const approved = plan.publication;
    const preparationOptions = {
      ...plan.request,
      ...callbacks,
      expectedChangedFiles: plan.changes.map(({ path: changedPath }) => changedPath),
      expectedHeadCommit: approved.headCommit,
    };
    let preparation;
    try {
      preparation = await (runtime.prepareGitChange ?? prepareGitChange)(preparationOptions);
    } catch (error) {
      if (error?.code !== 'branch-already-exists') throw error;
      preparation = await (runtime.resumeGitChange ?? resumeGitChange)(preparationOptions);
    }
    if (preparation.headCommit !== approved.headCommit) {
      throw replan('prepared-commit-mismatch', 'Prepared commit differs from the exact commit approved by the user', {
        expected: approved.headCommit, received: preparation.headCommit,
      });
    }
    if (preparation.remotePushUrl !== approved.remotePushUrl) {
      throw replan('remote-destination-moved', 'Prepared Git push destination differs from the approved workflow', {
        expected: approved.remotePushUrl, received: preparation.remotePushUrl,
      });
    }
    const liveRemoteHead = preparation.expectedRemoteBranchCommit;
    if (liveRemoteHead !== approved.expectedRemoteBranchCommit && liveRemoteHead !== preparation.headCommit) {
      throw replan('remote-branch-moved', 'Publication branch changed after workflow approval', {
        expected: approved.expectedRemoteBranchCommit, received: liveRemoteHead,
      });
    }
    const boundPreparation = {
      ...preparation,
      id: approved.changeId,
      title: approved.title,
      expectedRemoteBranchCommit: approved.expectedRemoteBranchCommit,
    };
    const publicationPlan = buildPublicationPlan({
      changeSetId: approved.changeSetId,
      preparations: [boundPreparation],
    });
    const derivedApproval = {
      version: 1,
      planId: publicationPlan.id,
      approval: 'derived-from-approved-workflow',
      parentPlanId: plan.id,
    };
    const publication = await (runtime.applyPublicationPlan ?? applyPublicationPlan)(
      publicationPlan,
      derivedApproval,
      { ...runtime, approvedParentPlanId: plan.id },
    );
    return { preparation: boundPreparation, publication };
  }
  return (runtime.prepareChangeSandbox ?? prepareChangeSandbox)({ ...plan.request, ...callbacks });
}

function verifyPreparationPlan(plan, approval) {
  if (!plan || !KINDS.has(plan.kind) || plan.version !== 1 || typeof plan.id !== 'string') {
    throw new TypeError('Preparation plan is invalid');
  }
  const { id, ...payload } = plan;
  if (hashValue(payload) !== id) throw Object.assign(new Error('Preparation plan was altered'), { code: 'altered-plan' });
  if (!approval || approval.version !== 1 || approval.approval !== 'explicit' || approval.planId !== id) {
    throw Object.assign(new Error('Exact explicit approval is required'), { code: 'unapproved-plan' });
  }
  validateChanges(plan.changes);
  validateCommands(plan.validationCommands);
  if (plan.kind === 'publish-git-change') validatePublication(plan.publication);
}

function validatePublication(input) {
  const publication = input.publication ?? input;
  const required = ['changeSetId', 'changeId', 'remotePushUrl'];
  for (const field of required) {
    if (typeof publication[field] !== 'string' || !publication[field]) throw new TypeError(`${field} is required for approved publication`);
  }
  if (publication.expectedRemoteBranchCommit !== null && !isExactCommit(publication.expectedRemoteBranchCommit)) {
    throw new TypeError('expectedRemoteBranchCommit must be null or an exact commit');
  }
  if (publication.title !== undefined && (typeof publication.title !== 'string' || !publication.title)) {
    throw new TypeError('Publication title must be a non-empty string');
  }
  if (!isExactCommit(publication.headCommit)) throw new TypeError('Publication must bind the exact prepared headCommit');
  return {
    changeSetId: publication.changeSetId,
    changeId: publication.changeId,
    remotePushUrl: publication.remotePushUrl,
    expectedRemoteBranchCommit: publication.expectedRemoteBranchCommit,
    headCommit: publication.headCommit.toLowerCase(),
    ...(publication.title ? { title: publication.title } : {}),
  };
}

async function previewGitChange(options) {
  const root = await mkdtemp(path.join(tmpdir(), 'caddie-publication-preview-'));
  const repository = path.join(root, 'repository');
  try {
    await execFileAsync('git', ['clone', '--mirror', '--no-hardlinks', path.resolve(options.repository), repository], { encoding: 'utf8' });
    await execFileAsync('git', ['-C', repository, 'update-ref', 'refs/heads/caddie-preview-base', options.expectedBaseCommit], { encoding: 'utf8' });
    return await prepareGitChange({
      ...options,
      repository,
      baseRef: 'caddie-preview-base',
      workspaceRoot: path.join(root, 'worktrees'),
      cleanupFailedWorktree: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function exactTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('commitTimestamp must be an exact date-time');
  return parsed.toISOString();
}

async function applyChanges(root, changes) {
  for (const change of changes) {
    const destination = path.join(root, change.path);
    await assertNoSymlinkParent(root, path.dirname(destination));
    const existing = await lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new TypeError('Change path is a final-component symlink');
    if (change.delete === true) await rm(destination, { recursive: true, force: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await assertNoSymlinkParent(root, path.dirname(destination));
      const temporary = path.join(path.dirname(destination), `.caddie-write-${randomUUID()}`);
      try {
        await writeFile(temporary, change.content, { flag: 'wx', ...(change.mode ? { mode: change.mode } : {}) });
        // Rename replaces a final component instead of following it, so even a
        // last-moment final-component symlink cannot redirect written bytes.
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
}

async function runValidation(cwd, commands) {
  for (const [command, ...args] of commands) {
    await execFileAsync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  }
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new TypeError('Preparation requires exact changes');
  return changes.map((change) => {
    if (!change || typeof change.path !== 'string' || path.isAbsolute(change.path)) throw new TypeError('Change path must be relative');
    const normalized = path.posix.normalize(change.path.replaceAll('\\', '/'));
    if (!normalized || normalized === '..' || normalized.startsWith('../')) throw new TypeError('Change path escapes the preparation');
    if (change.delete === true) return { path: normalized, delete: true };
    if (typeof change.content !== 'string') throw new TypeError('Written changes require exact string content');
    return { path: normalized, content: change.content, ...(change.mode ? { mode: change.mode } : {}) };
  });
}

function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) throw new TypeError('Parent validation commands are required');
  for (const command of commands) {
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || part.includes('\0'))) {
      throw new TypeError('Each validation command must be a non-empty argv array');
    }
  }
  return commands.map((command) => [...command]);
}

function pick(input, keys) {
  const result = {};
  for (const key of keys) if (input[key] !== undefined) result[key] = input[key];
  return result;
}

function isExactCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

async function assertNoSymlinkParent(root, parent) {
  const relative = path.relative(root, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('Change path escapes preparation root');
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Change path has a symlink or non-directory parent');
  }
}
