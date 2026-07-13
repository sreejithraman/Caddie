import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function cacheKey(url) {
  return createHash('sha256').update(url).digest('hex');
}

function parseDefaultRef(output) {
  const match = output.match(/^ref:\s+(refs\/[^\s]+)\s+HEAD$/m);
  return match?.[1] ?? null;
}

export function validateGitUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.startsWith('-') || /[\0\r\n]/.test(url) || url.includes('::')) {
    throw new TypeError('url is not a safe Git source location');
  }
}

export function validateGitRef(ref) {
  if (ref == null) return;
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    || ref.includes('..') || ref.includes('//') || ref.includes('@{')) {
    throw new TypeError('ref is not a safe Git revision name');
  }
}

export class GitClient {
  async run(args, options = {}) {
    return exec('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
  }

  async resolve({ url, ref = null, cacheDir, cachedUrl = null }) {
    validateGitUrl(url);
    validateGitRef(ref);
    if (cachedUrl != null) validateGitUrl(cachedUrl);
    const repositoryDir = path.join(cacheDir, 'git', cacheKey(cachedUrl ?? url));
    await mkdir(path.dirname(repositoryDir), { recursive: true });
    const hasCache = await exists(repositoryDir);
    let freshness = 'fresh';
    let remoteDefaultRef = null;

    try {
      const remote = await this.run(['ls-remote', '--symref', url, 'HEAD']);
      remoteDefaultRef = parseDefaultRef(remote.stdout);
      if (!hasCache) {
        await this.run(['clone', '--mirror', url, repositoryDir]);
      } else {
        const fetchArgs = ['--git-dir', repositoryDir, 'fetch', '--prune', url,
          '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];
        if (ref) fetchArgs.push(ref);
        await this.run(fetchArgs);
      }
    } catch (error) {
      if (!hasCache) {
        return {
          commit: null,
          requestedRef: ref,
          resolvedRef: null,
          freshness: 'unavailable',
          coverage: { complete: false, reason: 'remote-unavailable' },
          findings: [{ code: 'remote-unavailable', retryable: true }],
        };
      }
      freshness = 'stale';
    }

    let resolvedRef = ref ?? remoteDefaultRef;
    if (!resolvedRef) {
      try {
        resolvedRef = (await this.run(['--git-dir', repositoryDir, 'symbolic-ref', 'HEAD'])).stdout.trim();
      } catch {
        resolvedRef = 'HEAD';
      }
    }

    let commit;
    try {
      commit = (await this.run(['--git-dir', repositoryDir, 'rev-parse', '--verify', `${resolvedRef}^{commit}`])).stdout.trim();
    } catch (error) {
      error.code = 'GIT_REF_NOT_FOUND';
      throw error;
    }

    const result = {
      commit,
      requestedRef: ref,
      resolvedRef,
      freshness,
      coverage: freshness === 'fresh'
        ? { complete: true, reason: null }
        : { complete: false, reason: 'remote-unavailable' },
      findings: freshness === 'fresh' ? [] : [{ code: 'remote-unavailable', retryable: true }],
    };
    Object.defineProperty(result, 'repositoryDir', { value: repositoryDir, enumerable: false });
    return result;
  }

  async resolveExact({ url, commit, cacheDir }) {
    validateGitUrl(url);
    if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new TypeError('commit must be an exact object ID');
    }
    const expectedCommit = commit.toLowerCase();
    const repositoryDir = path.join(cacheDir, 'git', cacheKey(url));
    await mkdir(path.dirname(repositoryDir), { recursive: true });
    const hasCache = await exists(repositoryDir);
    let freshness = 'fresh';
    try {
      if (!hasCache) {
        await this.run(['clone', '--mirror', url, repositoryDir]);
      } else {
        await this.run(['--git-dir', repositoryDir, 'fetch', '--prune', url,
          '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
      }
    } catch {
      if (!hasCache) {
        return unavailableExact(expectedCommit, 'unavailable');
      }
      freshness = 'stale';
    }

    try {
      const resolved = (await this.run([
        '--git-dir', repositoryDir, 'rev-parse', '--verify', `${expectedCommit}^{commit}`,
      ])).stdout.trim().toLowerCase();
      if (resolved !== expectedCommit) return unavailableExact(expectedCommit, freshness);
    } catch {
      return unavailableExact(expectedCommit, freshness);
    }

    const result = {
      commit: expectedCommit,
      requestedRef: expectedCommit,
      resolvedRef: expectedCommit,
      freshness,
      coverage: freshness === 'fresh'
        ? { complete: true, reason: null }
        : { complete: false, reason: 'remote-unavailable' },
      findings: freshness === 'fresh' ? [] : [{ code: 'remote-unavailable', retryable: true }],
    };
    Object.defineProperty(result, 'repositoryDir', { value: repositoryDir, enumerable: false });
    return result;
  }

  async checkoutSelection({ repositoryDir, commit, selectionPath }) {
    const checkoutRoot = await mkdtemp(path.join(tmpdir(), 'caddie-source-'));
    try {
      await this.run(['clone', '--shared', '--no-checkout', repositoryDir, checkoutRoot]);
      await this.run(['-C', checkoutRoot, 'checkout', commit, '--', selectionPath]);
      return checkoutRoot;
    } catch (error) {
      await rm(checkoutRoot, { recursive: true, force: true });
      throw error;
    }
  }
}

function unavailableExact(commit, freshness) {
  return {
    commit: null,
    requestedRef: commit,
    resolvedRef: commit,
    freshness,
    coverage: { complete: false, reason: 'exact-commit-unavailable' },
    findings: [{ code: 'exact-commit-unavailable', commit, retryable: freshness !== 'stale' }],
  };
}
