import { rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { GitClient } from './git-client.mjs';
import { inspectSelectedDirectory } from './inspect.mjs';

export async function inspectLocalSource(options) {
  const { root, selectionPath, ...limits } = options;
  return inspectSelectedDirectory({
    root,
    selectionPath,
    source: { type: 'local' },
    ...limits,
  });
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
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  const resolution = await gitClient.resolve({ url, ref, cacheDir });
  return inspectResolvedGitSource({ sourceId, url, selectionPath, resolution, gitClient, limits });
}

export async function inspectLockedGitSource({
  sourceId,
  url,
  commit,
  selectionPath,
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  const resolution = await gitClient.resolveExact({ url, commit, cacheDir });
  return inspectResolvedGitSource({ sourceId, url, selectionPath, resolution, gitClient, limits });
}

export async function materializeLockedGitSource({
  sourceId,
  url,
  commit,
  selectionPath,
  cacheDir,
  gitClient = new GitClient(),
  ...limits
}) {
  const resolution = await gitClient.resolveExact({ url, commit, cacheDir });
  return inspectResolvedGitSource({
    sourceId, url, selectionPath, resolution, gitClient, limits, retainCheckout: true,
  });
}

async function inspectResolvedGitSource({
  sourceId, url, selectionPath, resolution, gitClient, limits, retainCheckout = false,
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
    evidence = await inspectSelectedDirectory({
      root: checkoutRoot,
      selectionPath,
      source: { type: 'git', sourceId, url, commit: resolution.commit },
      ...limits,
    });
    if (retainCheckout) {
      sourceCleanup = { root: path.resolve(checkoutRoot), token: randomUUID() };
      await writeFile(
        path.join(checkoutRoot, '.caddie-materialization.json'),
        `${JSON.stringify({ version: 1, token: sourceCleanup.token, sourcePath: path.resolve(checkoutRoot, selectionPath) })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
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
    },
    findings: [...resolution.findings, ...evidence.coverage.findings],
    ...(retainCheckout ? {
      sourcePath: path.resolve(checkoutRoot, selectionPath),
      checkoutRoot,
      sourceCleanup,
    } : {}),
  };
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
