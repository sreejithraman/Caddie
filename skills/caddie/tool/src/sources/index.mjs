import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitClient } from './git-client.mjs';
import { inspectSelectedDirectory } from './inspect.mjs';
import { inspectInvocation, projectInvocation, validateInvocationPolicy } from '../invocation/project.mjs';
import { assertContainedSymlinks, resolveSelectionWithinSource } from './selection-path.mjs';

export async function inspectLocalSource(options) {
  const { root, selectionPath, invocation, materialize = false, ...limits } = options;
  validateInvocationPolicy(invocation);
  const selected = await resolveSelectionWithinSource(root, selectionPath);
  await assertContainedSymlinks(selected.selectedPath);
  const sourceInvocation = await inspectInvocation(selected.selectedPath);
  if (!invocation && !materialize) {
    const evidence = await inspectSelectedDirectory({ root, selectionPath, source: { type: 'local' }, ...limits });
    return withInvocationEvidence(evidence, null, sourceInvocation, sourceInvocation);
  }

  const checkoutRoot = await mkdtemp(path.join(tmpdir(), 'caddie-source-'));
  const sourcePath = path.join(checkoutRoot, path.basename(selected.selectedPath));
  let retained = false;
  try {
    await cp(selected.selectedPath, sourcePath, { recursive: true, errorOnExist: true, force: false });
    const effectiveInvocation = invocation
      ? await projectInvocation(sourcePath, invocation)
      : sourceInvocation;
    const evidence = await inspectSelectedDirectory({
      root: checkoutRoot,
      selectionPath: path.basename(sourcePath),
      source: { type: 'local' },
      ...limits,
    });
    evidence.source.selectionPath = selected.relativePath;
    const result = withInvocationEvidence(evidence, invocation ?? null, sourceInvocation, effectiveInvocation);
    if (!materialize) return result;
    const sourceCleanup = await leaseSource(checkoutRoot, sourcePath);
    retained = true;
    return { ...result, sourcePath, checkoutRoot, sourceCleanup };
  } finally {
    if (!retained) await rm(checkoutRoot, { recursive: true, force: true });
  }
}

export async function resolveGitSource({ gitClient = new GitClient(), ...options }) {
  return gitClient.resolve(options);
}

export async function resolveExactGitSource({ gitClient = new GitClient(), ...options }) {
  return gitClient.resolveExact(options);
}

export async function inspectGitSource({
  sourceId,
  url,
  ref = null,
  selectionPath,
  invocation,
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  validateInvocationPolicy(invocation);
  const resolution = await gitClient.resolve({ url, ref, cacheDir });
  return inspectResolvedGitSource({ sourceId, url, selectionPath, invocation, resolution, gitClient, limits });
}

export async function inspectLockedGitSource({
  sourceId,
  url,
  commit,
  selectionPath,
  invocation,
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  validateInvocationPolicy(invocation);
  const resolution = await gitClient.resolveExact({ url, commit, cacheDir });
  return inspectResolvedGitSource({ sourceId, url, selectionPath, invocation, resolution, gitClient, limits });
}

export async function materializeLockedGitSource({
  sourceId,
  url,
  commit,
  selectionPath,
  invocation,
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  validateInvocationPolicy(invocation);
  const resolution = await gitClient.resolveExact({ url, commit, cacheDir });
  return inspectResolvedGitSource({
    sourceId, url, selectionPath, invocation, resolution, gitClient, limits, retainCheckout: true,
  });
}

async function inspectResolvedGitSource({
  sourceId, url, selectionPath, invocation, resolution, gitClient, limits, retainCheckout = false,
}) {
  if (!resolution.commit) {
    return {
      resolution,
      evidence: null,
      coverage: resolution.coverage,
      findings: resolution.findings,
    };
  }
  const checkoutRoot = await gitClient.checkoutSelection({
    repositoryDir: resolution.repositoryDir,
    commit: resolution.commit,
    selectionPath,
  });
  let evidence;
  let sourceCleanup;
  let retained = false;
  try {
    const sourcePath = path.resolve(checkoutRoot, selectionPath);
    const sourceInvocation = await inspectInvocation(sourcePath);
    const effectiveInvocation = invocation
      ? await projectInvocation(sourcePath, invocation)
      : sourceInvocation;
    evidence = await inspectSelectedDirectory({
      root: checkoutRoot,
      selectionPath,
      source: { type: 'git', sourceId, url, commit: resolution.commit },
      ...limits,
    });
    evidence = withInvocationEvidence(evidence, invocation ?? null, sourceInvocation, effectiveInvocation);
    if (retainCheckout) {
      sourceCleanup = await leaseSource(checkoutRoot, sourcePath);
      retained = true;
    }
  } finally {
    if (!retained) await rm(checkoutRoot, { recursive: true, force: true });
  }
  return {
    resolution,
    evidence,
    coverage: {
      complete: resolution.coverage.complete && evidence.coverage.complete,
      reason: !resolution.coverage.complete ? resolution.coverage.reason : evidence.coverage.reason,
      ...(Number.isInteger(evidence.coverage.omittedEntries) ? { omittedEntries: evidence.coverage.omittedEntries } : {}),
      ...(typeof evidence.coverage.cacheReference === 'string' ? { cacheReference: evidence.coverage.cacheReference } : {}),
      ...(typeof evidence.coverage.continuationCursor === 'string' ? { continuationCursor: evidence.coverage.continuationCursor } : {}),
    },
    findings: [...resolution.findings, ...evidence.coverage.findings],
    ...(retainCheckout ? {
      sourcePath: path.resolve(checkoutRoot, selectionPath),
      checkoutRoot,
      sourceCleanup,
    } : {}),
  };
}

function withInvocationEvidence(evidence, policy, source, effective) {
  const invocationFindings = distinctFindings([
    ...(source.findings ?? []),
    ...(effective === source ? [] : effective.findings ?? []),
  ]);
  if (invocationFindings.length === 0) return { ...evidence, invocation: { policy, source, effective } };
  return {
    ...evidence,
    invocation: { policy, source, effective },
    coverage: {
      ...evidence.coverage,
      complete: false,
      reason: evidence.coverage.reason ?? 'invocation-evidence-partial',
      findings: distinctFindings([...evidence.coverage.findings, ...invocationFindings]),
    },
  };
}

function distinctFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const identity = `${finding.code ?? ''}\0${finding.path ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function leaseSource(checkoutRoot, sourcePath) {
  const sourceCleanup = { root: path.resolve(checkoutRoot), token: randomUUID() };
  await writeFile(
    path.join(checkoutRoot, '.caddie-materialization.json'),
    `${JSON.stringify({ version: 1, token: sourceCleanup.token, sourcePath: path.resolve(sourcePath) })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return sourceCleanup;
}

export function createGitLockEntry({ sourceId, url, ref = null, commit }) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('sourceId is required');
  if (typeof url !== 'string' || url.length === 0) throw new TypeError('url is required');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit)) throw new TypeError('commit must be an exact object ID');
  return {
    sourceId,
    type: 'git',
    url,
    ...(ref ? { ref } : {}),
    commit: commit.toLowerCase(),
  };
}

export { GitClient } from './git-client.mjs';
export { inspectSelectedDirectory } from './inspect.mjs';
export { assertContainedSymlinks, resolveSelectionWithinSource, SelectionOutsideSourceError } from './selection-path.mjs';
