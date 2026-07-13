import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintDirectory } from '../fingerprint/index.mjs';
import { invalid, replan } from './errors.mjs';

export async function prepareChangeSandbox(options) {
  const source = path.resolve(required(options.source, 'source'));
  if (typeof options.author !== 'function') throw invalid('author-required', 'A focused author function is required');
  if (typeof options.validate !== 'function') throw invalid('validation-required', 'A parent-owned validation function is required');
  const root = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : await mkdtemp(path.join(tmpdir(), 'caddie-sandboxes-'));
  await mkdir(root, { recursive: true });
  const directory = path.join(root, required(options.slug, 'slug'));
  const before = await completeFingerprint(source);
  const beforeFiles = await inventory(source);
  await cp(source, directory, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  await options.author({ directory, source });
  await options.validate({ directory, source });
  const after = await completeFingerprint(directory);
  const afterFiles = await inventory(directory);
  const operations = diffInventories(beforeFiles, afterFiles);
  if (!operations.length) throw invalid('empty-change', 'Authoring produced no focused change', { source });
  const unsigned = {
    version: 1,
    source,
    stageRoot: directory,
    precondition: { fingerprint: before },
    result: { fingerprint: after },
    operations,
  };
  const applyPlan = { ...unsigned, id: hashJson(unsigned) };
  return {
    kind: 'sandbox', source, directory,
    sourceFingerprint: before,
    resultFingerprint: after,
    applyPlan,
  };
}

export async function applyChangeSandbox(plan, options = {}) {
  validatePlan(plan);
  if (options.approval !== plan.id) throw invalid('approval-mismatch', 'Approval must bind to the exact Change Sandbox plan');
  const { id, ...unsigned } = plan;
  if (hashJson(unsigned) !== id) throw invalid('plan-tampered', 'Change Sandbox plan content changed after approval');

  const current = await completeFingerprint(plan.source);
  if (current.digest !== plan.precondition.fingerprint.digest) {
    throw replan('sandbox-destination-stale', 'Change Sandbox destination changed after preparation', {
      expected: plan.precondition.fingerprint.digest, received: current.digest,
    });
  }
  const staged = await completeFingerprint(plan.stageRoot);
  if (staged.digest !== plan.result.fingerprint.digest) {
    throw replan('sandbox-stage-tampered', 'Staged Change Sandbox content changed after approval', {
      expected: plan.result.fingerprint.digest, received: staged.digest,
    });
  }

  const parent = path.dirname(plan.source);
  const transaction = await mkdtemp(path.join(parent, '.caddie-apply-'));
  const prepared = path.join(transaction, 'prepared');
  const backup = path.join(transaction, 'backup');
  let sourceMoved = false;
  let resultPublished = false;
  try {
    await cp(plan.stageRoot, prepared, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    const copied = await completeFingerprint(prepared);
    if (copied.digest !== plan.result.fingerprint.digest) throw replan('sandbox-copy-mismatch', 'Staged bytes changed while preparing application');
    await rename(plan.source, backup);
    sourceMoved = true;
    await boundary(options.onBoundary, 'source-moved');
    await rename(prepared, plan.source);
    resultPublished = true;
    await boundary(options.onBoundary, 'result-published');
    const installed = await completeFingerprint(plan.source);
    if (installed.digest !== plan.result.fingerprint.digest) throw replan('sandbox-result-mismatch', 'Published Change Sandbox content failed verification');
    await rm(backup, { recursive: true, force: true });
    sourceMoved = false;
    await rm(transaction, { recursive: true, force: true });
    return { applied: true, planId: plan.id, fingerprint: installed };
  } catch (error) {
    if (resultPublished) await rm(plan.source, { recursive: true, force: true });
    if (sourceMoved) await rename(backup, plan.source);
    await rm(transaction, { recursive: true, force: true });
    throw error;
  }
}

async function completeFingerprint(root) {
  const fingerprint = await fingerprintDirectory(root);
  if (!fingerprint.complete) throw invalid('fingerprint-incomplete', `Cannot fingerprint Change Sandbox path: ${root}`, fingerprint.findings);
  return fingerprint;
}

async function inventory(root) {
  const files = new Map();
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isSymbolicLink()) {
        const stat = await lstat(absolute);
        files.set(relative, { kind: 'symlink', stagedPath: relative, target: await readlink(absolute), mode: stat.mode & 0o777 });
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        const stat = await lstat(absolute);
        files.set(relative, {
          kind: 'file', stagedPath: relative,
          sha256: createHash('sha256').update(content).digest('hex'),
          byteLength: content.byteLength,
          mode: stat.mode & 0o777,
        });
      }
    }
  }
  await visit(root);
  return files;
}

function diffInventories(before, after) {
  const operations = [];
  for (const [file, state] of after) {
    if (JSON.stringify(before.get(file)) !== JSON.stringify(state)) operations.push({ type: 'write', path: file, ...state });
  }
  for (const file of before.keys()) if (!after.has(file)) operations.push({ type: 'delete', path: file });
  return operations.sort((a, b) => a.path.localeCompare(b.path));
}

function validatePlan(plan) {
  if (!plan || plan.version !== 1 || typeof plan.id !== 'string' || typeof plan.source !== 'string' || typeof plan.stageRoot !== 'string') {
    throw invalid('invalid-sandbox-plan', 'Malformed Change Sandbox apply plan');
  }
  if (!plan.precondition?.fingerprint?.digest || !plan.result?.fingerprint?.digest || !Array.isArray(plan.operations)) {
    throw invalid('invalid-sandbox-plan', 'Change Sandbox plan is missing content fingerprints or operations');
  }
  for (const operation of plan.operations) {
    if (!['write', 'delete'].includes(operation.type) || typeof operation.path !== 'string' || path.isAbsolute(operation.path) || operation.path.split('/').includes('..')) {
      throw invalid('invalid-sandbox-operation', 'Change Sandbox operation escapes its destination');
    }
  }
}

function hashJson(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function boundary(callback, name) {
  if (callback) await callback(name);
}

function required(value, name) {
  if (typeof value !== 'string' || !value) throw invalid(`${name}-required`, `${name} is required`);
  return value;
}
