import { execFile } from 'node:child_process';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { prepareChangeSandbox, prepareGitChange } from '../changeset/index.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { hashValue } = require('../plans');

const KINDS = new Set(['prepare-git-change', 'prepare-change-sandbox']);

export function createPreparationWorkflowPlan(input) {
  const kind = input.workflow;
  if (!KINDS.has(kind)) throw new TypeError(`Unsupported preparation workflow: ${kind}`);
  const changes = validateChanges(input.changes);
  const validationCommands = validateCommands(input.validationCommands);
  const request = kind === 'prepare-git-change'
    ? pick(input, ['repository', 'slug', 'baseRef', 'expectedBaseCommit', 'workspaceRoot', 'message', 'authorName', 'authorEmail'])
    : pick(input, ['source', 'slug', 'workspaceRoot']);
  const payload = { version: 1, kind, request, changes, validationCommands };
  return Object.freeze({ ...payload, id: hashValue(payload) });
}

export async function applyPreparationWorkflow(plan, approval) {
  verifyPreparationPlan(plan, approval);
  const callbacks = {
    author: ({ directory }) => applyChanges(directory, plan.changes),
    validate: ({ directory }) => runValidation(directory, plan.validationCommands),
  };
  if (plan.kind === 'prepare-git-change') {
    return prepareGitChange({ ...plan.request, ...callbacks });
  }
  return prepareChangeSandbox({ ...plan.request, ...callbacks });
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
}

async function applyChanges(root, changes) {
  for (const change of changes) {
    const destination = path.join(root, change.path);
    await assertNoSymlinkParent(root, path.dirname(destination));
    if (change.delete === true) await rm(destination, { recursive: true, force: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, change.content, change.mode ? { mode: change.mode } : undefined);
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

